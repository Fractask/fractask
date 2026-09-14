import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from './db/client.js';
import {
  CycleError,
  NOT_SHARED_MESSAGE,
  NotFoundError,
  NotSharedError,
  ReviewWithoutContextError,
  ReviewWithoutPromptError,
  createTask,
  deleteTask,
  getSubtree,
  getTask,
  listTasks,
  moveTask,
  updateTask,
} from './tasks.js';
import {
  ForbiddenError,
  NOT_SHARED_NOTE_MESSAGE,
  NotSharedNoteError,
  noteVisibility,
  taskVisibility,
} from './access.js';
import {
  createBrainNote,
  deleteBrainNote,
  getBrainNote,
  listBrainNotes,
  moveBrainNote,
  searchBrainNotes,
  updateBrainNote,
} from './brain.js';
import { answerPrompt, cancelPrompt, createPrompt, listPromptsForTask } from './prompts.js';
import { createComment, deleteComment, listCommentsForTask } from './comments.js';
import { createScratchEntry, fileScratchEntry } from './scratchpad.js';
import {
  addAttachmentFromUrl,
  createAttachment,
  createUploadTicket,
  deleteAttachment,
  finalizeUpload,
  listAttachments,
  listAttachmentsForNote,
} from './attachments.js';
import { reportShipped } from './focus.js';
import { shareTaskWithEmail, shareTaskWithUserId } from './shares.js';
import { mcpErrorText } from './mcp-errors.js';
import { findTool } from './mcp-tools.js';
import { setAgentRules } from './settings.js';
import { taskShares, users } from './schema.js';
import type { Context } from './context.js';
import { nanoid } from 'nanoid';
import { resetStorageCache } from './storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let ctx: Context;
let otherCtx: Context;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-tasks-'));
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
  otherCtx = { userId: nanoid(12) };
  const ts = Date.now();
  await db.insert(users).values([
    { id: ctx.userId, email: null, name: 'primary', googleId: null, image: null, createdAt: ts },
    { id: otherCtx.userId, email: null, name: 'other', googleId: null, image: null, createdAt: ts },
  ]);
});

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('tasks core API', () => {
  it('create + get round-trip', async () => {
    const t = await createTask(ctx, { title: 'root' });
    assert.equal(t.title, 'root');
    assert.equal(t.userId, ctx.userId);
    assert.equal(t.parentId, null);
    assert.equal(t.position, 0);

    const fetched = await getTask(ctx, t.id);
    assert.ok(fetched);
    assert.equal(fetched!.id, t.id);
    assert.equal(fetched!.children.length, 0);
  });

  it('rejects unknown parent', async () => {
    await assert.rejects(() => createTask(ctx, { title: 'x', parentId: 'missing-id' }), NotFoundError);
  });

  it('siblings get sequential positions', async () => {
    const root = await createTask(ctx, { title: 'parent' });
    const a = await createTask(ctx, { title: 'a', parentId: root.id });
    const b = await createTask(ctx, { title: 'b', parentId: root.id });
    const c = await createTask(ctx, { title: 'c', parentId: root.id });
    assert.deepEqual([a.position, b.position, c.position], [0, 1, 2]);

    const list = await listTasks(ctx, { parentId: root.id });
    assert.deepEqual(list.map((t) => t.title), ['a', 'b', 'c']);
  });

  it('listTasks filters by status', async () => {
    const r = await createTask(ctx, { title: 'status-root' });
    const open = await createTask(ctx, { title: 'open-child', parentId: r.id });
    const doing = await createTask(ctx, { title: 'doing-child', parentId: r.id });
    await updateTask(ctx, doing.id, { status: 'doing' });

    const onlyOpen = await listTasks(ctx, { parentId: r.id, status: 'open' });
    assert.equal(onlyOpen.length, 1);
    assert.equal(onlyOpen[0]?.id, open.id);
  });

  it('updateTask sets completedAt when status -> done', async () => {
    const t = await createTask(ctx, { title: 'finish me' });
    const done = await updateTask(ctx, t.id, { status: 'done' });
    assert.equal(done.status, 'done');
    assert.ok(done.completedAt && done.completedAt > 0);

    const reopened = await updateTask(ctx, t.id, { status: 'open' });
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.completedAt, null);
  });

  it('getSubtree returns a nested tree', async () => {
    const r = await createTask(ctx, { title: 'tree-root' });
    const a = await createTask(ctx, { title: 'a', parentId: r.id });
    const b = await createTask(ctx, { title: 'b', parentId: r.id });
    const a1 = await createTask(ctx, { title: 'a1', parentId: a.id });
    const a2 = await createTask(ctx, { title: 'a2', parentId: a.id });

    const tree = await getSubtree(ctx, r.id);
    assert.ok(tree);
    assert.equal(tree!.id, r.id);
    assert.equal(tree!.children.length, 2);

    const aNode = tree!.children.find((c) => c.id === a.id);
    const bNode = tree!.children.find((c) => c.id === b.id);
    assert.ok(aNode);
    assert.ok(bNode);
    assert.equal(aNode!.children.length, 2);
    assert.equal(bNode!.children.length, 0);
    const childIds = aNode!.children.map((c) => c.id).sort();
    assert.deepEqual(childIds, [a1.id, a2.id].sort());
  });

  it('deleteTask cascades to descendants', async () => {
    const r = await createTask(ctx, { title: 'doomed-root' });
    const c1 = await createTask(ctx, { title: 'c1', parentId: r.id });
    const c2 = await createTask(ctx, { title: 'c2', parentId: r.id });
    const g1 = await createTask(ctx, { title: 'g1', parentId: c1.id });

    const result = await deleteTask(ctx, r.id);
    assert.equal(result.deletedIds.length, 4);
    assert.deepEqual(result.deletedIds.sort(), [r.id, c1.id, c2.id, g1.id].sort());

    for (const id of [r.id, c1.id, c2.id, g1.id]) {
      assert.equal(await getTask(ctx, id), null);
    }
  });

  it('moveTask reparents and rejects cycles', async () => {
    const a = await createTask(ctx, { title: 'm-a' });
    const b = await createTask(ctx, { title: 'm-b' });
    const child = await createTask(ctx, { title: 'm-child', parentId: a.id });

    const moved = await moveTask(ctx, child.id, b.id);
    assert.equal(moved.parentId, b.id);

    const aChildren = await listTasks(ctx, { parentId: a.id });
    assert.equal(aChildren.length, 0);
    const bChildren = await listTasks(ctx, { parentId: b.id });
    assert.equal(bChildren.length, 1);

    // Self-parent
    await assert.rejects(() => moveTask(ctx, a.id, a.id), CycleError);

    // Move ancestor under its own descendant
    const grand = await createTask(ctx, { title: 'm-grand', parentId: child.id });
    await assert.rejects(() => moveTask(ctx, b.id, grand.id), CycleError);
  });

  it('moveTask with explicit position shifts siblings', async () => {
    const r = await createTask(ctx, { title: 'pos-root' });
    const x = await createTask(ctx, { title: 'x', parentId: r.id });
    const y = await createTask(ctx, { title: 'y', parentId: r.id });
    const z = await createTask(ctx, { title: 'z', parentId: r.id });
    assert.deepEqual([x.position, y.position, z.position], [0, 1, 2]);

    // Move z to position 0 — x and y should shift down.
    await moveTask(ctx, z.id, r.id, 0);
    const ordered = await listTasks(ctx, { parentId: r.id });
    assert.deepEqual(ordered.map((t) => t.title), ['z', 'x', 'y']);
  });

  it('tenant isolation: another user cannot see or mutate tasks', async () => {
    const mine = await createTask(ctx, { title: 'mine' });
    assert.equal(await getTask(otherCtx, mine.id), null);
    await assert.rejects(() => updateTask(otherCtx, mine.id, { title: 'hijack' }), NotFoundError);
    await assert.rejects(() => deleteTask(otherCtx, mine.id), NotFoundError);
    const otherList = await listTasks(otherCtx, { parentId: null });
    assert.ok(otherList.every((t) => t.userId === otherCtx.userId));
  });
});

describe('sharing', () => {
  // Each test gets a freshly-shared root so they don't interfere via
  // cross-test pollution in the accessible-id set.
  async function shareTaskWith(taskId: string, userId: string) {
    const db = getDb();
    await db.insert(taskShares).values({ taskId, userId, createdAt: Date.now() });
  }

  async function unshare(taskId: string, userId: string) {
    const db = getDb();
    const { and, eq } = await import('drizzle-orm');
    await db.delete(taskShares).where(and(eq(taskShares.taskId, taskId), eq(taskShares.userId, userId)));
  }

  it('share grants read access to a task and its subtree', async () => {
    const root = await createTask(ctx, { title: 'shared-root' });
    const child = await createTask(ctx, { title: 'shared-child', parentId: root.id });
    const grand = await createTask(ctx, { title: 'shared-grand', parentId: child.id });

    // Before sharing: invisible.
    assert.equal(await getTask(otherCtx, root.id), null);
    assert.equal(await getTask(otherCtx, grand.id), null);

    await shareTaskWith(root.id, otherCtx.userId);

    // After sharing: root + descendants visible.
    const fetched = await getTask(otherCtx, root.id);
    assert.ok(fetched, 'shared root should be visible to recipient');
    const childFetched = await getTask(otherCtx, child.id);
    assert.ok(childFetched);
    const grandFetched = await getTask(otherCtx, grand.id);
    assert.ok(grandFetched);

    // Sharing the root surfaces it as a top-level task in the recipient's view.
    const otherRoots = await listTasks(otherCtx, { parentId: null });
    assert.ok(otherRoots.some((t) => t.id === root.id));
    // But the children stay nested, not lifted to root.
    assert.ok(!otherRoots.some((t) => t.id === child.id));

    await unshare(root.id, otherCtx.userId);
    assert.equal(await getTask(otherCtx, root.id), null);
  });

  it('shared collaborator can edit but tasks they create inherit owner', async () => {
    const root = await createTask(ctx, { title: 'edit-root' });
    const child = await createTask(ctx, { title: 'edit-child', parentId: root.id });
    await shareTaskWith(root.id, otherCtx.userId);

    // otherCtx can update a shared child and the change is owner-visible.
    const updated = await updateTask(otherCtx, child.id, { title: 'edited-by-other' });
    assert.equal(updated.title, 'edited-by-other');
    const fromOwner = await getTask(ctx, child.id);
    assert.equal(fromOwner!.title, 'edited-by-other');

    // Tasks otherCtx creates under the shared parent are owned by ctx.
    const added = await createTask(otherCtx, { title: 'added-by-other', parentId: root.id });
    assert.equal(added.userId, ctx.userId, 'inherited-owner rule: new task takes parent.userId');
    // Owner sees it without any extra share grant.
    const ownerSees = await getTask(ctx, added.id);
    assert.ok(ownerSees);

    await unshare(root.id, otherCtx.userId);
  });

  it('non-shared user still cannot see or edit', async () => {
    const root = await createTask(ctx, { title: 'private-root' });
    const child = await createTask(ctx, { title: 'private-child', parentId: root.id });

    assert.equal(await getTask(otherCtx, root.id), null);
    await assert.rejects(() => updateTask(otherCtx, child.id, { title: 'x' }), NotFoundError);
    await assert.rejects(() => deleteTask(otherCtx, root.id), NotFoundError);
  });

  it('review status: reviewer filter and self-review both work', async () => {
    const reviewerA = nanoid(12); // pretend assignee/reviewer ids
    const reviewerB = nanoid(12);
    const t1 = await createTask(ctx, { title: 'self-review', assigneeId: reviewerA, reviewerId: reviewerA });
    const t2 = await createTask(ctx, { title: 'peer-review', assigneeId: reviewerA, reviewerId: reviewerB });
    const t3 = await createTask(ctx, { title: 'no-reviewer' });

    await updateTask(ctx, t1.id, { status: 'review', description: 'ready' });
    await updateTask(ctx, t2.id, { status: 'review', description: 'ready' });

    const forA = await listTasks(ctx, { reviewerId: reviewerA, status: 'review' });
    const forB = await listTasks(ctx, { reviewerId: reviewerB, status: 'review' });
    assert.deepEqual(forA.map((t) => t.id), [t1.id]);
    assert.deepEqual(forB.map((t) => t.id), [t2.id]);

    const noReviewer = await listTasks(ctx, { reviewerId: null });
    assert.ok(noReviewer.some((t) => t.id === t3.id));
    assert.ok(!noReviewer.some((t) => t.id === t1.id));
  });

  it('unshare immediately revokes subtree access', async () => {
    const root = await createTask(ctx, { title: 'revoke-root' });
    const child = await createTask(ctx, { title: 'revoke-child', parentId: root.id });
    await shareTaskWith(root.id, otherCtx.userId);
    assert.ok(await getTask(otherCtx, root.id));
    assert.ok(await getTask(otherCtx, child.id));

    await unshare(root.id, otherCtx.userId);

    assert.equal(await getTask(otherCtx, root.id), null);
    assert.equal(await getTask(otherCtx, child.id), null);
  });
});

