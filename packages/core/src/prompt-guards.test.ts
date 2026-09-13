import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { closeDb, getDb } from './db/client.js';
import { taskShares, users } from './schema.js';
import { createTask, getTask, HumanGateSkippedError, moveTask, updateTask } from './tasks.js';
import { setAgentRules } from './settings.js';
import {
  AgentRecipientError,
  answerPrompt,
  cancelPrompt,
  createPrompt,
  listPromptsForTask,
  HumanResolutionRequiredError,
  markPromptNotRelevant,
  sendBackPrompt,
  WITHDREW_ASK_COMMENT,
} from './prompts.js';
import { listCommentsForTask } from './comments.js';
import type { Context } from './context.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-prompt-guards-'));
  process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
  process.env['HOME'] = tmpDir;

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

/**
 * Share a task with a user. Needed only in the §5.2 tests below, where the
 * fixture must be a task an AGENT owns that a human can still reach — which is
 * the real situation (Joel sees every agent's card) and the exact one where the
 * owner and the person who should answer are different people.
 */
async function share(taskId: string, userId: string) {
  await getDb()
    .insert(taskShares)
    .values({ taskId, userId, createdAt: Date.now() });
}

async function botAsk(taskId: string, prompt = 'ship it?') {
  return createPrompt(botCtx, { taskId, kind: 'approval', prompt, ...packaged });
}

describe('prompt resolution is human-only', () => {
  it('rejects an agent answering a prompt; the human still can', async () => {
    const t = await botTask('agent-answer');
    const p = await botAsk(t.id);
    await assert.rejects(
      () => answerPrompt(botCtx, p.id, { approved: true }),
      HumanResolutionRequiredError,
    );
    const answered = await answerPrompt(ctx, p.id, { approved: true });
    assert.equal(answered.status, 'answered');
    assert.equal(answered.answeredByUserId, ctx.userId);
  });

  it('rejects an agent sending back or closing as not relevant', async () => {
    const t = await botTask('agent-resolve');
    const p = await botAsk(t.id);
    await assert.rejects(() => sendBackPrompt(botCtx, p.id, 'nope'), HumanResolutionRequiredError);
    await assert.rejects(() => markPromptNotRelevant(botCtx, p.id), HumanResolutionRequiredError);
    // Prompt untouched by the rejected calls.
    const still = await answerPrompt(ctx, p.id, { approved: false });
    assert.equal(still.status, 'answered');
  });

  it('stamps the principal on not-relevant', async () => {
    const t = await botTask('stamp-not-relevant');
    const p = await botAsk(t.id);
    const closed = await markPromptNotRelevant(ctx, p.id);
    assert.equal(closed.status, 'cancelled');
    assert.equal(closed.answeredByUserId, ctx.userId);
  });
});

describe('withdrawing an ask is loud and blocks self-completion', () => {
  it('agent cancelling its own ask returns the task to doing with a comment', async () => {
    const t = await botTask('withdraw');
    const p = await botAsk(t.id);
    assert.equal((await getTask(ctx, t.id))?.status, 'review');

    const cancelled = await cancelPrompt(botCtx, p.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.answeredByUserId, botCtx.userId, 'canceller is stamped');

    assert.equal((await getTask(ctx, t.id))?.status, 'doing', 'left the review queue');
    const comments = await listCommentsForTask(ctx, t.id);
    assert.ok(
      comments.some((c) => c.body === WITHDREW_ASK_COMMENT),
      'withdrawal is visible in the thread',
    );
  });

  it('agent cannot mark done while its own ask is pending', async () => {
    const t = await botTask('done-while-pending');
    await botAsk(t.id);
    await assert.rejects(
      () => updateTask(botCtx, t.id, { status: 'done' }),
      HumanGateSkippedError,
    );
  });

  it('agent cannot mark done after withdrawing its own ask; a fresh answered ask unblocks', async () => {
    const t = await botTask('done-after-withdraw');
    const p = await botAsk(t.id);
    await cancelPrompt(botCtx, p.id);
    await assert.rejects(
      () => updateTask(botCtx, t.id, { status: 'done' }),
      HumanGateSkippedError,
    );

    // Re-ask and let the human answer — completion is allowed again.
    const p2 = await botAsk(t.id, 'second try — ship it?');
    await answerPrompt(ctx, p2.id, { approved: true });
    const done = await updateTask(botCtx, t.id, { status: 'done' });
    assert.equal(done.status, 'done');
  });

  it('a human cancelling the agent ask counts as human resolution', async () => {
    const t = await botTask('human-cancel');
    const p = await botAsk(t.id);
    // Owner cancels from the web UI path.
    await cancelPrompt(ctx, p.id);
    // Task untouched by a human cancel (pre-existing behavior)…
    assert.equal((await getTask(ctx, t.id))?.status, 'review');
    // …and the agent may complete: a human resolved the ask.
    const done = await updateTask(botCtx, t.id, { status: 'done' });
    assert.equal(done.status, 'done');
  });

  it('humans are untouched by the completion guard', async () => {
    const t = await botTask('human-done');
    await botAsk(t.id);
    const done = await updateTask(ctx, t.id, { status: 'done' });
    assert.equal(done.status, 'done');
  });
});

