import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from './db/client.js';
import {
  CycleError,
  NotFoundError,
  createTask,
  deleteTask,
  getSubtree,
  getTask,
  listTasks,
  moveTask,
  updateTask,
} from './tasks.js';
import { taskShares, users } from './schema.js';
import type { Context } from './context.js';
import { nanoid } from 'nanoid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let ctx: Context;
let otherCtx: Context;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-tasks-'));
  process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
  process.env['HOME'] = tmpDir;

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

    await updateTask(ctx, t1.id, { status: 'review' });
    await updateTask(ctx, t2.id, { status: 'review' });

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