describe('assignment grants access', () => {
  // Assignee/reviewer are access roots, not just metadata: assigning a task to
  // an agent has to make it readable by that agent, or the agent is
  // accountable for work it cannot fetch.
  let agentCtx: Context;
  let strangerCtx: Context;

  before(async () => {
    const db = getDb();
    agentCtx = { userId: nanoid(12) };
    strangerCtx = { userId: nanoid(12) };
    const ts = Date.now();
    await db.insert(users).values([
      { id: agentCtx.userId, email: null, name: 'agent', googleId: null, image: null, createdAt: ts },
      { id: strangerCtx.userId, email: null, name: 'stranger', googleId: null, image: null, createdAt: ts },
    ]);
  });

  it('assignee sees the task and its subtree, with no share row', async () => {
    const entity = await createTask(ctx, { title: 'assign-entity' });
    const assigned = await createTask(ctx, { title: 'assign-task', parentId: entity.id });
    const sub = await createTask(ctx, { title: 'assign-subtask', parentId: assigned.id });

    assert.equal(await getTask(agentCtx, assigned.id), null, 'invisible before assignment');

    await updateTask(ctx, assigned.id, { assigneeId: agentCtx.userId });

    assert.ok(await getTask(agentCtx, assigned.id), 'assignee reads the assigned task');
    assert.ok(await getTask(agentCtx, sub.id), 'assignee reads its descendants');
  });

  it('assignment does not leak ancestors or siblings', async () => {
    const entity = await createTask(ctx, { title: 'leak-entity' });
    const assigned = await createTask(ctx, { title: 'leak-task', parentId: entity.id });
    const sibling = await createTask(ctx, { title: 'leak-sibling', parentId: entity.id });

    await updateTask(ctx, assigned.id, { assigneeId: agentCtx.userId });

    assert.equal(await getTask(agentCtx, entity.id), null, 'parent stays private');
    assert.equal(await getTask(agentCtx, sibling.id), null, 'sibling stays private');
  });

  it('the assigned task surfaces as a root in the assignee view', async () => {
    const entity = await createTask(ctx, { title: 'rootish-entity' });
    const assigned = await createTask(ctx, { title: 'rootish-task', parentId: entity.id });
    const sub = await createTask(ctx, { title: 'rootish-sub', parentId: assigned.id });
    await updateTask(ctx, assigned.id, { assigneeId: agentCtx.userId });

    // Its real parent is invisible, so it must appear at the top of the
    // assignee's list_tasks() rather than vanishing into an unreachable tree.
    const roots = await listTasks(agentCtx, { parentId: null });
    assert.ok(roots.some((t) => t.id === assigned.id), 'assigned task is a root for the assignee');
    assert.ok(!roots.some((t) => t.id === sub.id), 'its children stay nested');
  });

  it('reviewer gets the same access as assignee', async () => {
    const t = await createTask(ctx, { title: 'review-access' });
    assert.equal(await getTask(agentCtx, t.id), null);

    await updateTask(ctx, t.id, { reviewerId: agentCtx.userId, status: 'review', description: 'ready' });

    assert.ok(await getTask(agentCtx, t.id), 'reviewer can read what they must approve');
    const forReview = await listTasks(agentCtx, { reviewerId: agentCtx.userId, status: 'review' });
    assert.ok(forReview.some((x) => x.id === t.id), 'and it shows on their review queue');
  });

  it('access is derived: reassigning revokes the previous assignee immediately', async () => {
    const t = await createTask(ctx, { title: 'reassign' });
    const sub = await createTask(ctx, { title: 'reassign-sub', parentId: t.id });
    await updateTask(ctx, t.id, { assigneeId: agentCtx.userId });
    assert.ok(await getTask(agentCtx, t.id));

    await updateTask(ctx, t.id, { assigneeId: strangerCtx.userId });

    assert.equal(await getTask(agentCtx, t.id), null, 'old assignee loses access with no cleanup');
    assert.equal(await getTask(agentCtx, sub.id), null, 'including the subtree');
    assert.ok(await getTask(strangerCtx, t.id), 'new assignee gains it');

    // Unassigning entirely revokes too.
    await updateTask(ctx, t.id, { assigneeId: null });
    assert.equal(await getTask(strangerCtx, t.id), null);
  });

  it('assignee can write, matching how shares already behave', async () => {
    const t = await createTask(ctx, { title: 'assignee-write' });
    await updateTask(ctx, t.id, { assigneeId: agentCtx.userId });

    const updated = await updateTask(agentCtx, t.id, { status: 'doing' });
    assert.equal(updated.status, 'doing');
    const fromOwner = await getTask(ctx, t.id);
    assert.ok(fromOwner);
  });

  it('an unrelated user is still blind to assigned work', async () => {
    const t = await createTask(ctx, { title: 'assigned-elsewhere' });
    await updateTask(ctx, t.id, { assigneeId: agentCtx.userId });

    assert.equal(await getTask(strangerCtx, t.id), null);
    await assert.rejects(() => updateTask(strangerCtx, t.id, { title: 'x' }), NotFoundError);
  });
});

