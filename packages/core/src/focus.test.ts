import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { closeDb, getDb } from './db/client.js';
import { users } from './schema.js';
import { createTask, getTask, updateTask } from './tasks.js';
import {
  answerPrompt,
  createPrompt,
  DeckRequiredError,
  listPromptsForTask,
  markPromptNotRelevant,
  markPromptOpened,
  NOT_RELEVANT_COMMENT,
  QuestRequiredError,
  sendBackPrompt,
  undoPromptResolution,
} from './prompts.js';
import {
  creditSeconds,
  deleteLatestFocusEvent,
  getFocusDaySummary,
  getFocusTimeRows,
  listFocusEvents,
  listShippedFeed,
  logFocusEvent,
  reportShipped,
  undoDoEnd,
} from './focus.js';
import { buildFocusStack } from './focus-stack.js';
import { createComment, listCommentsForTask } from './comments.js';
import { shareTaskWithUserId } from './shares.js';
import {
  DEFAULT_FOCUS_SETTINGS,
  getFocusSettings,
  setAgentRules,
  setFocusSettings,
} from './settings.js';
import type { Context } from './context.js';
import { resetStorageCache } from './storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let ctx: Context; // human owner
let botCtx: Context; // agent asker

// Minimal valid Focus packaging for an agent ask.
const packaged = {
  deck: [{ kind: 'text' as const, body: 'evidence for the decision' }],
  recommendation: 'Approve — matches the brief.',
  estSeconds: 30,
};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-focus-'));
  process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
  process.env['HOME'] = tmpDir;
  // Pin storage to a throwaway local dir. Without this the adapter auto-detects
  // whatever S3 credentials happen to be in the shell (a dev machine with the
  // real GETSHIT_S3_* exported has them) and the suite writes its fixtures
  // straight into the production attachment bucket.
  process.env['GETSHIT_STORAGE'] = 'local';
  process.env['GETSHIT_FILES_DIR'] = path.join(tmpDir, 'files');
  resetStorageCache();

  const db = getDb();
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../drizzle') });

  ctx = { userId: nanoid(12) };
  botCtx = { userId: nanoid(12) };
  const ts = Date.now();
  await db.insert(users).values([
    { id: ctx.userId, email: null, name: 'human', googleId: null, image: null, createdAt: ts },
    { id: botCtx.userId, email: null, name: 'bot', kind: 'agent', googleId: null, image: null, createdAt: ts },
  ]);
});

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function botTask(title: string) {
  const t = await createTask(ctx, { title });
  await updateTask(ctx, t.id, { assigneeId: botCtx.userId });
  return t;
}

describe('ask_human requires Focus packaging from agents', () => {
  it('rejects a bare agent ask with a self-teaching error', async () => {
    const t = await botTask('bare-ask');
    await assert.rejects(
      () => createPrompt(botCtx, { taskId: t.id, kind: 'approval', prompt: 'ok?' }),
      DeckRequiredError,
    );
    // Nothing was written by the rejected ask.
    const prompts = await listPromptsForTask(ctx, t.id);
    assert.equal(prompts.length, 0);
    const afterTask = await getTask(ctx, t.id);
    assert.equal(afterTask?.status, 'open', 'no review bump on a rejected ask');
  });

  it('rejects estSeconds over 120 with the quest instruction', async () => {
    const t = await botTask('oversized-ask');
    await assert.rejects(
      () =>
        createPrompt(botCtx, {
          taskId: t.id,
          kind: 'approval',
          prompt: 'big one?',
          ...packaged,
          estSeconds: 300,
        }),
      QuestRequiredError,
    );
  });

  it('accepts a fully packaged agent ask and round-trips the deck', async () => {
    const t = await botTask('packaged-ask');
    const p = await createPrompt(botCtx, {
      taskId: t.id,
      kind: 'approval',
      prompt: 'ship it?',
      deck: [
        { kind: 'text', body: 'the **draft** is below' },
        { kind: 'image', url: 'https://example.com/shot.png', caption: 'final frame' },
        { kind: 'chart', spec: { type: 'bar', series: [{ label: 'Mon', value: 3 }] } },
      ],
      recommendation: 'Approve — matches the brief.',
      estSeconds: 45,
    });
    const [stored] = await listPromptsForTask(ctx, t.id);
    assert.equal(stored!.id, p.id);
    assert.equal(stored!.deck?.length, 3);
    assert.equal(stored!.deck?.[0]?.kind, 'text');
    assert.equal(stored!.recommendation, 'Approve — matches the brief.');
    assert.equal(stored!.estSeconds, 45);
    const afterTask = await getTask(ctx, t.id);
    assert.equal(afterTask?.status, 'review', 'packaged ask still bumps to review');
  });

  it('rejects an image block with neither attachmentId nor url', async () => {
    const t = await botTask('bad-deck-block');
    await assert.rejects(() =>
      createPrompt(botCtx, {
        taskId: t.id,
        kind: 'approval',
        prompt: 'ok?',
        ...packaged,
        deck: [{ kind: 'image' }],
      }),
    );
  });

  it('humans stay exempt — a bare web-UI prompt is fine', async () => {
    const t = await createTask(ctx, { title: 'human-bare-ask' });
    const p = await createPrompt(ctx, { taskId: t.id, kind: 'text', prompt: 'thoughts?' });
    assert.equal(p.deck, null);
    assert.equal(p.estSeconds, null);
  });

  it('turning the rule off lets bare agent asks through again', async () => {
    const t = await botTask('rule-off-ask');
    await setAgentRules({ prompt_requires_deck: false });
    try {
      const p = await createPrompt(botCtx, { taskId: t.id, kind: 'text', prompt: 'loose?' });
      assert.equal(p.status, 'pending');
    } finally {
      await setAgentRules({ prompt_requires_deck: true });
    }
  });
});

describe('goal links', () => {
  it('ask_human goalTaskId links the task to the goal', async () => {
    const goal = await createTask(ctx, { title: 'Launch Guide 2.0', kind: 'goal' });
    // The asker must be able to see the goal it links to — grant via assignment.
    await updateTask(ctx, goal.id, { assigneeId: botCtx.userId });
    const t = await botTask('goal-linked-ask');
    await createPrompt(botCtx, {
      taskId: t.id,
      kind: 'approval',
      prompt: 'ok?',
      ...packaged,
      goalTaskId: goal.id,
    });
    const after = await getTask(ctx, t.id);
    assert.equal(after?.goalId, goal.id);
  });

  it('rejects a goalTaskId that is not kind=goal', async () => {
    const notGoal = await createTask(ctx, { title: 'just-a-task' });
    await updateTask(ctx, notGoal.id, { assigneeId: botCtx.userId });
    const t = await botTask('bad-goal-ask');
    await assert.rejects(
      () =>
        createPrompt(botCtx, {
          taskId: t.id,
          kind: 'approval',
          prompt: 'ok?',
          ...packaged,
          goalTaskId: notGoal.id,
        }),
      /kind="goal"/,
    );
  });

  it('update_task validates goalId and milestone parentage', async () => {
    const goal = await createTask(ctx, { title: 'Q3 goal', kind: 'goal' });
    const node = await createTask(ctx, { title: 'milestone-1', parentId: goal.id });
    const stray = await createTask(ctx, { title: 'stray' });
    const t = await createTask(ctx, { title: 'cross-tree-work' });

    const linked = await updateTask(ctx, t.id, { goalId: goal.id, milestoneId: node.id });
    assert.equal(linked.goalId, goal.id);
    assert.equal(linked.milestoneId, node.id);

    await assert.rejects(
      () => updateTask(ctx, t.id, { milestoneId: stray.id }),
      /DIRECT child/,
    );

    // Clearing the goal drops the (now dangling) milestone too.
    const cleared = await updateTask(ctx, t.id, { goalId: null });
    assert.equal(cleared.goalId, null);
    assert.equal(cleared.milestoneId, null);
  });
});