/**
 * §5.2 — a question must reach a human.
 *
 * The defect, found 2026-09-03: `ask_human` addresses its question to the task
 * OWNER. A task an agent creates at the top level is owned by that agent, so an
 * agent asking on its own card asks *itself*. Nine cards were stranded that way;
 * six were agents asking themselves, and the oldest had been pending 29 days.
 *
 * What made it invisible rather than merely wrong: every surface reads healthy.
 * Task `review`, prompt `pending`, counted in the human's queue, and `ask_human`
 * returns the same `{id}` it returns on a good call. Two earlier remedies were
 * tried and both failed — setting `reviewerId` to the human (routing follows the
 * owner, measured), and `move_task` (ownership is fixed at creation).
 *
 * So these assert the ADDRESS, never just the fact that a prompt came back.
 */
describe('a question must reach a human', () => {
  it('the normal case is unaffected: a human-owned task addresses its owner', async () => {
    const t = await botTask('human-owned');
    const p = await botAsk(t.id);
    assert.equal(p.userId, ctx.userId, 'addressed to the human owner');
    assert.equal(p.reroutedFromUserId, undefined, 'nothing to reroute');
  });

  it('rejects an agent asking on a top-level task it owns — the six-of-nine case', async () => {
    // The exact shape that stranded them: the agent creates its own root card.
    const t = await createTask(botCtx, { title: 'agent-owned root' });
    assert.equal(t.userId, botCtx.userId, 'precondition: the agent owns it');

    await assert.rejects(() => botAsk(t.id), AgentRecipientError);

    // Nothing was written. A half-filed undeliverable prompt is worse than
    // none: it still reads as "waiting on the human".
    const after = await getTask(botCtx, t.id);
    assert.equal(after?.status, 'open', 'not bumped into the review queue');
    assert.equal((await listPromptsForTask(botCtx, t.id)).length, 0);
  });

  it('the rejection teaches the mechanism, not just the refusal', async () => {
    const t = await createTask(botCtx, { title: 'teaching' });
    const err = await botAsk(t.id).then(
      () => null,
      (e: Error) => e,
    );
    assert.ok(err, 'it rejects');
    const m = err.message;
    // Each of these is a wrong turn someone actually took on this bug.
    assert.match(m, /OWNER/, 'names the field that does the addressing');
    assert.match(m, /reviewerId does NOT re-address/i, 'kills the reviewerId workaround');
    // move_task is NOT a dead end and the message must not say it is. Measured
    // 2026-09-10 against the live workspace: of 46 agent-owned tasks, a fresh
    // ask would reroute on ONE and refuse on 45 — so this text is what almost
    // every agent hitting this rule actually reads, and the remedy it names is
    // the only one most of them will try. Naming create_task alone told them to
    // abandon the card's thread; the reroute test below proves filing the SAME
    // card under a human-owned parent works, because the chain is walked at ask
    // time. What move_task cannot do is re-address a prompt already filed.
    assert.match(m, /move_task\(/, 'offers the remedy that keeps the card');
    assert.match(m, /never a prompt already filed/i, 'and states its real limit');
    assert.doesNotMatch(
      m,
      /move_task does not change an existing owner/i,
      'must not read as "move_task will not help you" — it is the preferred fix',
    );
    assert.match(m, /parentId/, 'gives the remedy that works');
    assert.match(m, /list_prompts/, 'tells the agent to verify rather than trust the id');
  });

  it('the two remedies the rejection names are ordered cheapest-first', async () => {
    // Ablation of the ordering, not just of the words: an agent reads top-down
    // and takes the first thing that works. If create_task were listed first it
    // would be taken first, and every rescued card would lose its history.
    const t = await createTask(botCtx, { title: 'ordering' });
    const m = (await botAsk(t.id).then(
      () => null,
      (e: Error) => e,
    ))!.message;
    // Anchor both BEFORE comparing. indexOf returns -1 for an absent needle,
    // so `indexOf(a) < indexOf(b)` passes vacuously when `a` is missing —
    // which is exactly the message this test exists to reject. Caught by
    // ablating against the pre-2026-09-10 text: it failed the assertion above
    // and passed this one.
    const iMove = m.indexOf('move_task(');
    const iCreate = m.indexOf('create_task(');
    assert.ok(iMove >= 0, 'move_task is present at all');
    assert.ok(iCreate >= 0, 'create_task is present at all');
    assert.ok(iMove < iCreate, 'move_task is offered before create_task');
  });

  it('reroutes up to the nearest human owner instead of refusing', async () => {
    // The move_task case: created top-level by the agent (so agent-owned),
    // later filed under a card the human owns. There IS a human above it.
    const parent = await createTask(ctx, { title: 'venture' });
    const t = await createTask(botCtx, { title: 'agent-owned, later filed' });
    await share(t.id, ctx.userId);
    await moveTask(ctx, t.id, parent.id);

    const p = await botAsk(t.id);
    assert.equal(p.userId, ctx.userId, 'addressed to the human above it');
    assert.equal(p.reroutedFromUserId, botCtx.userId, 'and the reroute is visible in the result');

    // The card's reviewer follows the recipient too — leaving an agent as
    // reviewer would put it straight back in the unread bucket.
    assert.equal((await getTask(ctx, t.id))?.reviewerId, ctx.userId);
    // And it is genuinely answerable by that human.
    assert.equal((await answerPrompt(ctx, p.id, { approved: true })).status, 'answered');
  });

  it('an all-agent chain is refused, not rerouted to the deepest agent', async () => {
    const root = await createTask(botCtx, { title: 'agent root' });
    const mid = await createTask(botCtx, { title: 'agent child', parentId: root.id });
    await assert.rejects(() => botAsk(mid.id), AgentRecipientError);
  });

  it('humans are not subject to the rule at all', async () => {
    // A human may address an agent deliberately (Joel did on rmqIjorAaG4p).
    const t = await createTask(botCtx, { title: 'human asking an agent' });
    await share(t.id, ctx.userId);
    const p = await createPrompt(ctx, { taskId: t.id, kind: 'text', prompt: 'keep, slow or stop?' });
    assert.equal(p.userId, botCtx.userId, 'unchanged for human askers');
  });

  it('CONTROL: with the rule off, the broken addressing comes back', async () => {
    // Negative control. If this still routed to a human with the rule disabled,
    // the four assertions above would be passing off something else's behaviour
    // as the guard's.
    await setAgentRules({ prompt_reaches_a_human: false });
    try {
      const t = await createTask(botCtx, { title: 'rule off' });
      const p = await botAsk(t.id);
      assert.equal(p.userId, botCtx.userId, 'the pre-fix behaviour, on purpose');
    } finally {
      await setAgentRules({ prompt_reaches_a_human: true });
    }
  });
});

/**
 * §5.3 The account is not the channel.
 *
 * Every guard above keys on `users.kind`. That exempts an agent running on a
 * HUMAN's CLI token — which is what the Mac lane of `website-builder` actually
 * does: measured 2026-09-09 on the live workspace DB, its five most recent
 * comments are `author_user_id=zDNBp6zwzoa7` (Joel, kind='human') with
 * `source='agent'`, newest 2026-09-09T11:44:58Z. `ctx.viaAgentTool` is set by
 * the /api/mcp route and carries the channel instead of guessing it.
 */
describe('an agent on a human token is still an agent', () => {
  const viaTool = (c: Context) => ({ ...c, viaAgentTool: true });

  it('the deck requirement applies to a human token calling through the tool surface', async () => {
    const t = await createTask(ctx, { title: 'mac-lane-undecked-ask' });
    await assert.rejects(
      () => createPrompt(viaTool(ctx), { taskId: t.id, kind: 'approval', prompt: 'ship it?' }),
      /deck|recommendation|estSeconds/i,
    );
    assert.equal((await listPromptsForTask(ctx, t.id)).length, 0, 'nothing was written');
  });

  it('CONTROL: the same human ctx WITHOUT viaAgentTool may still ask bare', async () => {
    const t = await createTask(ctx, { title: 'web-ui-undecked-ask' });
    const p = await createPrompt(ctx, { taskId: t.id, kind: 'approval', prompt: 'ship it?' });
    assert.equal(p.userId, ctx.userId, 'a real human at the web UI is exempt, as before');
  });

  it('addressing applies too: a human token cannot file an ask against an agent-owned root', async () => {
    const t = await createTask(botCtx, { title: 'mac-lane-agent-owned-root' });
    await share(t.id, ctx.userId); // the human can SEE it; the question still cannot land on it
    await assert.rejects(
      () => createPrompt(viaTool(ctx), { taskId: t.id, kind: 'approval', prompt: 'ship it?', ...packaged }),
      AgentRecipientError,
    );
  });
});