describe('review requires something to review', () => {
  // status='review' is the human's single "needs your input" queue. Agents were
  // parking finished work and status notes there with nothing to answer, which
  // is what makes the queue untrustworthy — so an agent now gets there through
  // ask_human (a real question) and not by setting the status directly.
  let botCtx: Context;

  before(async () => {
    const db = getDb();
    botCtx = { userId: nanoid(12) };
    await db.insert(users).values({
      id: botCtx.userId,
      email: null,
      name: 'bot',
      kind: 'agent',
      googleId: null,
      image: null,
      createdAt: Date.now(),
    });
  });

  async function assignedToBot(title: string) {
    const t = await createTask(ctx, { title });
    await updateTask(ctx, t.id, { assigneeId: botCtx.userId });
    return t;
  }

  it('an agent cannot park a task in review with no pending prompt', async () => {
    const t = await assignedToBot('agent-parks-review');
    await assert.rejects(
      () => updateTask(botCtx, t.id, { status: 'review' }),
      ReviewWithoutPromptError,
    );
    const after = await getTask(ctx, t.id);
    assert.equal(after?.status, 'open', 'status is left untouched by the rejected write');
  });

  it('the rest of the patch is rejected with it, not half-applied', async () => {
    const t = await assignedToBot('agent-parks-review-with-fields');
    await assert.rejects(
      () => updateTask(botCtx, t.id, { status: 'review', description: 'done, please look' }),
      ReviewWithoutPromptError,
    );
    const after = await getTask(ctx, t.id);
    assert.equal(after?.description, null);
  });

  it('a bare task — no prompt, no description, no comment — cannot enter review, human or agent', async () => {
    const t = await createTask(ctx, { title: 'human-sets-review-bare' });
    await assert.rejects(
      () => updateTask(ctx, t.id, { status: 'review' }),
      ReviewWithoutContextError,
    );
    const after = await getTask(ctx, t.id);
    assert.equal(after?.status, 'open');
  });

  it('a human moves work to review freely once it carries context — a description', async () => {
    const t = await createTask(ctx, { title: 'human-sets-review-with-description' });
    const updated = await updateTask(ctx, t.id, {
      status: 'review',
      description: 'ready for a look',
    });
    assert.equal(updated.status, 'review');
  });

  it('...or a comment is enough context too, no description required', async () => {
    const t = await createTask(ctx, { title: 'human-sets-review-with-comment' });
    await createComment(ctx, { taskId: t.id, body: 'ready for a look', source: 'human' });
    const updated = await updateTask(ctx, t.id, { status: 'review' });
    assert.equal(updated.status, 'review');
  });

  it('creating a task straight into review with no description is rejected the same way', async () => {
    await assert.rejects(
      () => createTask(ctx, { title: 'born-in-review', status: 'review' }),
      ReviewWithoutContextError,
    );
  });

  // The create path was only ever held to the context floor, so an agent could
  // walk straight past the prompt rule that updateTask enforces — and a
  // description, the one thing the floor asks for, is exactly what a
  // finished-deliverable report has. Measured live on prod 2026-09-09:
  // update_task(status="review") rejected, create_task(status="review",
  // description) accepted, landing a prompt-less card in the human's queue.
  it('an agent cannot be born in review either, description or not', async () => {
    await assert.rejects(
      () =>
        createTask(botCtx, {
          title: 'agent-born-in-review',
          status: 'review',
          description: 'Finished the deliverable. Nothing to answer here.',
        }),
      ReviewWithoutPromptError,
    );
    await assert.rejects(
      () => createTask(botCtx, { title: 'agent-born-in-review-bare', status: 'review' }),
      ReviewWithoutPromptError,
    );
  });

  it('CONTROL: a human is still born into review freely once it carries context', async () => {
    const t = await createTask(ctx, {
      title: 'human-born-in-review',
      status: 'review',
      description: 'ready for a look',
    });
    assert.equal(t.status, 'review');
  });

  // ── the account is not the channel ──────────────────────────────────────
  //
  // Every case above keys on `users.kind`. That misses an agent running on a
  // HUMAN's CLI token, which is not hypothetical: measured 2026-09-09 on the
  // live workspace DB, the Mac lane of `website-builder` posts through
  // /api/mcp as `zDNBp6zwzoa7` (Joel, kind='human') with source='agent', most
  // recently 2026-09-09T11:44:58Z. Under `kind` alone that whole lane is
  // exempt from this rule — and a description, which it always has, satisfies
  // the human context floor. `ctx.viaAgentTool` is set by the MCP route and
  // carries the channel instead of guessing it from the account.
  const viaTool = () => ({ ...ctx, viaAgentTool: true });

  it('an agent on a HUMAN token is held to the rule — update path', async () => {
    const t = await createTask(ctx, {
      title: 'mac-lane-parks-review',
      description: 'Finished the deliverable. Nothing to answer here.',
    });
    await assert.rejects(() => updateTask(viaTool(), t.id, { status: 'review' }), ReviewWithoutPromptError);
    const after = await getTask(ctx, t.id);
    assert.equal(after?.status, 'open', 'the rejected write left the status alone');
  });

  it('an agent on a HUMAN token is held to the rule — create path', async () => {
    await assert.rejects(
      () =>
        createTask(viaTool(), {
          title: 'mac-lane-born-in-review',
          status: 'review',
          description: 'Finished the deliverable. Nothing to answer here.',
        }),
      ReviewWithoutPromptError,
    );
  });

  it('CONTROL: the same human ctx WITHOUT viaAgentTool is unaffected — update path', async () => {
    const t = await createTask(ctx, {
      title: 'web-ui-parks-review',
      description: 'Finished the deliverable. Nothing to answer here.',
    });
    const updated = await updateTask(ctx, t.id, { status: 'review' });
    assert.equal(updated.status, 'review', 'a real human at the web UI still moves work to review');
  });

  it('CONTROL: the same human ctx WITHOUT viaAgentTool is unaffected — create path', async () => {
    const t = await createTask(ctx, {
      title: 'web-ui-born-in-review',
      status: 'review',
      description: 'ready for a look',
    });
    assert.equal(t.status, 'review');
  });

  it('CONTROL: with the rule off, an agent is born into review under the context floor only', async () => {
    await setAgentRules({ review_requires_prompt: false });
    try {
      await assert.rejects(
        () => createTask(botCtx, { title: 'agent-born-rule-off-bare', status: 'review' }),
        ReviewWithoutContextError,
      );
      const t = await createTask(botCtx, {
        title: 'agent-born-rule-off',
        status: 'review',
        description: 'finished, please check',
      });
      assert.equal(t.status, 'review');
    } finally {
      await setAgentRules({ review_requires_prompt: true });
    }
  });

  it('an agent may re-enter review while its question is still pending', async () => {
    const t = await assignedToBot('agent-reenters-review');
    await createPrompt(botCtx, {
      taskId: t.id,
      kind: 'approval',
      prompt: 'ship it?',
      deck: [{ kind: 'text', body: 'evidence' }],
      recommendation: 'Approve.',
      estSeconds: 30,
    });
    // Human bounces it back for another pass without answering yet.
    await updateTask(ctx, t.id, { status: 'doing' });

    const updated = await updateTask(botCtx, t.id, { status: 'review' });
    assert.equal(updated.status, 'review');
  });

  it('an agent can still edit a task already sitting in review', async () => {
    const t = await assignedToBot('agent-edits-in-review');
    await updateTask(ctx, t.id, { status: 'review', description: 'take a look' });

    const updated = await updateTask(botCtx, t.id, {
      status: 'review',
      description: 'extra context',
    });
    assert.equal(updated.description, 'extra context');
  });

  it('agents can still move work anywhere else', async () => {
    const t = await assignedToBot('agent-other-statuses');
    assert.equal((await updateTask(botCtx, t.id, { status: 'doing' })).status, 'doing');
    assert.equal((await updateTask(botCtx, t.id, { status: 'done' })).status, 'done');
  });

  it('turning the rule off at /settings/rules lets agents in without a prompt — but still needs context', async () => {
    const t = await assignedToBot('rule-toggled-off');
    await setAgentRules({ review_requires_prompt: false });
    try {
      // Still bare — the rule toggle waives the "must be ask_human" requirement,
      // not the baseline context floor everyone else is held to.
      await assert.rejects(
        () => updateTask(botCtx, t.id, { status: 'review' }),
        ReviewWithoutContextError,
      );
      const updated = await updateTask(botCtx, t.id, {
        status: 'review',
        description: 'finished, please check',
      });
      assert.equal(updated.status, 'review');
    } finally {
      await setAgentRules({ review_requires_prompt: true });
    }
    const back = await assignedToBot('rule-toggled-back-on');
    await assert.rejects(
      () => updateTask(botCtx, back.id, { status: 'review' }),
      ReviewWithoutPromptError,
    );
  });
});

describe('a new question supersedes the old one', () => {
  let botCtx: Context;
  let otherBotCtx: Context;

  before(async () => {
    const db = getDb();
    botCtx = { userId: nanoid(12) };
    otherBotCtx = { userId: nanoid(12) };
    const ts = Date.now();
    await db.insert(users).values([
      { id: botCtx.userId, email: null, name: 'asker', kind: 'agent', googleId: null, image: null, createdAt: ts },
      { id: otherBotCtx.userId, email: null, name: 'co-asker', kind: 'agent', googleId: null, image: null, createdAt: ts },
    ]);
  });

  it('the earlier pending prompt is cancelled and reported back', async () => {
    const t = await createTask(ctx, { title: 'storyboard-revisions' });
    const v1 = await createPrompt(ctx, { taskId: t.id, kind: 'approval', prompt: 'v1 ok?' });
    const v2 = await createPrompt(ctx, { taskId: t.id, kind: 'approval', prompt: 'v2 ok?' });

    assert.deepEqual(v2.supersededPromptIds, [v1.id]);
    const prompts = await listPromptsForTask(ctx, t.id);
    assert.equal(prompts.find((p) => p.id === v1.id)?.status, 'cancelled');
    assert.equal(prompts.find((p) => p.id === v2.id)?.status, 'pending');
    assert.equal(prompts.filter((p) => p.status === 'pending').length, 1);
  });

  it('keepPrevious keeps genuinely parallel questions alive', async () => {
    const t = await createTask(ctx, { title: 'parallel-questions' });
    const a = await createPrompt(ctx, { taskId: t.id, kind: 'text', prompt: 'budget?' });
    const b = await createPrompt(ctx, {
      taskId: t.id,
      kind: 'text',
      prompt: 'deadline?',
      keepPrevious: true,
    });

    assert.deepEqual(b.supersededPromptIds, []);
    const prompts = await listPromptsForTask(ctx, t.id);
    assert.equal(prompts.filter((p) => p.status === 'pending').length, 2);
    assert.equal(prompts.find((p) => p.id === a.id)?.status, 'pending');
  });

  it('another asker question is never cancelled', async () => {
    const t = await createTask(ctx, { title: 'two-agents-one-task' });
    await updateTask(ctx, t.id, { assigneeId: botCtx.userId });
    const theirs = await createPrompt(botCtx, {
      taskId: t.id,
      kind: 'text',
      prompt: 'which brand voice?',
      deck: [{ kind: 'text', body: 'evidence' }],
      recommendation: 'Use the playful voice.',
      estSeconds: 30,
    });
    const mine = await createPrompt(ctx, { taskId: t.id, kind: 'text', prompt: 'owner asks too' });

    assert.deepEqual(mine.supersededPromptIds, [], 'a different asker is out of scope');
    const prompts = await listPromptsForTask(ctx, t.id);
    assert.equal(prompts.find((p) => p.id === theirs.id)?.status, 'pending');
    assert.equal(prompts.filter((p) => p.status === 'pending').length, 2);
  });

  it('turning the rule off at /settings/rules lets prompts stack again', async () => {
    const t = await createTask(ctx, { title: 'supersede-toggled-off' });
    await setAgentRules({ supersede_prompts: false });
    try {
      const a = await createPrompt(ctx, { taskId: t.id, kind: 'text', prompt: 'v1?' });
      const b = await createPrompt(ctx, { taskId: t.id, kind: 'text', prompt: 'v2?' });
      assert.deepEqual(b.supersededPromptIds, []);
      const prompts = await listPromptsForTask(ctx, t.id);
      assert.equal(prompts.find((p) => p.id === a.id)?.status, 'pending');
      assert.equal(prompts.filter((p) => p.status === 'pending').length, 2);
    } finally {
      await setAgentRules({ supersede_prompts: true });
    }
  });

  it('an answered prompt is left alone — only pending ones are superseded', async () => {
    const t = await createTask(ctx, { title: 'answered-stays-answered' });
    const first = await createPrompt(ctx, { taskId: t.id, kind: 'approval', prompt: 'round 1?' });
    await answerPrompt(ctx, first.id, { approved: true });
    const second = await createPrompt(ctx, { taskId: t.id, kind: 'approval', prompt: 'round 2?' });

    assert.deepEqual(second.supersededPromptIds, []);
    const prompts = await listPromptsForTask(ctx, t.id);
    assert.equal(prompts.find((p) => p.id === first.id)?.status, 'answered');
  });
});