describe('answer endpoint + focus events', () => {
  it('markPromptOpened stamps once and logs an opened event', async () => {
    const t = await botTask('opened-once');
    const p = await createPrompt(botCtx, { taskId: t.id, kind: 'approval', prompt: 'ok?', ...packaged });

    const first = await markPromptOpened(ctx, p.id);
    assert.ok(first.openedAt !== null);
    const again = await markPromptOpened(ctx, p.id);
    assert.equal(again.openedAt, first.openedAt, 'idempotent');

    const events = await listFocusEvents(ctx, { types: ['opened'] });
    assert.equal(events.filter((e) => e.promptId === p.id).length, 1);
  });

  it('answerPrompt stamps answerKind and logs seconds + est meta', async () => {
    const t = await botTask('answered-card');
    const p = await createPrompt(botCtx, { taskId: t.id, kind: 'approval', prompt: 'ok?', ...packaged });
    await markPromptOpened(ctx, p.id);
    const answered = await answerPrompt(ctx, p.id, { approved: true });
    assert.equal(answered.answerKind, 'answered');

    const events = await listFocusEvents(ctx, { types: ['answered'] });
    const e = events.find((ev) => ev.promptId === p.id);
    assert.ok(e, 'answered event logged');
    assert.ok(typeof e!.seconds === 'number' && e!.seconds >= 0, 'actual seconds recorded');
    assert.deepEqual(JSON.parse(e!.meta!), { estSeconds: 30 });
  });

  it('sendBackPrompt resolves the card, posts the note, returns the task to doing', async () => {
    const t = await botTask('sent-back-card');
    const p = await createPrompt(botCtx, { taskId: t.id, kind: 'approval', prompt: 'ok?', ...packaged });
    assert.equal((await getTask(ctx, t.id))?.status, 'review');

    const sent = await sendBackPrompt(ctx, p.id, 'colors are off — try the navy variant');
    assert.equal(sent.status, 'answered');
    assert.equal(sent.answerKind, 'sent_back');
    assert.equal(sent.answer?.approved, false, 'approval send-back reads as not-approved');
    assert.equal(sent.answer?.comment, 'colors are off — try the navy variant');

    const comments = await listCommentsForTask(ctx, t.id);
    assert.ok(comments.some((c) => c.body.includes('colors are off')));
    assert.equal((await getTask(ctx, t.id))?.status, 'doing');

    const events = await listFocusEvents(ctx, { types: ['sent_back'] });
    assert.ok(events.some((e) => e.promptId === p.id));
  });

  it('markPromptNotRelevant cancels the card, archives the task, tells the agent', async () => {
    const t = await botTask('irrelevant-card');
    const p = await createPrompt(botCtx, { taskId: t.id, kind: 'text', prompt: 'still want this?', ...packaged });

    const closed = await markPromptNotRelevant(ctx, p.id);
    assert.equal(closed.status, 'cancelled');
    assert.equal(closed.answerKind, 'not_relevant');

    assert.equal((await getTask(ctx, t.id))?.status, 'archived');
    const comments = await listCommentsForTask(ctx, t.id);
    assert.ok(comments.some((c) => c.body === NOT_RELEVANT_COMMENT));

    const events = await listFocusEvents(ctx, { types: ['not_relevant'] });
    assert.ok(events.some((e) => e.promptId === p.id));
  });

  it('creditSeconds: every resolution earns ACTUAL time only — estimates never inflate', async () => {
    const soloCtx: Context = { userId: nanoid(12) };
    await logFocusEvent(soloCtx, { type: 'answered', seconds: 10, meta: { estSeconds: 45 } });
    await logFocusEvent(soloCtx, { type: 'answered', seconds: 90, meta: { estSeconds: 45 } });
    await logFocusEvent(soloCtx, { type: 'sent_back', seconds: 20, meta: { estSeconds: 45 } });
    await logFocusEvent(soloCtx, { type: 'do_ended', seconds: 30 });
    await logFocusEvent(soloCtx, { type: 'opened' }); // no credit
    const events = await listFocusEvents(soloCtx);
    assert.equal(creditSeconds(events), 10 + 90 + 20 + 30);
  });

  it('answerPrompt prefers client-measured seconds, bounded by the openedAt window', async () => {
    const t = await botTask('client-seconds-card');
    const p = await createPrompt(botCtx, { taskId: t.id, kind: 'approval', prompt: 'ok?', ...packaged });
    await markPromptOpened(ctx, p.id);
    // Client says 7s of actual card time — wall clock since openedAt is ~0s,
    // so the min() bound keeps whichever is smaller and sane.
    await answerPrompt(ctx, p.id, { approved: true }, { seconds: 7 });
    const events = await listFocusEvents(ctx, { types: ['answered'] });
    const e = events.find((ev) => ev.promptId === p.id)!;
    assert.ok(e.seconds !== null && e.seconds <= 7, `seconds bounded, got ${e.seconds}`);
  });

  it('undoPromptResolution reopens the card and removes the focus event', async () => {
    const t = await botTask('undo-answer-card');
    const p = await createPrompt(botCtx, { taskId: t.id, kind: 'approval', prompt: 'ok?', ...packaged });
    await markPromptOpened(ctx, p.id);
    await answerPrompt(ctx, p.id, { approved: true }, { seconds: 12 });
    assert.equal((await listPromptsForTask(ctx, t.id)).find((x) => x.id === p.id)?.status, 'answered');

    const undone = await undoPromptResolution(ctx, p.id);
    assert.equal(undone.status, 'pending');
    assert.equal(undone.answer, null);
    assert.equal((await listFocusEvents(ctx, { types: ['answered'] })).filter((e) => e.promptId === p.id).length, 0);
  });

  it('undo after send-back restores review and deletes the note comment', async () => {
    const t = await botTask('undo-sendback-card');
    const p = await createPrompt(botCtx, { taskId: t.id, kind: 'approval', prompt: 'ok?', ...packaged });
    await sendBackPrompt(ctx, p.id, 'try again');
    assert.equal((await getTask(ctx, t.id))?.status, 'doing');

    await undoPromptResolution(ctx, p.id);
    assert.equal((await getTask(ctx, t.id))?.status, 'review');
    const comments = await listCommentsForTask(ctx, t.id);
    assert.equal(comments.some((c) => c.body.includes('try again')), false);
  });

  it('undoDoEnd reopens a completed do-card', async () => {
    const t = await createTask(ctx, { title: 'undo-do-card' });
    await updateTask(ctx, t.id, { status: 'done' });
    await logFocusEvent(ctx, { taskId: t.id, type: 'do_ended', seconds: 8 });
    await undoDoEnd(ctx, t.id);
    assert.equal((await getTask(ctx, t.id))?.status, 'open');
    assert.equal((await listFocusEvents(ctx, { taskId: t.id, types: ['do_ended'] })).length, 0);
  });
});

describe('report_shipped + ship feed', () => {
  it('logs under the task owner and surfaces in their feed', async () => {
    const t = await botTask('shipped-task');
    await reportShipped(botCtx, {
      taskId: t.id,
      title: 'Wholesale shop — pages live',
      url: 'https://example.com/shop',
    });
    const feed = await listShippedFeed(ctx);
    const item = feed.find((s) => s.taskId === t.id);
    assert.ok(item, 'ship appears in the OWNER feed even when an agent reported it');
    assert.equal(item!.title, 'Wholesale shop — pages live');
    assert.equal(item!.url, 'https://example.com/shop');
  });

  // ── the same property, read as a blast radius ───────────────────────────────
  //
  // The test above is the FEATURE: `reportShipped` writes `userId: task.userId`
  // so the ship lands in the human's feed no matter who reported it. This test
  // pins the other face of that one line, because it is what makes
  // `report_shipped` UNPROBEABLE on `Tx5g85uLq96D` (kind THIRD-PARTY-ARTIFACT,
  // measured by `npm run report-shipped-blast-radius`):
  //
  //   writer   focus.ts  userId: task.userId   ← the OWNER
  //   readers  focus.ts  eq(focusEvents.userId, ctx.userId)   ← the CALLER
  //
  // A not-shared subject is owned by somebody else by definition, so an
  // unrefused call on one mints a row the caller cannot read, cannot enumerate
  // and cannot delete — while the human sees a claim that something shipped.
  // That is not `delete_task` (artifact gone) and not `update_note` (artifact
  // orphaned): the artifact is intact and it has an audience of exactly the one
  // party who must not see it.
  //
  // ⚠️ This test pins the ASYMMETRY, not the probe. If a future change scopes a
  // focus-event reader to the reporter — or writes `byUserId` as a second
  // owner — this reds, and that is precisely the moment someone should be told
  // the row became probeable again and the UNPROBEABLE entry can be discharged.
  it('the REPORTER cannot read, enumerate or undo what it reported — the blast radius', async () => {
    const t = await botTask('shipped-blast-radius');
    await reportShipped(botCtx, { taskId: t.id, title: 'a ship the reporter cannot see' });

    // readable / enumerable, by every reader the reporter has
    assert.equal(
      (await listFocusEvents(botCtx, { taskId: t.id, types: ['shipped'] })).length,
      0,
      'listFocusEvents keys on ctx.userId, so the reporter sees none of its own ship',
    );
    assert.equal(
      (await listShippedFeed(botCtx)).filter((s) => s.taskId === t.id).length,
      0,
      'listShippedFeed keys on ctx.userId — the reporter has no feed of its own ships',
    );

    // repairable — the undo path is keyed the same way, so there is none
    assert.equal(
      await deleteLatestFocusEvent(botCtx, { taskId: t.id, types: ['shipped'] }),
      false,
      'the reporter cannot undo its own report',
    );

    // …and the row is neither gone nor orphaned: it is in the owner's feed.
    assert.equal(
      (await listShippedFeed(ctx)).filter((s) => s.taskId === t.id).length,
      1,
      'DELIVERED, not lost — this is the leg that separates it from update_note',
    );
    // The owner CAN undo it, which is what "unrepairable BY THIS CALLER" means:
    // the capability exists, it just does not belong to the party that wrote it.
    assert.equal(await deleteLatestFocusEvent(ctx, { taskId: t.id, types: ['shipped'] }), true);
  });
});