describe('deep queries — enumerating work at any depth', () => {
  // The reported bug: `list_tasks(assigneeId=X)` answered "nothing assigned"
  // to an agent holding six tasks, because an omitted parentId means "roots of
  // my view". A task surfaces as such a root only when its parent happens to
  // be INVISIBLE. Assign someone a task whose parent they can also see — the
  // normal case once an entity is shared with them — and it silently drops out
  // of their own work list.
  let workerCtx: Context;

  before(async () => {
    const db = getDb();
    workerCtx = { userId: nanoid(12) };
    await db.insert(users).values([
      { id: workerCtx.userId, email: null, name: 'worker', googleId: null, image: null, createdAt: Date.now() },
    ]);
  });

  it('roots-only hides an assigned task whose parent is also visible', async () => {
    const entity = await createTask(ctx, { title: 'deep-entity' });
    const nested = await createTask(ctx, { title: 'deep-nested', parentId: entity.id });
    // Both the parent and the leaf are reachable by the worker.
    await updateTask(ctx, entity.id, { assigneeId: workerCtx.userId });
    await updateTask(ctx, nested.id, { assigneeId: workerCtx.userId });

    const shallow = await listTasks(workerCtx, { parentId: null, assigneeId: workerCtx.userId });
    assert.ok(
      !shallow.some((t) => t.id === nested.id),
      'reproduces the bug: the nested assigned task is missing from a roots-only query',
    );

    const deep = await listTasks(workerCtx, {
      parentId: null,
      assigneeId: workerCtx.userId,
      deep: true,
    });
    assert.ok(deep.some((t) => t.id === nested.id), 'deep finds the nested assigned task');
    assert.ok(deep.some((t) => t.id === entity.id), 'deep still returns the top-level one');
  });

  it('deep honours the status filter across the whole tree', async () => {
    const entity = await createTask(ctx, { title: 'deep-status-entity' });
    const mid = await createTask(ctx, { title: 'deep-status-mid', parentId: entity.id });
    const leaf = await createTask(ctx, { title: 'deep-status-leaf', parentId: mid.id });
    await updateTask(ctx, leaf.id, { status: 'doing' });

    const deep = await listTasks(ctx, { parentId: null, status: 'doing', deep: true });
    assert.ok(deep.some((t) => t.id === leaf.id), 'a three-levels-down match is returned');

    const shallow = await listTasks(ctx, { parentId: null, status: 'doing' });
    assert.ok(!shallow.some((t) => t.id === leaf.id), 'and was invisible without deep');
  });

  it('deep widens depth, never visibility', async () => {
    const secret = await createTask(otherCtx, { title: 'deep-not-mine' });
    const deep = await listTasks(ctx, { parentId: null, deep: true });
    assert.ok(!deep.some((t) => t.id === secret.id), "another user's task stays invisible");
  });

  it('an explicit parentId still means direct children only', async () => {
    const entity = await createTask(ctx, { title: 'deep-explicit-entity' });
    const child = await createTask(ctx, { title: 'deep-explicit-child', parentId: entity.id });
    const grandchild = await createTask(ctx, { title: 'deep-explicit-gc', parentId: child.id });

    const rows = await listTasks(ctx, { parentId: entity.id, deep: true });
    assert.ok(rows.some((t) => t.id === child.id));
    assert.ok(
      !rows.some((t) => t.id === grandchild.id),
      'deep is ignored when parentId names a parent — that stays a direct-children query',
    );
  });
});

describe('coordinator (admin) scope', () => {
  // Problem A: an admin could SEE a task through the admin dashboards but got
  // NotFound writing to it, because the access CTE knew only owner/share/
  // assignee/reviewer. A human answer sat undelivered for four days.
  let adminCtx: Context;
  let plainCtx: Context;

  before(async () => {
    const db = getDb();
    adminCtx = { userId: nanoid(12) };
    plainCtx = { userId: nanoid(12) };
    const ts = Date.now();
    await db.insert(users).values([
      { id: adminCtx.userId, email: null, name: 'coordinator', googleId: null, image: null, createdAt: ts, isAdmin: true },
      { id: plainCtx.userId, email: null, name: 'plain', googleId: null, image: null, createdAt: ts },
    ]);
  });

  it('reads a task in a tree it neither owns nor is shared', async () => {
    const entity = await createTask(otherCtx, { title: 'coord-entity' });
    const nested = await createTask(otherCtx, { title: 'coord-nested', parentId: entity.id });

    assert.equal(await getTask(plainCtx, nested.id), null, 'non-admin still cannot see it');
    assert.ok(await getTask(adminCtx, nested.id), 'admin reads it');
  });

  it('WRITES to it — the actual bug', async () => {
    const t = await createTask(otherCtx, { title: 'coord-write' });

    await assert.rejects(
      () => updateTask(plainCtx, t.id, { status: 'doing' }),
      NotFoundError,
      'non-admin write is still rejected',
    );

    const updated = await updateTask(adminCtx, t.id, { status: 'doing' });
    assert.equal(updated.status, 'doing', 'admin write lands');
  });

  it('sees any task at any depth via a deep query', async () => {
    const entity = await createTask(otherCtx, { title: 'coord-deep-entity' });
    const leaf = await createTask(otherCtx, {
      title: 'coord-deep-leaf',
      parentId: entity.id,
      // "Review needs a question" guard: give the card something to act on.
      description: 'check the rendered head tags',
    });
    await updateTask(otherCtx, leaf.id, { status: 'review' });

    const queue = await listTasks(adminCtx, { parentId: null, status: 'review', deep: true });
    assert.ok(queue.some((t) => t.id === leaf.id), 'the whole review queue in one call');
  });

  it('admin listing at roots shows real roots, not everything', async () => {
    const entity = await createTask(otherCtx, { title: 'coord-roots-entity' });
    const nested = await createTask(otherCtx, { title: 'coord-roots-nested', parentId: entity.id });

    const roots = await listTasks(adminCtx, { parentId: null });
    assert.ok(roots.some((t) => t.id === entity.id), 'a real root is listed');
    assert.ok(
      !roots.some((t) => t.id === nested.id),
      'a nested task does not masquerade as a root just because admin can reach its parent',
    );
  });
});

describe('taskVisibility — "not shared" is not "not there"', () => {
  // The damage a bare null does is not a missing row, it is a confident wrong
  // conclusion: an agent reads null, decides the task was never created, and
  // creates a duplicate on top of the one it cannot see.
  it('reports hidden for a task that exists but is not shared', async () => {
    const t = await createTask(otherCtx, { title: 'vis-hidden' });
    assert.equal(await getTask(ctx, t.id), null, 'the read still returns null');
    assert.equal(await taskVisibility(ctx, t.id), 'hidden');
  });

  it('reports missing for an id that was never real', async () => {
    assert.equal(await taskVisibility(ctx, 'no-such-id-at-all'), 'missing');
  });

  it('reports missing for a task that was genuinely deleted', async () => {
    const t = await createTask(ctx, { title: 'vis-deleted' });
    assert.equal(await taskVisibility(ctx, t.id), 'visible');
    await deleteTask(ctx, t.id);
    assert.equal(
      await taskVisibility(ctx, t.id),
      'missing',
      'deleted and never-existed are the same answer — only hidden is new',
    );
  });

  it('reports visible for a task reached by assignment, not ownership', async () => {
    const t = await createTask(otherCtx, { title: 'vis-assigned' });
    await updateTask(otherCtx, t.id, { assigneeId: ctx.userId });
    assert.equal(await taskVisibility(ctx, t.id), 'visible');
  });
});

describe('NotSharedError — every write path answers like get_task does', () => {
  // The one-site version of this guarantee is what made the bug look covered:
  // get_task said `not_shared`, and every other tool said `not_found: Task X
  // not found` for the same id. Measured on 2026-09-03 with `TfmR7QJFqluo` —
  // attach_file's "not found" produced a wrong conclusion before a second tool
  // contradicted it. So: a case per entry point, not one shared case.
  let hidden: string;

  before(async () => {
    hidden = (await createTask(otherCtx, { title: 'not-shared-with-primary' })).id;
    // Sanity: the fixture really is hidden, not merely absent.
    assert.equal(await taskVisibility(ctx, hidden), 'hidden');
  });

  const rejectsNotShared = (fn: () => Promise<unknown>) =>
    assert.rejects(fn, (err: unknown) => {
      assert.ok(err instanceof NotSharedError, `expected NotSharedError, got ${String(err)}`);
      assert.match(err.message, /do not recreate it/);
      return true;
    });

  it('update_task', () => rejectsNotShared(() => updateTask(ctx, hidden, { title: 'hijack' })));

  it('delete_task', () => rejectsNotShared(() => deleteTask(ctx, hidden)));

  it('move_task — the id being moved', () =>
    rejectsNotShared(() => moveTask(ctx, hidden, null)));

  it('move_task — the destination parent', async () => {
    const mine = await createTask(ctx, { title: 'mine-to-move' });
    await rejectsNotShared(() => moveTask(ctx, mine.id, hidden));
  });

  it('create_task with parentId', () =>
    rejectsNotShared(() => createTask(ctx, { title: 'child', parentId: hidden })));

  it('post_comment', () =>
    rejectsNotShared(() => createComment(ctx, { taskId: hidden, body: 'hello' })));

  it('list_comments', () => rejectsNotShared(() => listCommentsForTask(ctx, hidden)));

  it('attach_file', () =>
    rejectsNotShared(() =>
      createAttachment(ctx, {
        taskId: hidden,
        filename: 'a.txt',
        mimeType: 'text/plain',
        body: new Uint8Array([1]),
      }),
    ));

  it('list_attachments', () => rejectsNotShared(() => listAttachments(ctx, hidden)));

  it('ask_human', () =>
    rejectsNotShared(() =>
      createPrompt(ctx, { taskId: hidden, kind: 'text', prompt: 'q?', estSeconds: 10 }),
    ));

  it('list_prompts', () => rejectsNotShared(() => listPromptsForTask(ctx, hidden)));

  // Added 2026-09-14. This suite's header says "every write path", and for
  // eleven days it enumerated eleven of them. `report_shipped` is a twelfth:
  // it takes a `taskId`, it writes a focus_events row, and it was in no
  // not_shared case in any file. Found by joining the live `tools/list` (32
  // tools) against the core functions these blocks actually call — a census
  // keyed on the test TITLES reads 9 of 32 and would have missed it, because a
  // title census counts what a test is named, not what it exercises.
  //
  // It is not a bug: focus.ts:229 already calls assertAccessibleExists, so this
  // block is green the moment it is written. That is the point the suite header
  // above makes — a guard that is correct and unpinned is one refactor from the
  // defect this card was opened for. Ablated: swapping that one call for
  // assertExists turns this case red and nothing else in the file moves.
  it('report_shipped', () =>
    rejectsNotShared(() => reportShipped(ctx, { taskId: hidden, title: 'shipped' })));

  // Added 2026-09-14, and it is the THIRD access helper — not a thirteenth call
  // site of the first. Every case above reaches `assertAccessibleExists`; these
  // reach `assertOwnedExists`, which answers the hidden case only because it
  // *delegates* to it (access.ts:306) after failing its own owner lookup. That
  // delegation is one early `throw new ForbiddenError` from turning every
  // not-shared share attempt back into the wrong answer, and until now nothing
  // pinned it. Found by deriving the tool set transitively rather than reading
  // the `it()` titles — see not-shared-coverage.test.ts.
  //
  // Both legs, because they are two functions: shares.ts:150 and shares.ts:49.
  // A repair to one leg of a paired guard is not a repair to the guard.
  it('share_task — the userId leg', () =>
    rejectsNotShared(() => shareTaskWithUserId(ctx, hidden, otherCtx.userId)));

  it('share_task — the email leg', () =>
    rejectsNotShared(() => shareTaskWithEmail(ctx, hidden, 'someone-else@example.com')));

  // The discrimination that makes the two cases above meaningful: on a task the
  // caller CAN see but does not own, assertOwnedExists must still answer
  // forbidden. "You cannot see this" and "you can see it but may not do this"
  // are different answers and neither may collapse into the other.
  it('share_task on a visible-but-unowned task stays forbidden, not not_shared', async () => {
    const theirs = await createTask(otherCtx, { title: 'assigned-to-me-not-mine' });
    await updateTask(otherCtx, theirs.id, { assigneeId: ctx.userId });
    await assert.rejects(
      () => shareTaskWithUserId(ctx, theirs.id, otherCtx.userId),
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError, `expected ForbiddenError, got ${String(err)}`);
        assert.ok(!(err instanceof NotSharedError), 'visible must not report as not_shared');
        return true;
      },
    );
  });

  // The half that stops this being a blanket relabel. If a genuinely absent id
  // started reporting `not_shared`, an agent would ask for access to a row that
  // was never there — the mirror image of the bug being fixed.
  it('an id that was never real stays a plain not_found', async () => {
    await assert.rejects(
      () => createComment(ctx, { taskId: 'zzzzzzzzzzzz', body: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError);
        assert.ok(!(err instanceof NotSharedError), 'missing must not report as not_shared');
        return true;
      },
    );
  });

  it('a deleted task stays a plain not_found', async () => {
    const t = await createTask(ctx, { title: 'gone' });
    await deleteTask(ctx, t.id);
    await assert.rejects(
      () => updateTask(ctx, t.id, { title: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError);
        assert.ok(!(err instanceof NotSharedError));
        return true;
      },
    );
  });

  // Load-bearing for both MCP transports: errorText() checks NotFoundError
  // first in source order unless NotSharedError is tested above it. This
  // assertion is what makes that ordering requirement a test failure rather
  // than a code review comment.
  it('NotSharedError is a NotFoundError, so error mappers must test it first', () => {
    const err = new NotSharedError('abc');
    assert.ok(err instanceof NotFoundError);
    assert.equal(err.name, 'NotSharedError');
    assert.equal(err.taskId, 'abc');
    assert.equal(err.message, `Task abc not shared — ${NOT_SHARED_MESSAGE}`);
  });

  it('a shared-in task still works normally', async () => {
    const t = await createTask(otherCtx, { title: 'shared-in' });
    await updateTask(otherCtx, t.id, { assigneeId: ctx.userId });
    const c = await createComment(ctx, { taskId: t.id, body: 'reachable' });
    assert.equal(c.taskId, t.id);
  });
});

describe('NotSharedNoteError — brain notes answer the same way tasks do', () => {
  // The suite above was written to the card title "…across all MCP tools",
  // and then sampled only the tools that take a *task* id. get_note,
  // update_note, delete_note, move_note, create_note(parentNoteId) and the
  // note-side attachment paths are MCP tools too, and every one of them ran
  // through a guard that filtered on accessibility inside its WHERE clause —
  // structurally unable to tell "no such note" from "not yours". Verified on
  // prod 2026-09-13: the task half shipped, this half never existed.
  let hiddenNote: string;

  before(async () => {
    hiddenNote = (await createBrainNote(otherCtx, { title: 'not-shared-note' })).id;
    assert.equal(await noteVisibility(ctx, hiddenNote), 'hidden');
  });

  const rejectsNotShared = (fn: () => Promise<unknown>) =>
    assert.rejects(fn, (err: unknown) => {
      assert.ok(
        err instanceof NotSharedNoteError,
        `expected NotSharedNoteError, got ${String(err)}`,
      );
      assert.match(err.message, /do not recreate it/);
      assert.match(err.message, /^Note /);
      return true;
    });

  it('update_note', () => rejectsNotShared(() => updateBrainNote(ctx, hiddenNote, { title: 'x' })));

  it('delete_note', () => rejectsNotShared(() => deleteBrainNote(ctx, hiddenNote)));

  it('move_note — the id being moved', () =>
    rejectsNotShared(() => moveBrainNote(ctx, hiddenNote, null)));

  it('move_note — the destination parent', async () => {
    const mine = await createBrainNote(ctx, { title: 'mine-to-move' });
    await rejectsNotShared(() => moveBrainNote(ctx, mine.id, hiddenNote));
  });

  it('create_note with parentNoteId', () =>
    rejectsNotShared(() => createBrainNote(ctx, { title: 'child', parentNoteId: hiddenNote })));

  it('update_note — the new parentNoteId', async () => {
    const mine = await createBrainNote(ctx, { title: 'mine-to-reparent' });
    await rejectsNotShared(() => updateBrainNote(ctx, mine.id, { parentNoteId: hiddenNote }));
  });

  it('attach_file to a note', () =>
    rejectsNotShared(() =>
      createAttachment(ctx, {
        brainNoteId: hiddenNote,
        filename: 'a.txt',
        mimeType: 'text/plain',
        body: new Uint8Array([1]),
      }),
    ));

  it('list_attachments for a note', () =>
    rejectsNotShared(() => listAttachmentsForNote(ctx, hiddenNote)));

  // get_note is the one that returns rather than throws — the note-side mirror
  // of get_task's `not_shared` body. A bare null is what makes an agent rewrite
  // a note that already exists.
  it('get_note reports hidden, and getBrainNote still returns null for the web', async () => {
    assert.equal(await getBrainNote(ctx, hiddenNote), null);
    assert.equal(await noteVisibility(ctx, hiddenNote), 'hidden');
    assert.equal(await noteVisibility(ctx, 'zzzzzzzzzzzz'), 'missing');
  });

  // Same half as above: without this the change is a blanket relabel, and an
  // agent ends up asking for access to a note that was never there.
  it('a note id that was never real stays a plain not_found', async () => {
    await assert.rejects(
      () => updateBrainNote(ctx, 'zzzzzzzzzzzz', { title: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError);
        assert.ok(!(err instanceof NotSharedError), 'missing must not report as not_shared');
        return true;
      },
    );
  });

  it('a deleted note stays a plain not_found', async () => {
    const n = await createBrainNote(ctx, { title: 'gone' });
    await deleteBrainNote(ctx, n.id);
    await assert.rejects(
      () => updateBrainNote(ctx, n.id, { title: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError);
        assert.ok(!(err instanceof NotSharedError));
        return true;
      },
    );
  });

  // Load-bearing: both MCP transports map not_shared with a single
  // `instanceof NotSharedError` check. NotSharedNoteError is a *subclass* of it
  // precisely so neither transport needed a third branch — if someone reparents
  // it to NotFoundError directly, notes silently go back to saying "not found".
  it('NotSharedNoteError is a NotSharedError, so both transports map it already', () => {
    const err = new NotSharedNoteError('abc');
    assert.ok(err instanceof NotSharedError);
    assert.ok(err instanceof NotFoundError);
    assert.equal(err.name, 'NotSharedNoteError');
    assert.equal(err.noteId, 'abc');
    assert.equal(err.message, `Note abc not shared — ${NOT_SHARED_NOTE_MESSAGE}`);
  });

  it('the two messages differ only in the noun', () => {
    assert.equal(
      NOT_SHARED_NOTE_MESSAGE,
      NOT_SHARED_MESSAGE.replace('This task exists', 'This note exists'),
    );
  });

  it('a note in a shared-in scope still works normally', async () => {
    // kind must be entity/project — brain notes only scope to those.
    const t = await createTask(otherCtx, { title: 'shared-scope', kind: 'project' });
    await updateTask(otherCtx, t.id, { assigneeId: ctx.userId });
    const n = await createBrainNote(otherCtx, { title: 'scoped', scopeTaskId: t.id });
    const got = await getBrainNote(ctx, n.id);
    assert.equal(got?.id, n.id);
  });
});