describe('focus stack', () => {
  it('builds prompt cards with goal path, quest grouping, and do-cards', async () => {
    const solo: Context = { userId: nanoid(12) };
    const soloBot: Context = { userId: nanoid(12) };
    const db = getDb();
    await db.insert(users).values([
      { id: solo.userId, email: null, name: 'solo', googleId: null, image: null, createdAt: Date.now() },
      { id: soloBot.userId, email: null, name: 'solo-bot', kind: 'agent', googleId: null, image: null, createdAt: Date.now() },
    ]);

    // Venture → goal with three path nodes; first node done.
    const entity = await createTask(solo, { title: 'Acme Co', kind: 'entity' });
    const goal = await createTask(solo, { title: 'Launch shop', kind: 'goal', parentId: entity.id });
    const n1 = await createTask(solo, { title: 'Products', parentId: goal.id });
    const n2 = await createTask(solo, { title: 'Copy', parentId: goal.id });
    await createTask(solo, { title: 'Publish', parentId: goal.id });
    await updateTask(solo, n1.id, { status: 'done' });

    // Work inside the goal subtree (implicit link) with a pending agent ask.
    const work = await createTask(solo, { title: 'Write hero copy', parentId: n2.id });
    await updateTask(solo, work.id, { assigneeId: soloBot.userId });
    await createPrompt(soloBot, { taskId: work.id, kind: 'approval', prompt: 'copy ok?', ...packaged });

    // A quest: master with two asked children.
    const master = await createTask(solo, {
      title: 'Launch campaign',
      description: 'Meta campaign · ₪6k pool',
    });
    const q1 = await createTask(solo, { title: 'Pick visual', parentId: master.id });
    const q2 = await createTask(solo, { title: 'Pick budget', parentId: master.id });
    for (const q of [q1, q2]) {
      await updateTask(solo, q.id, { assigneeId: soloBot.userId });
      await createPrompt(soloBot, { taskId: q.id, kind: 'text', prompt: `${q.title}?`, ...packaged });
    }

    // A due manual task (do-card) the bot asked the human to do. The bot needs a
    // SHARE to comment — every other task in this fixture gets one implicitly by
    // being assigned to the bot, and this one is the exception because it is
    // assigned to the human. Without it `createComment` correctly refuses, and
    // reports the refusal as "not found" (`Tx5g85uLq96D`), which is what sent the
    // first diagnosis of this failure in the wrong direction.
    const doTask = await createTask(solo, {
      title: 'Accept partner request',
      assigneeId: solo.userId,
      dueAt: Date.now(),
    });
    await shareTaskWithUserId(solo, doTask.id, soloBot.userId);
    await createComment(soloBot, { taskId: doTask.id, body: 'please grant access', source: 'agent' });

    const stack = await buildFocusStack(solo);
    assert.equal(stack.cards.length, 4);

    const promptCards = stack.cards.filter((c) => c.kind === 'prompt');
    assert.equal(promptCards.length, 3);

    const heroCard = promptCards.find((c) => c.task.id === work.id)!;
    assert.ok(heroCard.goal, 'implicit goal link resolved via ancestors');
    assert.equal(heroCard.goal!.id, goal.id);
    assert.equal(heroCard.goal!.entity?.title, 'Acme Co', 'venture sits on the goal path');
    assert.deepEqual(
      heroCard.goal!.nodes.map((n) => n.state),
      ['done', 'current', 'locked'],
    );
    assert.equal(heroCard.goal!.activeNodeId, n2.id, 'active node = containing goal child');
    assert.equal(heroCard.askerName, 'solo-bot');

    const questCards = promptCards.filter((c) => c.quest !== null);
    assert.equal(questCards.length, 2);
    assert.equal(questCards[0]!.quest!.masterTitle, 'Launch campaign');
    assert.equal(questCards[0]!.quest!.of, 2);
    assert.equal(questCards[0]!.quest!.context, 'Meta campaign · ₪6k pool');

    const doCards = stack.cards.filter((c) => c.kind === 'do');
    assert.equal(doCards.length, 1);
    assert.equal(doCards[0]!.task.title, 'Accept partner request');
    assert.equal(doCards[0]!.from?.name, 'solo-bot');
    assert.equal(doCards[0]!.from?.isAgent, true);
  });

  /**
   * KNOWN GAP, not a passing guarantee — marked `todo` so the suite stays honest
   * about being red on this rather than silent.
   *
   * The do-card query (`focus-stack.ts`, "my own manual tasks") requires BOTH
   * `assigneeId = me` AND `userId = me`, so a task an agent creates and assigns
   * to the human never reaches Focus. The spec that produced the do-card feature
   * (comment `7RLbcgfy-_qo` on `SkF2g0EOzlL7`) asks for the assignee condition
   * only — "no agent convention can be trusted to always call ask_human; the
   * query must catch bare assignments" — and the production incident behind it
   * was an agent-raised overnight task Joel could not see. The review-card query
   * eighteen lines below keys on `reviewerId` alone, with no ownership term.
   *
   * Dropping `eq(tasks.userId, ctx.userId)` changes what appears in the human's
   * own queue, so it is Joel's call, not a silent fix. Carded separately.
   */
  it('surfaces a due task an AGENT created and assigned to the human', { todo: true }, async () => {
    const u: Context = { userId: nanoid(12) };
    const bot: Context = { userId: nanoid(12) };
    const db = getDb();
    await db.insert(users).values([
      { id: u.userId, email: null, name: 'owner-gap-user', googleId: null, image: null, createdAt: Date.now() },
      { id: bot.userId, email: null, name: 'owner-gap-bot', kind: 'agent', googleId: null, image: null, createdAt: Date.now() },
    ]);
    // Identical in every respect to a do-card that DOES show, except the owner.
    await createTask(bot, { title: 'Set up the mailroom', assigneeId: u.userId, dueAt: Date.now() });

    const stack = await buildFocusStack(u);
    assert.deepEqual(
      stack.cards.map((c) => c.task.title),
      ['Set up the mailroom'],
      'a bare agent-raised assignment must reach Focus',
    );
  });

  it('allMine scope pulls undated assigned tasks in as do-cards', async () => {
    const u: Context = { userId: nanoid(12) };
    const db = getDb();
    await db.insert(users).values({
      id: u.userId, email: null, name: 'scopeuser', googleId: null, image: null, createdAt: Date.now(),
    });
    await createTask(u, { title: 'due today', assigneeId: u.userId, dueAt: Date.now() });
    await createTask(u, { title: 'someday, no date', assigneeId: u.userId });
    await createTask(u, { title: 'next month', assigneeId: u.userId, dueAt: Date.now() + 30 * 86_400_000 });

    const dueOnly = await buildFocusStack(u);
    assert.deepEqual(dueOnly.cards.map((c) => c.task.title), ['due today']);

    const all = await buildFocusStack(u, { allMine: true });
    assert.equal(all.cards.length, 3);
    assert.equal(all.cards[0]!.task.title, 'due today', 'deadline default order still leads with due');
    assert.ok(all.cards.every((c) => c.kind === 'do'));
  });

  it('snooze parks a card for at most an hour, then it comes back', async () => {
    const { snoozeFocusCard, getActiveSnoozes, MAX_SNOOZE_SECONDS } = await import('./focus.js');
    const u: Context = { userId: nanoid(12) };
    const db = getDb();
    await db.insert(users).values({
      id: u.userId, email: null, name: 'snoozer', googleId: null, image: null, createdAt: Date.now(),
    });
    const now = Date.now();
    const t1 = await createTask(u, { title: 'annoying now', assigneeId: u.userId, dueAt: now });
    const t2 = await createTask(u, { title: 'fine to do', assigneeId: u.userId, dueAt: now });

    // Requesting 4 hours clamps to the 1h max — server-side, not client-trusted.
    const { until } = await snoozeFocusCard(u, { taskId: t1.id, seconds: 4 * 3600 });
    assert.ok(until <= Date.now() + MAX_SNOOZE_SECONDS * 1000 + 1000, 'clamped to ≤1h');

    const during = await buildFocusStack(u);
    assert.deepEqual(during.cards.map((c) => c.task.id), [t2.id], 'only the unsnoozed card remains');
    assert.equal(during.snoozed.count, 1);
    assert.equal(during.snoozed.nextBackAt, until);

    // After the max window the snooze has expired by construction.
    const later = await buildFocusStack(u, { now: now + MAX_SNOOZE_SECONDS * 1000 + 60_000 });
    assert.deepEqual(
      later.cards.map((c) => c.task.title).sort(),
      ['annoying now', 'fine to do'],
      'card returns after expiry',
    );
    assert.equal(later.snoozed.count, 0);

    // Prompt cards snooze by prompt id; a lying meta.until is re-capped on read.
    const snoozes = await getActiveSnoozes(u, now + 30 * 60_000);
    assert.ok((snoozes.get(t1.id) ?? 0) <= until, 'active within the window, capped');
  });

  it('sibling asks under a goal path node never form a fake quest', async () => {
    const u: Context = { userId: nanoid(12) };
    const uBot: Context = { userId: nanoid(12) };
    const db = getDb();
    await db.insert(users).values([
      { id: u.userId, email: null, name: 'pathuser', googleId: null, image: null, createdAt: Date.now() },
      { id: uBot.userId, email: null, name: 'path-bot', kind: 'agent', googleId: null, image: null, createdAt: Date.now() },
    ]);
    const goal = await createTask(u, { title: 'Ship it', kind: 'goal' });
    const node = await createTask(u, { title: 'Creative', parentId: goal.id });
    // Two unrelated asks that merely live under the same path node.
    for (const title of ['Budget shift', 'Hero visual']) {
      const t = await createTask(u, { title, parentId: node.id });
      await updateTask(u, t.id, { assigneeId: uBot.userId });
      await createPrompt(uBot, { taskId: t.id, kind: 'approval', prompt: `${title}?`, ...packaged });
    }
    const stack = await buildFocusStack(u);
    const promptCards = stack.cards.filter((c) => c.kind === 'prompt');
    assert.equal(promptCards.length, 2);
    assert.ok(
      promptCards.every((c) => c.quest === null),
      'no quest banner for structural grouping',
    );
  });

  it('a task parked in review with no prompt still surfaces as a review card', async () => {
    const u: Context = { userId: nanoid(12) };
    const uBot: Context = { userId: nanoid(12) };
    const db = getDb();
    await db.insert(users).values([
      { id: u.userId, email: null, name: 'reviewer', googleId: null, image: null, createdAt: Date.now() },
      { id: uBot.userId, email: null, name: 'review-bot', kind: 'agent', googleId: null, image: null, createdAt: Date.now() },
    ]);

    // A human moves finished work straight to review — no ask_human involved,
    // the guard on that path (assertMayEnterReview) only fires for agents —
    // but it still needs a description or comment: bare-with-nothing-attached
    // is rejected at the gate (see 'review requires something to review' in
    // tasks.test.ts), so this is what a *valid* prompt-less review looks like.
    const bare = await createTask(u, { title: 'Ship the landing page' });
    await updateTask(u, bare.id, {
      status: 'review',
      reviewerId: u.userId,
      description: 'live on staging, ready for a look',
    });

    // A second task also in review, but WITH a pending prompt — must show up
    // only as a prompt card, never doubled as a review card too.
    const asked = await createTask(u, { title: 'Approve the copy' });
    await updateTask(u, asked.id, { assigneeId: uBot.userId });
    await createPrompt(uBot, { taskId: asked.id, kind: 'approval', prompt: 'ok?', ...packaged });

    const stack = await buildFocusStack(u);
    const reviewCards = stack.cards.filter((c) => c.kind === 'review');
    assert.equal(reviewCards.length, 1);
    assert.equal(reviewCards[0]!.task.id, bare.id);

    const promptCards = stack.cards.filter((c) => c.kind === 'prompt');
    assert.equal(promptCards.length, 1);
    assert.equal(promptCards[0]!.task.id, asked.id);
  });

  it('cards carry their venture chain, root venture first', async () => {
    const u: Context = { userId: nanoid(12) };
    const uBot: Context = { userId: nanoid(12) };
    const db = getDb();
    await db.insert(users).values([
      { id: u.userId, email: null, name: 'vuser', googleId: null, image: null, createdAt: Date.now() },
      { id: uBot.userId, email: null, name: 'v-bot', kind: 'agent', googleId: null, image: null, createdAt: Date.now() },
    ]);
    const venture = await createTask(u, { title: 'Verikal', kind: 'entity' });
    const sub = await createTask(u, { title: 'Mobile app', kind: 'entity', parentId: venture.id });
    const goal = await createTask(u, { title: 'Launch v1', kind: 'goal', parentId: sub.id });
    const node = await createTask(u, { title: 'Build', parentId: goal.id });
    const asked = await createTask(u, { title: 'Pick the icon', parentId: node.id });
    await updateTask(u, asked.id, { assigneeId: uBot.userId });
    await createPrompt(uBot, { taskId: asked.id, kind: 'approval', prompt: 'icon ok?', ...packaged });

    // A goal-less manual task under a project still knows its full chain —
    // projects are one more pickable level below the sub-venture.
    const proj = await createTask(u, { title: 'Ops', kind: 'project', parentId: sub.id });
    const chore = await createTask(u, { title: 'Renew the cert', parentId: proj.id });
    await updateTask(u, chore.id, { assigneeId: u.userId });

    const stack = await buildFocusStack(u, { allMine: true });
    const promptCard = stack.cards.find((c) => c.kind === 'prompt');
    assert.deepEqual(
      promptCard!.ventures.map((v) => v.title),
      ['Verikal', 'Mobile app'],
      'root venture first, nearest sub-venture last',
    );
    const doCard = stack.cards.find((c) => c.kind === 'do' && c.task.id === chore.id);
    assert.deepEqual(
      doCard!.ventures.map((v) => `${v.kind}:${v.title}`),
      ['entity:Verikal', 'entity:Mobile app', 'project:Ops'],
      'goal-less cards derive ventures (and projects) from the task ancestry',
    );
  });
});