// ---------------------------------------------------------------------------
// The seam between the two suites above.
//
// Both partition by OBJECT TYPE: one owns tools whose subject is a task, the
// other tools whose subject is a note. Neither owns an argument that is a TASK
// id on a tool whose subject is something else — `create_note(scopeTaskId)`,
// `scratchpad_file(taskId)` — or a task id that is a *reference* rather than
// the subject: `goalId`, `milestoneId`, `goalTaskId`.
//
// Censused 2026-09-13 14:0xZ with a throwaway probe: all 11 such arguments
// already answer `not_shared` correctly, because they route through
// `assertAccessibleExists` like everything else. So this suite fixes NO bug.
// It exists because nothing pinned them — grep for `goalId`/`goalTaskId`/
// `milestoneId` across every *.test.ts found them only in focus.test.ts, which
// asserts goal-path behaviour and never passes an unreachable id. A guard that
// is correct and untested is one refactor away from the exact defect this card
// was opened for, and it would reappear in the arguments least likely to be
// re-probed.
//
// Ablated: reverting `assertAccessibleExists` to `assertExists` in
// tasks.ts::resolveGoalLink turns three of these red and nothing else in the
// suite moves.
describe('not_shared on a task id used as a REFERENCE, not as the subject', () => {
  let hiddenTask: string;
  let hiddenGoal: string;

  before(async () => {
    hiddenTask = (await createTask(otherCtx, { title: 'ref-hidden-task' })).id;
    hiddenGoal = (await createTask(otherCtx, { title: 'ref-hidden-goal', kind: 'goal' })).id;
    assert.equal(await taskVisibility(ctx, hiddenTask), 'hidden');
    assert.equal(await taskVisibility(ctx, hiddenGoal), 'hidden');
  });

  const rejectsNotShared = (fn: () => Promise<unknown>) =>
    assert.rejects(fn, (err: unknown) => {
      assert.ok(err instanceof NotSharedError, `expected NotSharedError, got ${String(err)}`);
      assert.match(err.message, /do not recreate it/);
      return true;
    });

  it('create_task — goalId', () =>
    rejectsNotShared(() => createTask(ctx, { title: 'x', goalId: hiddenGoal })));

  // The goal must be VISIBLE here or the goalId check above fires first and
  // this case never reaches the milestone guard it is named after — a control
  // is only valid for the exact invocation it is run in.
  it('create_task — milestoneId, with a reachable goal', async () => {
    const myGoal = await createTask(ctx, { title: 'ref-my-goal-a', kind: 'goal' });
    await rejectsNotShared(() =>
      createTask(ctx, { title: 'x', goalId: myGoal.id, milestoneId: hiddenTask }),
    );
  });

  it('update_task — goalId', async () => {
    const mine = await createTask(ctx, { title: 'ref-mine-a' });
    await rejectsNotShared(() => updateTask(ctx, mine.id, { goalId: hiddenGoal }));
  });

  it('update_task — milestoneId, with a reachable goal', async () => {
    const mine = await createTask(ctx, { title: 'ref-mine-b' });
    const myGoal = await createTask(ctx, { title: 'ref-my-goal-b', kind: 'goal' });
    await rejectsNotShared(() =>
      updateTask(ctx, mine.id, { goalId: myGoal.id, milestoneId: hiddenTask }),
    );
  });

  it('ask_human — goalTaskId', async () => {
    const mine = await createTask(ctx, { title: 'ref-mine-c' });
    await rejectsNotShared(() =>
      createPrompt(ctx, {
        taskId: mine.id,
        kind: 'text',
        prompt: 'q?',
        estSeconds: 10,
        goalTaskId: hiddenGoal,
      }),
    );
  });

  it('create_note — scopeTaskId (a task id on a note tool)', () =>
    rejectsNotShared(() => createBrainNote(ctx, { title: 'n', scopeTaskId: hiddenTask })));

  it('update_note — scopeTaskId (a task id on a note tool)', async () => {
    const mine = await createBrainNote(ctx, { title: 'ref-my-note' });
    await rejectsNotShared(() => updateBrainNote(ctx, mine.id, { scopeTaskId: hiddenTask }));
  });

  it('scratchpad_file — taskId (a task id on a scratchpad tool)', async () => {
    const entry = await createScratchEntry(ctx, { body: 'ref-idea' });
    await rejectsNotShared(() => fileScratchEntry(ctx, entry.id, { taskId: hiddenTask }));
  });

  // The other half, per this card's standing rule: a reference to an id that
  // was never real must stay a plain not_found, or an agent starts asking for
  // access to rows that do not exist.
  it('a referenced id that was never real stays a plain not_found', async () => {
    for (const fn of [
      () => createTask(ctx, { title: 'x', goalId: 'zzzzzzzzzzzz' }),
      () => createBrainNote(ctx, { title: 'n', scopeTaskId: 'zzzzzzzzzzzz' }),
    ]) {
      await assert.rejects(fn, (err: unknown) => {
        assert.ok(err instanceof NotFoundError);
        assert.ok(!(err instanceof NotSharedError), 'missing must not report as not_shared');
        return true;
      });
    }
  });
});


describe('delete_comment — the third object type, which neither guard covers', () => {
  // The two suites above sampled by GUARD: everything reaching
  // assertAccessibleExists, then everything reaching assertAccessibleNoteExists.
  // A census taken from prod's own `tools/list` (32 rows, population from the
  // system rather than from this card's wording) resolves each tool through the
  // call graph to its guard — and delete_comment is the one tool that takes a
  // COMMENT id and therefore reaches neither. It hand-rolled the same
  // conflation both fixes removed: row missing and row-exists-but-not-yours
  // both threw NotFoundError, from two adjacent lines.
  let hiddenComment: string; // on a task ctx cannot see at all
  let othersComment: string; // on a task ctx CAN see, written by someone else

  before(async () => {
    const hiddenTask = await createTask(otherCtx, { title: 'hidden-for-comments' });
    hiddenComment = (await createComment(otherCtx, { taskId: hiddenTask.id, body: 'h' })).id;
    assert.equal(await taskVisibility(ctx, hiddenTask.id), 'hidden');

    const sharedTask = await createTask(otherCtx, { title: 'shared-for-comments' });
    await updateTask(otherCtx, sharedTask.id, { assigneeId: ctx.userId });
    othersComment = (await createComment(otherCtx, { taskId: sharedTask.id, body: 's' })).id;
    assert.equal(await taskVisibility(ctx, sharedTask.id), 'visible');
  });

  // The headline case: the comment's parent task is not shared with this caller.
  it('a comment on an unreachable task reports not_shared, not not_found', () =>
    assert.rejects(
      () => deleteComment(ctx, hiddenComment),
      (err: unknown) => {
        assert.ok(err instanceof NotSharedError, `expected NotSharedError, got ${String(err)}`);
        assert.match(err.message, /do not recreate it/);
        return true;
      },
    ));

  // The other half of the old fused branch, and it is NOT a sharing failure:
  // the caller can read the task and the comment, they just did not write it.
  // Answering this one "not shared" would be the blanket relabel in reverse.
  it("someone else's comment on a task I CAN see is forbidden, not not_shared", () =>
    assert.rejects(
      () => deleteComment(ctx, othersComment),
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError, `expected ForbiddenError, got ${String(err)}`);
        assert.ok(!(err instanceof NotFoundError), 'a readable comment is not a missing one');
        return true;
      },
    ));

  it('a comment id that was never real stays a plain not_found', () =>
    assert.rejects(
      () => deleteComment(ctx, 'zzzzzzzzzzzz'),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError);
        assert.ok(!(err instanceof NotSharedError), 'missing must not report as not_shared');
        return true;
      },
    ));

  it('an already-deleted comment stays a plain not_found', async () => {
    const t = await createTask(ctx, { title: 'mine-for-comment-delete' });
    const c = await createComment(ctx, { taskId: t.id, body: 'gone' });
    await deleteComment(ctx, c.id);
    await assert.rejects(
      () => deleteComment(ctx, c.id),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError);
        assert.ok(!(err instanceof NotSharedError));
        return true;
      },
    );
  });

  // Blast radius: WHO may delete is unchanged by the fix — only the error name
  // on the already-failing path moved. Both successful paths must still pass.
  it('my own comment still deletes', async () => {
    const t = await createTask(ctx, { title: 'mine-author-delete' });
    const c = await createComment(ctx, { taskId: t.id, body: 'x' });
    await deleteComment(ctx, c.id);
    assert.equal((await listCommentsForTask(ctx, t.id)).length, 0);
  });

  it("a comment on MY task written by someone else still deletes (owner path)", async () => {
    const t = await createTask(ctx, { title: 'mine-owner-delete' });
    await updateTask(ctx, t.id, { assigneeId: otherCtx.userId });
    const c = await createComment(otherCtx, { taskId: t.id, body: 'theirs' });
    await deleteComment(ctx, c.id);
    assert.equal((await listCommentsForTask(ctx, t.id)).length, 0);
  });
});

describe('cancel_prompt — the fourth object type, and the guard was BELOW the return', () => {
  // The three suites above moved task, note and comment ids from `not_found` to
  // `not_shared`. A prompt id is the next one an MCP tool accepts — cancel_prompt
  // takes one — and it failed one degree worse than the others: not "the wrong
  // error name", but *no access check at all* on one of its two paths.
  //
  //   if (!row) throw new NotFoundError(id);
  //   if (row.status !== 'pending') return deserialize(row);   // <- returned first
  //   if (row.askedByUserId !== ctx.userId) await assertOwnedExists(...)
  //
  // So the guarded path is the one a test naturally exercises (cancelling a
  // PENDING ask) and the unguarded one is the idempotent early return, which
  // hands back the prompt text and the human's ANSWER. The census that closed
  // the note and comment halves resolved tools to guards; this tool HAS a guard,
  // so it read as covered — being reachable is not the same as being reached.
  let hiddenAnswered: string; // answered prompt, task ctx cannot see
  let hiddenPending: string; // pending prompt, same task
  let visibleCancelled: string; // cancelled prompt on a task ctx CAN see

  before(async () => {
    const hidden = await createTask(otherCtx, { title: 'hidden-for-prompts' });
    assert.equal(await taskVisibility(ctx, hidden.id), 'hidden');
    const answered = await createPrompt(otherCtx, {
      taskId: hidden.id,
      kind: 'text',
      prompt: 'SECRET QUESTION',
    });
    await answerPrompt(otherCtx, answered.id, { text: 'SECRET ANSWER' });
    hiddenAnswered = answered.id;

    // A SECOND hidden task on purpose. A new ask supersedes the old one on the
    // same task, so parking the pending fixture beside the answered one leaves
    // it `cancelled` — and the control that is supposed to stay green under the
    // ablation would then be testing the very path the ablation removes.
    const hidden2 = await createTask(otherCtx, { title: 'hidden-for-prompts-2' });
    const pending = await createPrompt(otherCtx, {
      taskId: hidden2.id,
      kind: 'text',
      prompt: 'still open?',
    });
    hiddenPending = pending.id;
    assert.equal(
      (await listPromptsForTask(otherCtx, hidden2.id)).find((p) => p.id === pending.id)?.status,
      'pending',
    );

    const shared = await createTask(otherCtx, { title: 'shared-for-prompts' });
    await updateTask(otherCtx, shared.id, { assigneeId: ctx.userId });
    const p = await createPrompt(otherCtx, { taskId: shared.id, kind: 'text', prompt: 'ok?' });
    await cancelPrompt(otherCtx, p.id);
    visibleCancelled = p.id;
    assert.equal(await taskVisibility(ctx, shared.id), 'visible');
  });

  // The headline case, and it is a READ leak through a write tool: before the
  // fix this resolved with the question and the answer, not with an error.
  it('an ANSWERED prompt on an unreachable task reports not_shared, not its answer', () =>
    assert.rejects(
      () => cancelPrompt(ctx, hiddenAnswered),
      (err: unknown) => {
        assert.ok(err instanceof NotSharedError, `expected NotSharedError, got ${String(err)}`);
        assert.match(err.message, /do not recreate it/);
        return true;
      },
    ));

  // Must NOT move under the ablation: this path was always guarded, and the
  // fix is only worth anything if it left it alone.
  it('a PENDING prompt on an unreachable task still reports not_shared', () =>
    assert.rejects(
      () => cancelPrompt(ctx, hiddenPending),
      (err: unknown) => {
        assert.ok(err instanceof NotSharedError, `expected NotSharedError, got ${String(err)}`);
        return true;
      },
    ));

  it('a prompt id that was never real stays a plain not_found', () =>
    assert.rejects(
      () => cancelPrompt(ctx, 'zzzzzzzzzzzz'),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError);
        assert.ok(!(err instanceof NotSharedError), 'missing must not report as not_shared');
        return true;
      },
    ));

  // Blast radius, stated as a test rather than as a claim: the guard added is
  // the WEAKEST one (can you reach the task at all), so every caller who could
  // read a non-pending prompt back yesterday still can. This caller is neither
  // the asker nor the task owner — only an assignee — and must still succeed.
  it('an already-cancelled prompt on a task I CAN see is still returned idempotently', async () => {
    const p = await cancelPrompt(ctx, visibleCancelled);
    assert.equal(p.status, 'cancelled');
  });

  it('my own pending prompt still cancels', async () => {
    const t = await createTask(ctx, { title: 'mine-for-prompt-cancel' });
    const p = await createPrompt(ctx, { taskId: t.id, kind: 'text', prompt: 'mine?' });
    assert.equal((await cancelPrompt(ctx, p.id)).status, 'cancelled');
  });
});

describe('delete_attachment — an ATTACHMENT id, and one branch was inaudible', () => {
  // Fifth object type on this card, and a different failure from the other
  // four: deleteAttachment DID distinguish missing from unreachable on both
  // branches. What it did not do was say "forbidden" out loud — the note
  // branch threw a bare `Error`, which both transports drop into the catch-all,
  // so "you are not the owner" reached the wire with the same `error:` prefix
  // as a database outage. The task branch one clause up has thrown
  // ForbiddenError all along; the two branches answer the same question and
  // only one of them was audible.
  let sharedScope: string;
  let theirNoteAttachment: string;

  before(async () => {
    // A note OWNED by other, SCOPED to a task shared with me: I can read it
    // (that is the whole point), and I still may not delete its attachment.
    sharedScope = (await createTask(otherCtx, { title: 'their-project', kind: 'project' })).id;
    await getDb()
      .insert(taskShares)
      .values({ taskId: sharedScope, userId: ctx.userId, createdAt: Date.now() });
    const note = await createBrainNote(otherCtx, {
      title: 'their-note-in-my-reach',
      scopeTaskId: sharedScope,
    });
    assert.equal(await noteVisibility(ctx, note.id), 'visible');
    theirNoteAttachment = (
      await createAttachment(otherCtx, {
        brainNoteId: note.id,
        filename: 'theirs.txt',
        mimeType: 'text/plain',
        body: new Uint8Array([1, 2, 3]),
      })
    ).id;
  });

  it("someone else's note attachment I CAN see is forbidden, not a bare error", async () => {
    await assert.rejects(
      () => deleteAttachment(ctx, theirNoteAttachment),
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError, `expected ForbiddenError, got ${String(err)}`);
        // The wire string is the thing the caller actually reads.
        assert.ok(mcpErrorText(err).startsWith('forbidden: '), mcpErrorText(err));
        assert.match(err.message, /^Note /);
        return true;
      },
    );
  });

  // Must NOT move under the ablation: the distinguishing half was already
  // correct here, and a change that quietly broke it would be worse than the
  // defect it fixed.
  it('an attachment id that was never real stays a plain not_found', async () => {
    await assert.rejects(() => deleteAttachment(ctx, 'zzzzzzzzzzzz'), (err: unknown) => {
      assert.ok(err instanceof NotFoundError, `expected NotFoundError, got ${String(err)}`);
      assert.ok(!(err instanceof NotSharedError));
      return true;
    });
  });

  it('the owner can still delete their own attachment — authorization is untouched', async () => {
    const mine = await createTask(ctx, { title: 'mine-with-a-file' });
    const att = await createAttachment(ctx, {
      taskId: mine.id,
      filename: 'mine.txt',
      mimeType: 'text/plain',
      body: new Uint8Array([9]),
    });
    await deleteAttachment(ctx, att.id);
    assert.equal((await listAttachments(ctx, mine.id)).length, 0);
  });
});

describe('the COLLECTION partition — a hidden filter id answered with the SUCCESS shape', () => {
  // Every suite above this one covers a tool that FAILS on a hidden id, and
  // asks which error it fails with. The tools here do not fail at all: they
  // answer `[]`. That is strictly worse for the reader — `not_found: Task X not
  // found` at least reports a failure, whereas `[]` reports "here are the
  // children: none," which is the duplicate-creating conclusion this card
  // exists to stop, stated in the success shape.
  //
  // Measured before the fix, all three worlds gave one answer:
  //   list_tasks(parentId=hidden-WITH-children)  []
  //   list_tasks(parentId=never-real)            []
  //   list_tasks(parentId=mine-but-childless)    []
  let hiddenParent: string;
  let hiddenScope: string;
  let hiddenNote: string;

  before(async () => {
    hiddenParent = (await createTask(otherCtx, { title: 'coll-hidden-parent', kind: 'project' })).id;
    await createTask(otherCtx, { title: 'coll-hidden-child', parentId: hiddenParent });
    hiddenScope = (await createTask(otherCtx, { title: 'coll-hidden-scope', kind: 'project' })).id;
    hiddenNote = (await createBrainNote(otherCtx, { title: 'coll-hidden-note', scopeTaskId: hiddenScope })).id;
    // The fixtures really are hidden-and-populated, not merely absent-and-empty.
    assert.equal(await taskVisibility(ctx, hiddenParent), 'hidden');
    assert.equal(await taskVisibility(ctx, hiddenScope), 'hidden');
    assert.equal(await noteVisibility(ctx, hiddenNote), 'hidden');
    assert.equal((await listTasks(otherCtx, { parentId: hiddenParent })).length, 1, 'owner sees the child');
  });

  const rejectsNotShared = (fn: () => Promise<unknown>) =>
    assert.rejects(fn, (err: unknown) => {
      assert.ok(err instanceof NotSharedError, `expected NotSharedError, got ${String(err)}`);
      assert.match(err.message, /do not recreate it/);
      return true;
    });

  it('list_tasks — parentId', () => rejectsNotShared(() => listTasks(ctx, { parentId: hiddenParent })));

  it('list_notes — scopeTaskId (a TASK id on a note tool)', () =>
    rejectsNotShared(() => listBrainNotes(ctx, { scopeTaskId: hiddenScope })));

  it('list_notes — parentNoteId (a NOTE id, so a NotSharedNoteError)', () =>
    assert.rejects(
      () => listBrainNotes(ctx, { parentNoteId: hiddenNote }),
      (err: unknown) => {
        assert.ok(err instanceof NotSharedNoteError, `expected NotSharedNoteError, got ${String(err)}`);
        assert.match(err.message, /do not recreate it/);
        return true;
      },
    ));

  it('search_notes — scopeTaskId', () =>
    rejectsNotShared(() => searchBrainNotes(ctx, 'anything', { scopeTaskId: hiddenScope })));

  // search_notes has two early returns above its query, and both emit the same
  // `[]`. A guard sitting only after the query would be dead on exactly the
  // caller most likely to hit this — one who owns no notes at all.
  it('search_notes — the guard is not below the early returns (empty query)', () =>
    rejectsNotShared(() => searchBrainNotes(ctx, '   ', { scopeTaskId: hiddenScope })));

  // The half that stops this being a blanket relabel, in three directions.
  it('a never-real filter id still answers [] — not not_shared', async () => {
    assert.deepEqual(await listTasks(ctx, { parentId: 'zzzNEVERREAL9' }), []);
    assert.deepEqual(await listBrainNotes(ctx, { scopeTaskId: 'zzzNEVERREAL9' }), []);
  });

  it('a visible but genuinely childless parent still answers []', async () => {
    const mine = await createTask(ctx, { title: 'coll-mine-childless', kind: 'project' });
    assert.deepEqual(await listTasks(ctx, { parentId: mine.id }), []);
    assert.deepEqual(await listBrainNotes(ctx, { scopeTaskId: mine.id }), []);
  });

  // THE control the empty-result-only ordering exists for. Ancestors are not
  // reachable, so being assigned one child does NOT open its parent — and
  // `list_tasks(parentId=<that unreachable parent>)` legitimately returns rows
  // today. An argument-position guard would have turned this working query into
  // an error; guarding on the empty result cannot.
  it('a hidden parent whose child IS shared with me still returns that child', async () => {
    const parent = await createTask(otherCtx, { title: 'coll-hidden-parent-2' });
    const child = await createTask(otherCtx, { title: 'coll-visible-child', parentId: parent.id });
    await updateTask(otherCtx, child.id, { assigneeId: ctx.userId });
    assert.equal(await taskVisibility(ctx, parent.id), 'hidden', 'parent stays unreachable');
    const rows = await listTasks(ctx, { parentId: parent.id });
    assert.deepEqual(rows.map((r) => r.id), [child.id], 'the reachable child is still listed');
  });

  // The join the other suites do not run: a class asserted here is not what the
  // agent reads. A LIST tool reaching the wire as not_shared is a second claim
  // on top of "it throws the right class", and it is the one that matters.
  it('reaches the caller as the not_shared WIRE prefix, not just the right class', async () => {
    const err = await listTasks(ctx, { parentId: hiddenParent }).then(
      () => null,
      (e: unknown) => e,
    );
    const text = mcpErrorText(err);
    assert.ok(text.startsWith('not_shared: '), text);
    assert.match(text, /do not recreate it/);
  });

  it('parentId=null / "top of my view" is untouched', async () => {
    const roots = await listTasks(ctx, { parentId: null });
    assert.ok(Array.isArray(roots), 'a null parent is not an id and must never be guarded');
  });

  // The DOCUMENTATION half, joined to the behaviour half inside ONE test.
  //
  // Every assertion above is about what the code DOES. The agent on the other
  // end of the wire reads the tool DESCRIPTION — and this card's deploy marker
  // matches on that same string, so a tool can be fully guarded, fully tested,
  // and still invisible to the gauge that reports the fix as shipped.
  // `search_notes` was exactly that for a day: guard at brain.ts:393, two cases
  // in this very suite, and no sentence.
  //
  // The covered set is NOT hand-typed: each row earns its place by actually
  // rejecting first. A tool that stops throwing drops out of the documentation
  // assertion instead of silently passing it.
  it('every collection tool that THROWS not_shared also SAYS so in its description', async () => {
    const probes: Array<[string, () => Promise<unknown>]> = [
      ['list_tasks', () => listTasks(ctx, { parentId: hiddenParent })],
      ['list_notes', () => listBrainNotes(ctx, { scopeTaskId: hiddenScope })],
      ['search_notes', () => searchBrainNotes(ctx, 'anything', { scopeTaskId: hiddenScope })],
    ];
    const undocumented: string[] = [];
    for (const [name, probe] of probes) {
      const err = await probe().then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(
        err instanceof NotSharedError || err instanceof NotSharedNoteError,
        `${name}: expected a not_shared rejection to license the description check, got ${String(err)}`,
      );
      const tool = findTool(name);
      assert.ok(tool, `${name}: not in TOOLS`);
      if (!tool.description.includes('not_shared')) undocumented.push(name);
    }
    assert.deepEqual(undocumented, [], `guarded but undocumented: ${undocumented.join(', ')}`);

    // NEG-CTL — the matcher CAN report a tool as undocumented. `move_task` is a
    // write path carrying no such sentence, so the empty list above is a fact
    // about these three tools, not "every description contains the string".
    assert.ok(
      !findTool('move_task')!.description.includes('not_shared'),
      'NEG-CTL broke: move_task now mentions not_shared, so this matcher proves nothing',
    );
  });

  // ── The half the guard above does NOT cover, pinned so it cannot be forgotten ──
  //
  // `assertFilterIdNotHidden` fires only on an EMPTY result — deliberately, so
  // a caller assigned one child of a hidden parent keeps working. The cost is
  // that a NON-EMPTY list omits unshared rows in total silence: no error, no
  // marker, and the answer looks complete.
  //
  // This is not hypothetical and it is not a future agent's problem. On
  // 2026-09-14 the agent working this very card called
  // `list_tasks(status="review")`, got 11 rows against a workspace holding 12,
  // and published the 11 as a denominator — inside the same receipt that
  // described the `[]` defect. A short list reads as an answer; `[]` at least
  // reads as nothing. There is no row-level fix (the point of share-scoping is
  // that the row is invisible), so the mitigation is a sentence at the call
  // site — and a sentence with no test is a sentence that gets edited away.
  it('a NON-EMPTY share-scoped list omits rows silently — no error, no marker', async () => {
    // Both carry a description because `status: "review"` is refused without
    // context ("Review needs a question") — an unrelated rule, but it means the
    // fixture cannot be built by title alone.
    const mine = await createTask(ctx, {
      title: 'scoped-count-mine',
      status: 'review',
      description: 'in my view',
    });
    const theirs = await createTask(otherCtx, {
      title: 'scoped-count-theirs',
      status: 'review',
      description: 'never shared with ctx',
    });

    const mineRows = await listTasks(ctx, { status: 'review', deep: true });
    const theirRows = await listTasks(otherCtx, { status: 'review', deep: true });
    const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

    // POS-CTL — the reader is working: each caller does see their own row.
    assert.ok(ids(mineRows).includes(mine.id), 'POS-CTL: my own review task must be listed');
    assert.ok(ids(theirRows).includes(theirs.id), "POS-CTL: the other caller sees their own row");

    // The defect, in the success shape: a row exists, is `review`, and is
    // absent from my list — and the call resolved rather than throwing.
    assert.equal(await taskVisibility(ctx, theirs.id), 'hidden', 'fixture really is hidden from me');
    assert.ok(!ids(mineRows).includes(theirs.id), 'the unshared review task is omitted');
    assert.ok(mineRows.length > 0, 'and the omission happens on a NON-EMPTY list, so no guard fires');
  });

  it('list_tasks DOCUMENTS that its count is share-scoped', () => {
    const desc = findTool('list_tasks')!.description;
    assert.match(desc, /COUNTING/, 'the counting caveat must survive description edits');
    assert.match(desc, /share-scoped/);
    assert.match(desc, /not a count of the world/);

    // NEG-CTL — the matcher can miss. `get_task` answers about ONE row, so the
    // share-scoped-count caveat does not belong there and must not be present;
    // if it ever is, this assertion stops proving anything about list_tasks.
    assert.ok(
      !findTool('get_task')!.description.includes('not a count of the world'),
      'NEG-CTL broke: get_task now carries the counting caveat, so this matcher proves nothing',
    );
  });
});