describe('day summary + streak', () => {
  it('counts today credit and consecutive prior qualifying days', async () => {
    const u: Context = { userId: nanoid(12) };
    const db = getDb();
    const DAY = 86_400_000;
    const now = Date.now();
    // Quota 100s → streak bar at 60s. Yesterday + day before qualify; 3 days ago misses.
    const mk = (offsetDays: number, seconds: number) => ({
      id: nanoid(12),
      userId: u.userId,
      taskId: null,
      promptId: null,
      type: 'answered' as const,
      seconds,
      meta: JSON.stringify({ estSeconds: seconds }),
      createdAt: now - offsetDays * DAY,
    });
    const { focusEvents } = await import('./schema.js');
    await db.insert(focusEvents).values([mk(0, 30), mk(1, 80), mk(2, 70), mk(3, 10)]);

    const s = await getFocusDaySummary(u, 100, { now });
    assert.equal(s.todayCreditSeconds, 30);
    assert.equal(s.streakDays, 2);
  });
});

describe('time-worked rows', () => {
  it('buckets actual seconds per day, including empty days', async () => {
    const u: Context = { userId: nanoid(12) };
    const db = getDb();
    const DAY = 86_400_000;
    const now = Date.now();
    const { focusEvents } = await import('./schema.js');
    const mk = (offsetDays: number, type: string, seconds: number | null) => ({
      id: nanoid(12),
      userId: u.userId,
      taskId: null,
      promptId: null,
      type: type as 'answered',
      seconds,
      meta: null,
      createdAt: now - offsetDays * DAY,
    });
    await db.insert(focusEvents).values([
      mk(0, 'answered', 120),
      mk(0, 'do_ended', 300),
      mk(0, 'drift', 40), // drift seconds are informational, not credit
      mk(2, 'sent_back', 60),
    ]);

    const rows = await getFocusTimeRows(u, { days: 4, now });
    assert.equal(rows.length, 4);
    const today = rows[3]!;
    assert.equal(today.creditSeconds, 420);
    assert.equal(today.answered, 1);
    assert.equal(today.doEnded, 1);
    assert.equal(today.drifts, 1);
    assert.equal(rows[1]!.creditSeconds, 60, 'two days ago: the send-back');
    assert.equal(rows[2]!.creditSeconds, 0, 'empty day present with zero');
  });
});

describe('office org', () => {
  it('builds groups, presence, waiting pills, and the manager row from live data', async () => {
    const { getOfficeOrg } = await import('./office.js');
    const { agentProfiles, taskComments } = await import('./schema.js');
    const db = getDb();
    const now = Date.now();

    const owner: Context = { userId: nanoid(12) };
    const mkUser = async (name: string, kind: 'human' | 'agent') => {
      const id = nanoid(12);
      await db.insert(users).values({ id, email: null, name, kind, googleId: null, image: null, createdAt: now });
      return id;
    };
    await db.insert(users).values({ id: owner.userId, email: null, name: 'office-owner', googleId: null, image: null, createdAt: now });
    const manager = await mkUser('chief', 'agent');
    const worker = await mkUser('worker', 'agent');
    const sleeper = await mkUser('sleeper', 'agent');

    // Charter for the worker, with a standup comment today.
    const charter = await createTask(owner, { title: 'worker charter' });
    await updateTask(owner, charter.id, { assigneeId: worker });
    await db.insert(taskComments).values({
      id: nanoid(12), userId: owner.userId, taskId: charter.id,
      authorUserId: worker, body: 'Y/T/B standup', source: 'agent', createdAt: now - 60_000,
    });

    // A pending ask raised by the worker → floor pill.
    const { agentPrompts: promptsTable } = await import('./schema.js');
    const { eq: eqOp } = await import('drizzle-orm');
    const asked = await createTask(owner, { title: 'needs approval' });
    await updateTask(owner, asked.id, { assigneeId: worker });
    const p = await createPrompt(owner, { taskId: asked.id, kind: 'approval', prompt: 'ship the thing?' });
    await db.update(promptsTable).set({ askedByUserId: worker }).where(eqOp(promptsTable.id, p.id));

    await db.insert(agentProfiles).values([
      { userId: manager, groupName: 'MANAGEMENT', roleLine: 'Chief of Staff', reportsTo: null, charterTaskId: null, subAgents: 0, box: null, brainScopeTaskIds: null, sort: 10 },
      { userId: worker, groupName: 'ALPHA', roleLine: 'Doer', reportsTo: manager, charterTaskId: charter.id, subAgents: 0, box: null, brainScopeTaskIds: null, sort: 20 },
      { userId: sleeper, groupName: 'ALPHA', roleLine: 'Idle', reportsTo: manager, charterTaskId: null, subAgents: 2, box: null, brainScopeTaskIds: null, sort: 30 },
    ]);

    const org = await getOfficeOrg(owner, { now });
    assert.equal(org.manager?.name, 'chief');
    assert.equal(org.groups.length, 1, 'manager row is not a group');
    assert.equal(org.groups[0]!.name, 'ALPHA');

    const w = org.groups[0]!.agents.find((a) => a.name === 'worker')!;
    assert.equal(w.presence, 'live', 'standup today → live');
    assert.equal(w.charter, true);
    assert.ok(w.acts >= 1, 'standup counts as activity');
    assert.equal(w.waiting.length, 1, 'pending ask → one pill');
    assert.equal(w.waiting[0], 'ship the thing?');

    const s = org.groups[0]!.agents.find((a) => a.name === 'sleeper')!;
    assert.equal(s.presence, 'off', 'no activity, no charter → off');
    assert.equal(s.sub, 2);
  });
});

describe('office station', () => {
  it('parses charter sections and standups; builds the full station payload', async () => {
    const { getOfficeStation, parseCharterSections, parseStandup, postOfficeMessage } = await import('./office.js');
    const { agentProfiles, taskComments, brainNotes } = await import('./schema.js');
    const db = getDb();
    const now = Date.now();

    // Parsers on their own.
    const sections = parseCharterSections('## Owns\n- Meta campaigns\n\n## Standing duties\n- Daily spend check\n\n## Judgment rules\n- Alone: ≤10% shifts\n\n## KPIs\n- leads/day');
    assert.deepEqual(sections.get('owns'), ['Meta campaigns']);
    assert.deepEqual(sections.get('judgment rules'), ['Alone: ≤10% shifts']);
    const su = parseStandup('Y — account dark\nT: align to reset\nB - awaiting relight');
    assert.deepEqual(su, { y: 'account dark', t: 'align to reset', b: 'awaiting relight' });
    assert.equal(parseStandup('free form update, no letters').y, 'free form update, no letters');

    // Full payload.
    const owner: Context = { userId: nanoid(12) };
    await db.insert(users).values([
      { id: owner.userId, email: null, name: 'station-owner', googleId: null, image: null, createdAt: now },
    ]);
    const agentId = nanoid(12);
    await db.insert(users).values({ id: agentId, email: null, name: 'stationbot', kind: 'agent', googleId: null, image: null, createdAt: now });

    const entity = await createTask(owner, { title: 'Brandco', kind: 'entity' });
    const charter = await createTask(owner, {
      title: 'stationbot charter',
      description: '## Owns\n- Meta campaigns\n## Standing duties\n- Daily spend check\n## Judgment rules\n- Alone: ≤10% shifts',
    });
    await db.insert(agentProfiles).values({
      userId: agentId, groupName: 'X', roleLine: 'Doer', reportsTo: null,
      charterTaskId: charter.id, subAgents: 0, box: null,
      brainScopeTaskIds: JSON.stringify([entity.id]), sort: 10,
    });
    await db.insert(taskComments).values({
      id: nanoid(12), userId: owner.userId, taskId: charter.id, authorUserId: agentId,
      body: 'Y — shipped ads\nT — reporting\nB — none', source: 'agent', createdAt: now - 1000,
    });
    await db.insert(brainNotes).values({
      id: nanoid(12), userId: owner.userId, scopeTaskId: entity.id, parentNoteId: null,
      title: 'Brand voice', icon: null, contentJson: '{"type":"doc","content":[]}',
      contentText: 'Hebrew-first, direct.\nZero hype.', position: 0, source: 'human',
      createdAt: now, updatedAt: now,
    });
    const q = await createTask(owner, { title: 'Live queue item' });
    await updateTask(owner, q.id, { assigneeId: agentId, status: 'doing' });
    const done = await createTask(owner, { title: 'Shipped thing' });
    await updateTask(owner, done.id, { assigneeId: agentId });
    await updateTask(owner, done.id, { status: 'done' });

    const st = await getOfficeStation(owner, agentId, { now });
    assert.ok(st);
    assert.deepEqual(st!.resp, ['Meta campaigns', 'Daily spend check']);
    assert.deepEqual(st!.know, ['Alone: ≤10% shifts']);
    assert.equal(st!.standup?.y, 'shipped ads');
    assert.equal(st!.presence, 'live');
    assert.ok(st!.docs[0]!.t.startsWith('Charter'), 'charter is doc #1');
    assert.ok(st!.docs.some((d) => d.t === 'Brand voice'), 'brain note included');
    assert.ok(st!.tasks.some(([, title, id]) => title === 'Live queue item' && id === q.id));
    assert.ok(st!.recent.some((r) => r[1] === 'Shipped thing' && r[4] === done.id));

    // Direct line lands on the charter.
    const posted = await postOfficeMessage(owner, agentId, 'wake up and report');
    assert.equal(posted.taskId, charter.id);
    const thread = await listCommentsForTask(owner, charter.id);
    assert.ok(thread.some((c) => c.body === '📨 from the Office: wake up and report'));
  });
});