describe('the EXPENSIVE-HAPPY-PATH partition — the three tools every suite skipped', () => {
  // Censused 2026-09-13 over the 32 tools `tools/list` actually enumerates: 29
  // take at least one id-shaped argument, and every one of them is pinned by
  // some suite EXCEPT three — `attach_file_from_url`, `create_upload` and
  // `finalize_upload`. Zero assertions anywhere in packages/ pass any of them an
  // unreachable id; `grep -rn addAttachmentFromUrl|createUploadTicket|
  // finalizeUpload *.test.ts` returned 0 lines before this block.
  //
  // They are not the riskiest tools. They are the three whose HAPPY path needs
  // network or object storage, so every suite that wanted a cheap fixture
  // reached for their cheap sibling `attach_file` instead — which is pinned, at
  // :932, one `it()` away from here. The gap tracks TEST COST, not risk.
  //
  // And the cost was never real for this question: the access check is supposed
  // to run BEFORE the expensive part, so the hidden-id case never touches the
  // network or the store at all. The expensive precondition belongs to the
  // happy path only, and it was allowed to exclude the cheap negative case too.
  let hidden: string;
  let hiddenNote: string;
  let mine: string;
  let realFetch: typeof globalThis.fetch;
  let fetchCalls: string[];

  before(async () => {
    hidden = (await createTask(otherCtx, { title: 'expensive-path-hidden' })).id;
    mine = (await createTask(ctx, { title: 'expensive-path-mine' })).id;
    hiddenNote = (
      await createBrainNote(otherCtx, { title: 'expensive-path-hidden-note' })
    ).id;
    // Both fixtures asserted hidden BEFORE any case runs — a suite over a
    // fixture that is merely absent proves the wrong thing.
    assert.equal(await taskVisibility(ctx, hidden), 'hidden');
    assert.equal(await noteVisibility(ctx, hiddenNote), 'hidden');
  });

  beforeEach(() => {
    // The stub records every outbound request and then FAILS, which is what
    // makes the ordering visible: if the access check ran last, these cases
    // would reject with "Fetch failed" and never mention access at all.
    fetchCalls = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      fetchCalls.push(String(input));
      return new Response('nope', { status: 404, statusText: 'Not Found' });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const rejectsNotShared = (fn: () => Promise<unknown>) =>
    assert.rejects(fn, (err: unknown) => {
      assert.ok(err instanceof NotSharedError, `expected NotSharedError, got ${String(err)}`);
      assert.match(err.message, /do not recreate it/);
      return true;
    });

  const rejectsNotSharedNote = (fn: () => Promise<unknown>) =>
    assert.rejects(fn, (err: unknown) => {
      assert.ok(
        err instanceof NotSharedNoteError,
        `expected NotSharedNoteError, got ${String(err)}`,
      );
      assert.match(err.message, /do not recreate it/);
      return true;
    });

  const URL_OK = 'https://example.invalid/x.txt';

  it('attach_file_from_url — taskId', () =>
    rejectsNotShared(() => addAttachmentFromUrl(ctx, { taskId: hidden }, URL_OK)));

  it('attach_file_from_url — noteId', () =>
    rejectsNotSharedNote(() => addAttachmentFromUrl(ctx, { brainNoteId: hiddenNote }, URL_OK)));

  // THE FINDING, as the assertion that fails if the hoist is reverted. Before
  // 2026-09-13 this tool fetched first and resolved the parent last, so the
  // answer for one hidden id depended on a second, unrelated argument: a
  // fetchable URL gave `not_shared`, an unfetchable one gave `Fetch failed:
  // 404`. That is this card's defect inside a SINGLE tool.
  it('...and the access verdict is not masked by the URL being unfetchable', async () => {
    await rejectsNotShared(() => addAttachmentFromUrl(ctx, { taskId: hidden }, URL_OK));
    assert.deepEqual(
      fetchCalls,
      [],
      'the server performed an outbound GET for a caller who cannot see the target',
    );
  });

  it('...and the same holds for a hidden NOTE', async () => {
    await rejectsNotSharedNote(() =>
      addAttachmentFromUrl(ctx, { brainNoteId: hiddenNote }, URL_OK),
    );
    assert.deepEqual(fetchCalls, []);
  });

  it('create_upload — taskId', () =>
    rejectsNotShared(() =>
      createUploadTicket(ctx, {
        taskId: hidden,
        filename: 'a.txt',
        mimeType: 'text/plain',
        sizeBytes: 3,
      }),
    ));

  it('create_upload — noteId', () =>
    rejectsNotSharedNote(() =>
      createUploadTicket(ctx, {
        brainNoteId: hiddenNote,
        filename: 'a.txt',
        mimeType: 'text/plain',
        sizeBytes: 3,
      }),
    ));

  it('finalize_upload — taskId', () =>
    rejectsNotShared(() =>
      finalizeUpload(ctx, {
        attachmentId: nanoid(12),
        taskId: hidden,
        filename: 'a.txt',
        mimeType: 'text/plain',
        sizeBytes: 3,
      }),
    ));

  it('finalize_upload — noteId', () =>
    rejectsNotSharedNote(() =>
      finalizeUpload(ctx, {
        attachmentId: nanoid(12),
        brainNoteId: hiddenNote,
        filename: 'a.txt',
        mimeType: 'text/plain',
        sizeBytes: 3,
      }),
    ));

  // ── the controls that keep this from being a blanket relabel ──────────────
  it('a never-real taskId on all three stays a plain not_found', async () => {
    const notShared = (err: unknown) => {
      assert.ok(err instanceof NotFoundError, `expected NotFoundError, got ${String(err)}`);
      assert.ok(!(err instanceof NotSharedError), 'missing must not report as not_shared');
      return true;
    };
    await assert.rejects(
      () => addAttachmentFromUrl(ctx, { taskId: 'zzzzzzzzzzzz' }, URL_OK),
      notShared,
    );
    await assert.rejects(
      () =>
        createUploadTicket(ctx, {
          taskId: 'zzzzzzzzzzzz',
          filename: 'a.txt',
          mimeType: 'text/plain',
          sizeBytes: 3,
        }),
      notShared,
    );
    await assert.rejects(
      () =>
        finalizeUpload(ctx, {
          attachmentId: nanoid(12),
          taskId: 'zzzzzzzzzzzz',
          filename: 'a.txt',
          mimeType: 'text/plain',
          sizeBytes: 3,
        }),
      notShared,
    );
  });

  // The POS-CTL for the fetch counter. Without this, `fetchCalls == []` above
  // is satisfied by a stub that was never installed, or by a tool that stopped
  // fetching entirely — a control that cannot fire certifies whatever sits
  // next to it.
  it('POS-CTL: a REACHABLE target does reach the fetch, so the counter can fire', async () => {
    await assert.rejects(
      () => addAttachmentFromUrl(ctx, { taskId: mine }, URL_OK),
      /Fetch failed: 404/,
      'a caller who CAN see the task must get past the guard and hit the network',
    );
    assert.deepEqual(fetchCalls, [URL_OK], 'the stub must have been reached exactly once');
  });
});