describe('ventures floor (pulse)', () => {
  it('parses lanes from both charter section names, counting gaps', async () => {
    const { parseVentureLanes } = await import('./ventures.js');
    const lanes = parseVentureLanes(
      [
        '## North star',
        '- not a lane',
        '## The production line (Joel 2026-08-30) — lanes + standing WORK ORDERS',
        '- **ADS** — Jason (`abc`): minimum campaign LIVE daily (order `x`)',
        '- **JOBS** — ⏳ lane defined by Joel\'s deck (`d1`); owner wired on answer',
        '- **SEO** — seo-geo (`s1`): one piece Mon/Wed/Fri — 💤 queues until box re-login',
        '## KPIs',
        '- not a lane either',
      ].join('\n'),
    );
    assert.equal(lanes.length, 3, 'only production-line bullets count');
    assert.deepEqual(
      lanes.map((l) => [l.name, l.owner, l.gap, l.dormant]),
      [
        ['ADS', 'Jason', false, false],
        ['JOBS', null, true, false],
        ['SEO', 'seo-geo', false, true],
      ],
    );
    // "## Function map" is the other spelling in use and must parse the same.
    const fn = parseVentureLanes('## Function map\n- **Ads reporting** — underoutfit agent (`c`) — 💤 dormant');
    assert.equal(fn.length, 1);
    assert.equal(fn[0]!.name, 'Ads reporting');
  });

  it('derives the health ladder from motion, owners and staffing', async () => {
    const { getVenturePulse } = await import('./ventures.js');
    const { agentProfiles, taskComments } = await import('./schema.js');
    const db = getDb();
    const now = Date.now();
    const owner: Context = { userId: nanoid(12) };
    await db.insert(users).values({ id: owner.userId, email: null, name: 'venture-owner', googleId: null, image: null, createdAt: now });
    const bot = nanoid(12);
    await db.insert(users).values({ id: bot, email: null, name: 'venture-bot', kind: 'agent', googleId: null, image: null, createdAt: now });

    const LINE = '## The production line\n- **ADS** — venture-bot (`c1`): daily\n- **JOBS** — ⏳ awaiting your deck';
    const mk = async (title: string, body: string) => {
      const root = await createTask(owner, { title, kind: 'entity' });
      await createTask(owner, { title: `📕 Venture charter — ${title}`, parentId: root.id, description: body });
      return root.id;
    };
    const liveId = await mk('PulseLive', LINE);
    const warnId = await mk('PulseWarn', LINE);
    const critId = await mk('PulseCrit', LINE);
    const parkedId = await mk('PulseParked', '## Function map\n- **TBD** — ⏳ nobody yet');

    // live: an agent acted on the subtree today
    const liveChild = await createTask(owner, { title: 'live work', parentId: liveId });
    await db.insert(taskComments).values({
      id: nanoid(12), userId: owner.userId, taskId: liveChild.id, authorUserId: bot,
      body: 'shipped', source: 'agent', createdAt: now - 60_000,
    });
    // warn: no board motion, but the scoped agent stood up on its charter today
    const botCharter = await createTask(owner, { title: 'bot charter' });
    await db.insert(agentProfiles).values({
      userId: bot, groupName: 'V', roleLine: 'doer', reportsTo: null, charterTaskId: botCharter.id,
      subAgents: 0, box: null, brainScopeTaskIds: JSON.stringify([warnId]), sort: 800,
    });
    await db.insert(taskComments).values({
      id: nanoid(12), userId: owner.userId, taskId: botCharter.id, authorUserId: bot,
      body: 'Y/T/B', source: 'agent', createdAt: now - 30_000,
    });

    const rows = await getVenturePulse(owner, { now });
    const by = (id: string) => rows.find((r) => r.entityId === id)!;
    assert.equal(by(liveId).health, 'live', 'motion today');
    assert.equal(by(liveId).today, 1);
    assert.equal(by(warnId).health, 'warn', 'owner stood up, board silent');
    assert.ok(by(warnId).note.includes('owners in'), by(warnId).note);
    assert.equal(by(critId).health, 'crit', 'staffed and never a sound');
    assert.equal(by(parkedId).health, 'parked', 'no staffed function — never nags');
    assert.equal(by(liveId).staffedFunctions, 1);
    assert.equal(by(liveId).gaps, 1);
    assert.equal(by(liveId).week.length, 7);
  });

  it('a venture with two charters renders once', async () => {
    const { listVentures } = await import('./ventures.js');
    const owner: Context = { userId: nanoid(12) };
    const db = getDb();
    await db.insert(users).values({ id: owner.userId, email: null, name: 'dupe-owner', googleId: null, image: null, createdAt: Date.now() });
    const root = await createTask(owner, { title: 'DupeVenture', kind: 'entity' });
    await createTask(owner, { title: '📕 Venture charter — DupeVenture', parentId: root.id, description: '## Function map' });
    await createTask(owner, { title: '📕 Venture charter — DupeVenture', parentId: root.id, description: '## Function map' });
    const list = await listVentures();
    assert.equal(list.filter((v) => v.entityId === root.id).length, 1);
  });

  it('plates carry gate count and goal progress alongside the health signal', async () => {
    const { getVenturePulse } = await import('./ventures.js');
    const owner: Context = { userId: nanoid(12) };
    const bot = nanoid(12);
    const db = getDb();
    const now = Date.now();
    await db.insert(users).values([
      { id: owner.userId, email: null, name: 'plate-owner', googleId: null, image: null, createdAt: now },
      { id: bot, email: null, name: 'plate-bot', kind: 'agent', googleId: null, image: null, createdAt: now },
    ]);
    const root = await createTask(owner, { title: 'PlateVenture', kind: 'entity' });
    await createTask(owner, {
      title: '📕 Venture charter — PlateVenture',
      parentId: root.id,
      description: '## The production line\n- **ADS** — plate-bot (`c1`): daily',
    });
    const goal = await createTask(owner, { title: 'Plate goal', parentId: root.id, kind: 'goal' });
    const m1 = await createTask(owner, { title: 'm1', parentId: goal.id });
    await updateTask(owner, m1.id, { status: 'done' });
    await createTask(owner, { title: 'm2', parentId: goal.id });

    const askTask = await createTask(owner, { title: 'blocked ask', parentId: root.id });
    await updateTask(owner, askTask.id, { assigneeId: bot });
    await createPrompt(
      { userId: bot } as Context,
      { taskId: askTask.id, kind: 'approval', prompt: 'ok?', ...packaged },
    );

    const rows = await getVenturePulse(owner, { now });
    const plate = rows.find((r) => r.entityId === root.id)!;
    assert.equal(plate.gateCount, 1);
    assert.equal(plate.goalTitle, 'Plate goal');
    assert.equal(plate.goalPct, 50, '1 of 2 milestones done');
  });

  it('Speed is a manual override — HOLD forces parked regardless of activity', async () => {
    const { parseVentureSpeed, setVentureSpeed, getVenturePulse } = await import('./ventures.js');
    assert.equal(parseVentureSpeed('## North star\nsomething'), 'FULL', 'default when unset');
    assert.equal(parseVentureSpeed('## Speed: CRUISE\n## Other'), 'CRUISE');
    assert.equal(parseVentureSpeed('## Speed: hold'), 'HOLD', 'case-insensitive');

    const owner: Context = { userId: nanoid(12) };
    const bot = nanoid(12);
    const db = getDb();
    const now = Date.now();
    await db.insert(users).values([
      { id: owner.userId, email: null, name: 'speed-owner', googleId: null, image: null, createdAt: now },
      { id: bot, email: null, name: 'speed-bot', kind: 'agent', googleId: null, image: null, createdAt: now },
    ]);
    const root = await createTask(owner, { title: 'SpeedVenture', kind: 'entity' });
    const charter = await createTask(owner, {
      title: '📕 Venture charter — SpeedVenture',
      parentId: root.id,
      description: '## The production line\n- **ADS** — speed-bot (`c1`): daily',
    });
    // Motion today would normally read 'live' — Speed still overrides it.
    const child = await createTask(owner, { title: 'work', parentId: root.id });
    await db.insert((await import('./schema.js')).taskComments).values({
      id: nanoid(12), userId: owner.userId, taskId: child.id, authorUserId: bot,
      body: 'shipped', source: 'agent', createdAt: now - 60_000,
    });

    let rows = await getVenturePulse(owner, { now });
    assert.equal(rows.find((r) => r.entityId === root.id)!.speed, 'FULL');

    await setVentureSpeed(owner, root.id, 'HOLD');
    const updated = await getTask(owner, charter.id);
    assert.match(updated!.description!, /## Speed: HOLD/);

    rows = await getVenturePulse(owner, { now });
    const plate = rows.find((r) => r.entityId === root.id)!;
    assert.equal(plate.speed, 'HOLD');
    assert.equal(plate.health, 'parked', 'HOLD wins over live motion');
    assert.match(plate.note, /^held —/);
  });

  it('the floor sorts by urgency first, manual priority as the tiebreaker', async () => {
    const { getVenturePulse, bumpVenturePriority } = await import('./ventures.js');
    const owner: Context = { userId: nanoid(12) };
    const db = getDb();
    const now = Date.now();
    await db.insert(users).values({ id: owner.userId, email: null, name: 'order-owner', googleId: null, image: null, createdAt: now });
    const mk = async (title: string) => {
      const root = await createTask(owner, { title, kind: 'entity' });
      await createTask(owner, { title: `📕 Venture charter — ${title}`, parentId: root.id, description: '## Function map\n- **X** — ⏳ tbd' });
      return root.id;
    };
    // All parked (no staffed lanes) and equally quiet, so only manual
    // priority should decide the order among them.
    const a = await mk('OrderA');
    const b = await mk('OrderB');
    const c = await mk('OrderC');

    let rows = await getVenturePulse(owner, { now });
    const idx = (id: string) => rows.findIndex((r) => r.entityId === id);
    // No priority set yet — alphabetical fallback.
    assert.ok(idx(a) < idx(b) && idx(b) < idx(c));

    // Raise C above everyone: C, A, B.
    await bumpVenturePriority(owner, c, 'up');
    await bumpVenturePriority(owner, c, 'up');
    rows = await getVenturePulse(owner, { now });
    assert.ok(idx(c) < idx(a) && idx(a) < idx(b));

    // Already at the top — bumping up again is a no-op, not an error.
    await bumpVenturePriority(owner, c, 'up');
    rows = await getVenturePulse(owner, { now });
    assert.ok(idx(c) < idx(a));
  });

  it('RUSH jumps the whole floor, above even a crit venture', async () => {
    const { getVenturePulse, setVentureSpeed } = await import('./ventures.js');
    const owner: Context = { userId: nanoid(12) };
    const bot = nanoid(12);
    const db = getDb();
    const now = Date.now();
    await db.insert(users).values([
      { id: owner.userId, email: null, name: 'rush-owner', googleId: null, image: null, createdAt: now },
      { id: bot, email: null, name: 'rush-bot', kind: 'agent', googleId: null, image: null, createdAt: now },
    ]);
    const LINE = '## The production line\n- **ADS** — rush-bot (`c1`): daily';
    const mkStaffed = async (title: string) => {
      const root = await createTask(owner, { title, kind: 'entity' });
      await createTask(owner, { title: `📕 Venture charter — ${title}`, parentId: root.id, description: LINE });
      return root.id;
    };
    // Staffed + never a sound → crit, the normally-highest urgency tier.
    const critId = await mkStaffed('RushCrit');
    // A quiet FULL/parked venture we then promote to RUSH.
    const rushId = await mkStaffed('RushMe');

    let rows = await getVenturePulse(owner, { now });
    const idx = (id: string) => rows.findIndex((r) => r.entityId === id);
    assert.equal(rows.find((r) => r.entityId === critId)!.health, 'crit');
    assert.ok(idx(critId) < idx(rushId), 'crit outranks a plain FULL venture');

    await setVentureSpeed(owner, rushId, 'RUSH');
    rows = await getVenturePulse(owner, { now });
    assert.equal(rows.find((r) => r.entityId === rushId)!.speed, 'RUSH');
    assert.ok(idx(rushId) < idx(critId), 'RUSH now jumps above the crit venture');
  });
});

describe('venture room (D3 factory line)', () => {
  it('derives lane state — run, stuck, idle, and gap → off', async () => {
    const { getVentureRoom } = await import('./ventures.js');
    const { agentProfiles, taskComments } = await import('./schema.js');
    const db = getDb();
    const now = Date.now();
    const owner: Context = { userId: nanoid(12) };
    await db
      .insert(users)
      .values({ id: owner.userId, email: null, name: 'room-owner', googleId: null, image: null, createdAt: now });

    const runner = nanoid(12);
    const stuck = nanoid(12);
    const idler = nanoid(12);
    await db.insert(users).values([
      { id: runner, email: null, name: 'lane-runner', kind: 'agent', googleId: null, image: null, createdAt: now },
      { id: stuck, email: null, name: 'lane-stuck', kind: 'agent', googleId: null, image: null, createdAt: now },
      { id: idler, email: null, name: 'lane-idler', kind: 'agent', googleId: null, image: null, createdAt: now },
    ]);
    for (const [id, name] of [
      [runner, 'lane-runner'],
      [stuck, 'lane-stuck'],
      [idler, 'lane-idler'],
    ] as const) {
      await db.insert(agentProfiles).values({
        userId: id,
        groupName: 'Room',
        roleLine: 'doer',
        reportsTo: null,
        charterTaskId: null,
        subAgents: 0,
        box: null,
        brainScopeTaskIds: JSON.stringify([]),
        sort: 900,
      });
      void name;
    }

    const root = await createTask(owner, { title: 'RoomVenture', kind: 'entity' });
    await createTask(owner, {
      title: '📕 Venture charter — RoomVenture',
      parentId: root.id,
      description: [
        '## The production line',
        '- **ADS** — lane-runner (`c1`): daily',
        '- **OUTREACH** — lane-stuck (`c2`): daily',
        '- **SEO** — lane-idler (`c3`): daily',
        "- **JOBS** — ⏳ lane defined by Joel's deck",
      ].join('\n'),
    });

    const runTask = await createTask(owner, { title: 'ran today', parentId: root.id });
    await db.insert(taskComments).values({
      id: nanoid(12),
      userId: owner.userId,
      taskId: runTask.id,
      authorUserId: runner,
      body: 'shipped',
      source: 'agent',
      createdAt: now - 60_000,
    });

    const stuckTask = await createTask(owner, { title: 'blocked ask', parentId: root.id });
    await updateTask(owner, stuckTask.id, { assigneeId: stuck });
    await createPrompt(
      { userId: stuck } as Context,
      { taskId: stuckTask.id, kind: 'approval', prompt: 'ship the blocked one?', ...packaged },
    );

    const room = await getVentureRoom(owner, root.id, { now });
    assert.ok(room);
    const by = (name: string) => room!.lanes.find((l) => l.name === name)!;

    assert.equal(by('ADS').state, 'run');
    assert.equal(by('ADS').why, null);
    assert.equal(by('ADS').agentUserId, runner);

    assert.equal(by('OUTREACH').state, 'stuck');
    assert.equal(by('OUTREACH').why, 'ship the blocked one?');
    assert.equal(by('OUTREACH').blockedTask?.id, stuckTask.id);

    assert.equal(by('SEO').state, 'idle');
    assert.equal(by('SEO').why, 'no standup today');

    assert.equal(by('JOBS').state, 'off');
    assert.equal(by('JOBS').why, '⏳ awaiting owner');

    // Gate = the one pending prompt just raised under this subtree.
    assert.equal(room!.gate.count, 1);
  });

  it('a venture with no production line renders an empty, honest line', async () => {
    const { getVentureRoom } = await import('./ventures.js');
    const owner: Context = { userId: nanoid(12) };
    const db = getDb();
    await db
      .insert(users)
      .values({ id: owner.userId, email: null, name: 'empty-owner', googleId: null, image: null, createdAt: Date.now() });
    const root = await createTask(owner, { title: 'EmptyVenture', kind: 'entity' });
    await createTask(owner, {
      title: '📕 Venture charter — EmptyVenture',
      parentId: root.id,
      description: '## North star\n- no production line here',
    });
    const room = await getVentureRoom(owner, root.id);
    assert.ok(room);
    assert.equal(room!.lanes.length, 0);
  });

  it('returns null for a task id that is not a venture', async () => {
    const { getVentureRoom } = await import('./ventures.js');
    const owner: Context = { userId: nanoid(12) };
    const db = getDb();
    await db
      .insert(users)
      .values({ id: owner.userId, email: null, name: 'not-venture', googleId: null, image: null, createdAt: Date.now() });
    const t = await createTask(owner, { title: 'plain task' });
    const room = await getVentureRoom(owner, t.id);
    assert.equal(room, null);
  });

  it('derives goal progress from milestones, with a stopper on a blocked one', async () => {
    const { getVentureGoal } = await import('./ventures.js');
    const owner: Context = { userId: nanoid(12) };
    const doer = nanoid(12);
    const db = getDb();
    await db.insert(users).values([
      { id: owner.userId, email: null, name: 'goal-owner', googleId: null, image: null, createdAt: Date.now() },
      { id: doer, email: null, name: 'goal-doer', kind: 'agent', googleId: null, image: null, createdAt: Date.now() },
    ]);
    const root = await createTask(owner, { title: 'GoalVenture', kind: 'entity' });
    const goal = await createTask(owner, { title: 'Ship the launch', parentId: root.id, kind: 'goal' });
    const m1 = await createTask(owner, { title: 'Landing page', parentId: goal.id });
    await updateTask(owner, m1.id, { status: 'done' });
    const m2 = await createTask(owner, { title: 'Payment integration', parentId: goal.id });
    await updateTask(owner, m2.id, { assigneeId: doer });
    await createPrompt(
      { userId: doer } as Context,
      { taskId: m2.id, kind: 'approval', prompt: 'which processor?', ...packaged },
    );
    await createTask(owner, { title: 'Onboarding email', parentId: goal.id });

    const g = await getVentureGoal(root.id);
    assert.ok(g);
    assert.equal(g!.taskId, goal.id);
    assert.equal(g!.source, 'milestones');
    assert.equal(g!.progressPct, 33, '1 of 3 milestones done');
    const stuck = g!.milestones.find((m) => m.id === m2.id)!;
    assert.equal(stuck.stopper, true);
    assert.equal(stuck.why, 'which processor?');
    const done = g!.milestones.find((m) => m.id === m1.id)!;
    assert.equal(done.done, true);
    assert.equal(done.stopper, false);
  });

  it('falls back to a manual progressPct when a goal has no milestones', async () => {
    const { getVentureGoal } = await import('./ventures.js');
    const owner: Context = { userId: nanoid(12) };
    const db = getDb();
    await db
      .insert(users)
      .values({ id: owner.userId, email: null, name: 'manual-owner', googleId: null, image: null, createdAt: Date.now() });
    const root = await createTask(owner, { title: 'ManualGoalVenture', kind: 'entity' });
    const goal = await createTask(owner, { title: 'Grow revenue', parentId: root.id, kind: 'goal' });
    const untracked = await getVentureGoal(root.id);
    assert.equal(untracked!.source, 'none');
    assert.equal(untracked!.progressPct, null);

    await updateTask(owner, goal.id, { progressPct: 62 });
    const tracked = await getVentureGoal(root.id);
    assert.equal(tracked!.source, 'manual');
    assert.equal(tracked!.progressPct, 62);
  });

  it('no goal task under the venture is a valid, honest null', async () => {
    const { getVentureGoal } = await import('./ventures.js');
    const owner: Context = { userId: nanoid(12) };
    const db = getDb();
    await db
      .insert(users)
      .values({ id: owner.userId, email: null, name: 'no-goal-owner', googleId: null, image: null, createdAt: Date.now() });
    const root = await createTask(owner, { title: 'NoGoalVenture', kind: 'entity' });
    assert.equal(await getVentureGoal(root.id), null);
  });
});

describe('office fleet health (phase C)', () => {
  it('parses both heartbeat formats and ignores noise', async () => {
    const { parseHeartbeat } = await import('./office.js');
    const hb = parseHeartbeat(
      'HB host=jason-marketing gw=active agents=[jason,sdr-outreach,seo-geo] auth=ok errs4h=0 tok=in:2133,out:13918 at=2026-08-30T08:17:06Z',
      0,
    );
    assert.ok(hb);
    assert.equal(hb!.host, 'jason-marketing');
    assert.deepEqual(hb!.agents, ['jason', 'sdr-outreach', 'seo-geo']);
    assert.equal(hb!.auth, 'ok');
    assert.equal(hb!.at, Date.parse('2026-08-30T08:17:06Z'));

    const loggedOut = parseHeartbeat('HB host=shava gw=active agents=[main] auth=LOGGEDOUT errs4h=0 at=bogus', 777);
    assert.equal(loggedOut!.auth, 'loggedout');
    assert.equal(loggedOut!.at, 777, 'unparseable at= falls back to the comment time');

    const legacy = parseHeartbeat('✅ scout@box9 2026-08-30 04:00 UTC', 123);
    assert.deepEqual(legacy, { host: 'box9', agents: ['scout'], auth: 'ok', at: 123 });

    assert.equal(parseHeartbeat('daily check: all boxes fine', 0), null);
  });

  it('prefers a fresh auth=ok box for agents listed on several boxes', async () => {
    const { heartbeatFor } = await import('./office.js');
    const now = Date.now();
    const beats = [
      { host: 'dead-box', agents: ['roamer'], auth: 'ok', at: now - 40 * 3_600_000 },
      { host: 'locked-box', agents: ['roamer'], auth: 'loggedout', at: now - 3_600_000 },
      { host: 'good-box', agents: ['roamer'], auth: 'ok', at: now - 2 * 3_600_000 },
    ];
    assert.equal(heartbeatFor(beats, { box: null, name: 'Roamer' }, now)!.host, 'good-box');
    assert.equal(heartbeatFor(beats, { box: 'dead-box', name: 'nobody' }, now)!.host, 'dead-box');
    assert.equal(heartbeatFor(beats, { box: null, name: 'stranger' }, now), null);
  });

  it('heartbeats harden floor presence; unlinked profiles become red desks', async () => {
    const { getOfficeOrg } = await import('./office.js');
    const { agentProfiles, taskComments } = await import('./schema.js');
    const db = getDb();
    const now = Date.now();
    const owner: Context = { userId: nanoid(12) };
    await db.insert(users).values({ id: owner.userId, email: null, name: 'fleet-owner', googleId: null, image: null, createdAt: now });
    const mkAgent = async (name: string) => {
      const id = nanoid(12);
      await db.insert(users).values({ id, email: null, name, kind: 'agent', googleId: null, image: null, createdAt: now });
      return id;
    };
    const idleOk = await mkAgent('hb-idle');       // chartered + silent, healthy box
    const boxDown = await mkAgent('hb-boxdown');   // chartered + silent, box silent 30h
    const lockedOut = await mkAgent('hb-locked');  // active 10min ago, box logged out
    const uncovered = await mkAgent('hb-nocover'); // chartered + silent, no heartbeat

    const fleet = await createTask(owner, { title: 'Fleet Health' });
    const charter = await createTask(owner, { title: 'shared test charter' });
    await db.insert(taskComments).values([
      { id: nanoid(12), userId: owner.userId, taskId: fleet.id, authorUserId: owner.userId, body: `HB host=idle-box gw=active agents=[main] auth=ok at=${new Date(now - 3_600_000).toISOString()}`, source: 'agent', createdAt: now - 3_600_000 },
      { id: nanoid(12), userId: owner.userId, taskId: fleet.id, authorUserId: owner.userId, body: `HB host=down-box gw=active agents=[main] auth=ok at=${new Date(now - 30 * 3_600_000).toISOString()}`, source: 'agent', createdAt: now - 30 * 3_600_000 },
      { id: nanoid(12), userId: owner.userId, taskId: fleet.id, authorUserId: owner.userId, body: `HB host=locked-box gw=active agents=[hb-locked] auth=LOGGEDOUT at=${new Date(now - 3_600_000).toISOString()}`, source: 'agent', createdAt: now - 3_600_000 },
    ]);
    // Recent activity for the locked-out agent only.
    await db.insert(taskComments).values({
      id: nanoid(12), userId: owner.userId, taskId: charter.id, authorUserId: lockedOut, body: 'working', source: 'agent', createdAt: now - 600_000,
    });

    const ghostId = nanoid(12); // no users row on purpose
    const manager = (await db.select().from(agentProfiles)).find((p) => p.reportsTo === null)?.userId ?? null;
    await db.insert(agentProfiles).values([
      { userId: idleOk, groupName: 'FLEETTEST', roleLine: 'idle', reportsTo: manager, charterTaskId: charter.id, subAgents: 0, box: 'idle-box', brainScopeTaskIds: null, sort: 910 },
      { userId: boxDown, groupName: 'FLEETTEST', roleLine: 'down', reportsTo: manager, charterTaskId: charter.id, subAgents: 0, box: 'down-box', brainScopeTaskIds: null, sort: 920 },
      { userId: lockedOut, groupName: 'FLEETTEST', roleLine: 'locked', reportsTo: manager, charterTaskId: null, subAgents: 0, box: null, brainScopeTaskIds: null, sort: 930 },
      { userId: uncovered, groupName: 'FLEETTEST', roleLine: 'quiet', reportsTo: manager, charterTaskId: charter.id, subAgents: 0, box: null, brainScopeTaskIds: null, sort: 940 },
      { userId: ghostId, groupName: 'FLEETTEST', roleLine: 'ghost desk', reportsTo: manager, charterTaskId: null, subAgents: 0, box: null, brainScopeTaskIds: null, sort: 950 },
    ]);

    const org = await getOfficeOrg(owner, { now, fleetTaskId: fleet.id });
    const grp = org.groups.find((g) => g.name === 'FLEETTEST')!;
    const by = (name: string) => grp.agents.find((a) => a.name === name)!;
    assert.equal(by('hb-idle').presence, 'warn', 'healthy box softens chartered-silent from crit');
    assert.equal(by('hb-boxdown').presence, 'crit', 'box silent >24h forces crit');
    assert.equal(by('hb-locked').presence, 'warn', 'logged-out gateway caps live at warn');
    assert.equal(by('hb-nocover').presence, 'crit', 'no heartbeat coverage keeps the old ladder');
    const ghost = grp.agents.find((a) => a.id === ghostId)!;
    assert.equal(ghost.presence, 'crit', 'unlinked desk shows red instead of vanishing');
    assert.ok(ghost.name.startsWith('⚠'), 'unlinked desk is visibly flagged');
  });

  it('station shows the box console line and wake-now logs 🔔 on the charter', async () => {
    const { getOfficeStation, requestOfficeWake } = await import('./office.js');
    const { agentProfiles, taskComments } = await import('./schema.js');
    const db = getDb();
    const now = Date.now();
    const owner: Context = { userId: nanoid(12) };
    await db.insert(users).values({ id: owner.userId, email: null, name: 'wake-owner', googleId: null, image: null, createdAt: now });
    const agentId = nanoid(12);
    await db.insert(users).values({ id: agentId, email: null, name: 'wakebot', kind: 'agent', googleId: null, image: null, createdAt: now });

    const fleet = await createTask(owner, { title: 'Fleet Health 2' });
    await db.insert(taskComments).values({
      id: nanoid(12), userId: owner.userId, taskId: fleet.id, authorUserId: owner.userId,
      body: `HB host=wake-box gw=active agents=[wakebot] auth=ok at=${new Date(now - 2 * 3_600_000).toISOString()}`,
      source: 'agent', createdAt: now - 2 * 3_600_000,
    });
    const charter = await createTask(owner, { title: 'wakebot charter', description: '## Owns\n- naps' });
    await db.insert(agentProfiles).values({
      userId: agentId, groupName: 'WAKE', roleLine: 'naps', reportsTo: null,
      charterTaskId: charter.id, subAgents: 0, box: 'wake-box', brainScopeTaskIds: null, sort: 990,
    });

    const st = await getOfficeStation(owner, agentId, { now, fleetTaskId: fleet.id });
    assert.ok(st);
    const boxLine = st!.screen.at(-1)!;
    assert.ok(boxLine.startsWith('▣ box wake-box'), `box status is the console tail: ${boxLine}`);
    assert.ok(boxLine.includes('auth ok'));

    delete process.env['OFFICE_WAKE_WEBHOOK_URL'];
    const wake = await requestOfficeWake(owner, agentId);
    assert.equal(wake.commented, true);
    assert.equal(wake.taskId, charter.id);
    assert.equal(wake.delivered, false);
    assert.ok(wake.note.includes('no wake webhook'), wake.note);
    const thread = await listCommentsForTask(owner, charter.id);
    assert.ok(thread.some((c) => c.body === '🔔 Wake requested from the Office'));
  });
});

describe('focus settings', () => {
  it('defaults apply when nothing is stored', async () => {
    const fresh: Context = { userId: nanoid(12) };
    assert.deepEqual(await getFocusSettings(fresh), DEFAULT_FOCUS_SETTINGS);
  });

  it('set/get round-trips a partial patch', async () => {
    const u: Context = { userId: nanoid(12) };
    await setFocusSettings(u, { dailyQuotaSeconds: 3600, focusSort: 'minutes', soundOn: false });
    const s = await getFocusSettings(u);
    assert.equal(s.dailyQuotaSeconds, 3600);
    assert.equal(s.focusSort, 'minutes');
    assert.equal(s.soundOn, false);
    assert.equal(s.checkinIntervalSec, DEFAULT_FOCUS_SETTINGS.checkinIntervalSec, 'unpatched keeps default');
  });
});

/**
 * `reviewQueueHours` is the Saturation Law input behind `office_pulse` — the
 * 8–10h check the head-of-staff duty runs. It is deliberately workspace-wide
 * rather than ctx-scoped (the queue it measures is the human's), so these
 * assertions are on the DELTA: any prompt another test left pending is part of
 * the same real sum, and pinning an absolute would make this test a tripwire
 * for unrelated fixtures.
 */
describe('review queue hours', () => {
  const asHours = (seconds: number) => seconds / 3600;

  it('sums pending asks workspace-wide and drops them as they are answered', async () => {
    const { getReviewQueueHours } = await import('./ventures.js');
    const base = await getReviewQueueHours();

    const a = await createTask(ctx, { title: 'Queue item A' });
    await updateTask(ctx, a.id, { assigneeId: botCtx.userId });
    const pa = await createPrompt(botCtx, {
      taskId: a.id,
      kind: 'approval',
      prompt: 'ship A?',
      ...packaged,
      estSeconds: 90,
    });

    const b = await createTask(ctx, { title: 'Queue item B' });
    await updateTask(ctx, b.id, { assigneeId: botCtx.userId });
    await createPrompt(botCtx, {
      taskId: b.id,
      kind: 'approval',
      prompt: 'ship B?',
      ...packaged,
      estSeconds: 30,
    });

    const withBoth = await getReviewQueueHours();
    assert.equal(
      Math.round((withBoth - base) * 3600),
      120,
      'both pending asks counted, in hours',
    );

    // Answering is what drains the queue — the row stays, its status changes.
    await answerPrompt(ctx, pa.id, { approved: true });
    const afterAnswer = await getReviewQueueHours();
    assert.equal(
      Math.round((afterAnswer - base) * 3600),
      30,
      'an answered ask no longer costs the human time',
    );
    assert.ok(afterAnswer < withBoth, 'queue shrinks, never grows, on answer');
    assert.equal(asHours(30), 30 / 3600);
  });

  /**
   * The reason `getReviewQueueLoad` exists. Measured on the live workspace on
   * 2026-09-03: 7 pending asks, 435 s of answer time = 0.12 h against an 8–10 h
   * target — the gauge reads 1.5% saturated, "idle, send more" — while the
   * oldest of them had been blocking a lane for 27.9 hours. `hours` is answer
   * time; it is structurally blind to wait time. This test pins that the load
   * shape reports the age too, so the gauge cannot read green over a stale queue.
   */
  it('reports age and denominator, not just hours', async () => {
    const { getReviewQueueLoad } = await import('./ventures.js');
    const { agentPrompts } = await import('./schema.js');
    const { eq } = await import('drizzle-orm');
    const now = Date.now();
    const before = await getReviewQueueLoad({ now });

    const stale = await createTask(ctx, { title: 'Queue item C — cheap but ancient' });
    await updateTask(ctx, stale.id, { assigneeId: botCtx.userId });
    const p = await createPrompt(botCtx, {
      taskId: stale.id,
      kind: 'approval',
      prompt: 'ship C?',
      ...packaged,
      estSeconds: 30,
    });
    // Backdate the ask by a day: 30 seconds of work, blocking for 24 hours.
    const db = getDb();
    await db
      .update(agentPrompts)
      .set({ createdAt: now - 24 * 3_600_000 })
      .where(eq(agentPrompts.id, p.id));

    const after = await getReviewQueueLoad({ now });
    assert.equal(after.items, before.items + 1, 'items is the denominator behind hours');
    assert.equal(
      Math.round((after.hours - before.hours) * 3600),
      30,
      'hours still measures answer time only',
    );
    assert.ok(
      after.oldestAgeHours >= 24,
      `age is the signal hours cannot carry (got ${after.oldestAgeHours})`,
    );
    // The whole point, as a ratio: this ask added 30 seconds of load and 24
    // hours of blockage. Asserted on the delta, not the absolute, because other
    // suites leave real pending asks in the same workspace-wide sum.
    assert.ok(
      after.hours - before.hours < after.oldestAgeHours / 100,
      'a day-old blockage barely moves the hours gauge',
    );

    // Draining it must drop the age back, or the gauge would latch red forever.
    await answerPrompt(ctx, p.id, { approved: true });
    const drained = await getReviewQueueLoad({ now });
    assert.equal(drained.items, before.items, 'answered asks leave the queue');
    assert.ok(drained.oldestAgeHours < 24, 'the age signal clears when the queue drains');
  });

  it('counts asks with no estimate as imputed, so hours declares its own confidence', async () => {
    const { getReviewQueueLoad } = await import('./ventures.js');
    const { agentPrompts } = await import('./schema.js');
    const { eq } = await import('drizzle-orm');
    const before = await getReviewQueueLoad();

    const t = await createTask(ctx, { title: 'Queue item D — unestimated' });
    await updateTask(ctx, t.id, { assigneeId: botCtx.userId });
    const p = await createPrompt(botCtx, {
      taskId: t.id,
      kind: 'approval',
      prompt: 'ship D?',
      ...packaged,
      estSeconds: 45,
    });
    // Agents are forced to pass estSeconds; rows predating that rule are null.
    const db = getDb();
    await db.update(agentPrompts).set({ estSeconds: null }).where(eq(agentPrompts.id, p.id));

    const after = await getReviewQueueLoad();
    assert.equal(after.imputed, before.imputed + 1, 'a null estimate is reported, not hidden');
    assert.equal(
      Math.round((after.hours - before.hours) * 3600),
      60,
      'imputed rows still contribute the default, so hours stays a total',
    );

    await answerPrompt(ctx, p.id, { approved: true });
    assert.equal((await getReviewQueueLoad()).imputed, before.imputed, 'imputed drains with the queue');
  });

  /**
   * 2026-09-04: `oldestAgeHours` fixed the blind spot in `hours` and then had
   * its own. Two pending asks measured on the live workspace that morning:
   * one 21.5 h old that the human had never been served, one opened at 07:50
   * and still unanswered ~2 h later. Same status, same shape of age number,
   * opposite remedies — the first needs delivering, the second needs rewriting.
   * This pins that the load shape can tell them apart.
   */
  it('separates asks the human has seen from asks never delivered', async () => {
    const { getReviewQueueLoad } = await import('./ventures.js');
    const { agentPrompts } = await import('./schema.js');
    const { eq } = await import('drizzle-orm');
    const now = Date.now();
    const before = await getReviewQueueLoad({ now });

    const mk = async (title: string) => {
      const t = await createTask(ctx, { title });
      await updateTask(ctx, t.id, { assigneeId: botCtx.userId });
      return createPrompt(botCtx, {
        taskId: t.id,
        kind: 'approval',
        prompt: `ship ${title}?`,
        ...packaged,
        estSeconds: 30,
      });
    };

    const unseen = await mk('Queue item E — never delivered');
    const seen = await mk('Queue item F — read and put down');

    const db = getDb();
    // Both created a day ago, so `oldestAgeHours` cannot distinguish them.
    await db
      .update(agentPrompts)
      .set({ createdAt: now - 24 * 3_600_000 })
      .where(eq(agentPrompts.id, unseen.id));
    await db
      .update(agentPrompts)
      .set({ createdAt: now - 24 * 3_600_000, openedAt: now - 2 * 3_600_000 })
      .where(eq(agentPrompts.id, seen.id));

    const after = await getReviewQueueLoad({ now });
    assert.equal(after.items, before.items + 2, 'both are still pending work');
    assert.equal(after.seen, before.seen + 1, 'exactly one of the two has been rendered');

    // The point of the split: age-since-creation is identical for both, so it
    // is `seen` / `oldestSeenAgeHours` carrying the difference, nothing else.
    assert.ok(after.oldestAgeHours >= 24, 'both look equally old by creation');
    assert.ok(
      after.oldestSeenAgeHours >= 2 && after.oldestSeenAgeHours < 24,
      `seen-age runs from first render, not creation (got ${after.oldestSeenAgeHours})`,
    );

    // Answering the seen one must drain the seen counters, or the gauge latches.
    await answerPrompt(ctx, seen.id, { approved: true });
    const drained = await getReviewQueueLoad({ now });
    assert.equal(drained.seen, before.seen, 'answered asks leave the seen count');
    assert.equal(drained.items, before.items + 1, 'the undelivered one is still waiting');

    await answerPrompt(ctx, unseen.id, { approved: true });
  });

  it('a queue nobody has opened reports zero seen-age, not the creation age', async () => {
    const { getReviewQueueLoad } = await import('./ventures.js');
    const { agentPrompts } = await import('./schema.js');
    const { eq } = await import('drizzle-orm');
    const now = Date.now();

    const t = await createTask(ctx, { title: 'Queue item G — undelivered only' });
    await updateTask(ctx, t.id, { assigneeId: botCtx.userId });
    const p = await createPrompt(botCtx, {
      taskId: t.id,
      kind: 'approval',
      prompt: 'ship G?',
      ...packaged,
      estSeconds: 30,
    });
    const db = getDb();
    await db
      .update(agentPrompts)
      .set({ createdAt: now - 48 * 3_600_000, openedAt: null })
      .where(eq(agentPrompts.id, p.id));

    const load = await getReviewQueueLoad({ now });
    // Guard against the failure this whole shape exists to prevent: a gauge
    // that silently reuses the wrong clock. If nothing else in the workspace
    // has been opened, seen-age must be 0 even though a row is 48 h old.
    if (load.seen === 0) {
      assert.equal(load.oldestSeenAgeHours, 0, 'no seen row means no seen age');
      assert.ok(load.oldestAgeHours >= 48, 'while creation-age still reports the backlog');
    } else {
      // Other suites leave opened rows behind; the invariant that always holds
      // is that seen-age is never older than creation-age for the same queue.
      assert.ok(
        load.oldestSeenAgeHours <= load.oldestAgeHours + 1e-6,
        'a card cannot have been read before it was created',
      );
    }

    await answerPrompt(ctx, p.id, { approved: true });
  });

  it('an empty queue reports zero age rather than a spurious one', async () => {
    const { getReviewQueueLoad } = await import('./ventures.js');
    const load = await getReviewQueueLoad();
    if (load.items === 0) {
      assert.equal(load.oldestAgeHours, 0, 'no items means no oldest item');
      assert.equal(load.hours, 0);
      assert.equal(load.imputed, 0);
      assert.equal(load.seen, 0, 'no items means nothing seen');
      assert.equal(load.oldestSeenAgeHours, 0);
    } else {
      // Other suites leave real pending asks behind; the invariant that holds
      // unconditionally is that age and hours are only ever claimed alongside
      // a non-zero denominator.
      assert.ok(load.items > 0 && load.oldestAgeHours >= 0);
    }
  });
});
