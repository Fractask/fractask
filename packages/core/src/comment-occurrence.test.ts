import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { closeDb, getDb } from './db/client.js';
import { createTask } from './tasks.js';
import { createComment } from './comments.js';
import { dayStartInTz } from './recurrence.js';
import { taskCompletions, tasks, users } from './schema.js';
import type { Context } from './context.js';

/**
 * Card `NxaXw3oBX3Wd`, part 2: a `✅ <YYYY-MM-DD>` comment on a `checkbox`
 * recurring task counts that occurrence done — roll dueAt, stamp the streak,
 * no status change, no child.
 *
 * The pairs matter more than the positives here. Every "it rolled" assertion
 * below has a sibling that differs in exactly one thing (where the ✅ sits,
 * whether the task recurs, whether the occurrence has come round) and must NOT
 * roll — otherwise the test only proves the code runs, not that it discriminates.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;
let ctx: Context;

const DAY = 86_400_000;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-comment-occ-'));
  process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
  process.env['HOME'] = tmpDir;
  const db = getDb();
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  ctx = { userId: nanoid(12) };
  await db.insert(users).values({
    id: ctx.userId, email: null, name: 'me', googleId: null, image: null, createdAt: Date.now(),
  });
});

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const row = async (id: string) => (await getDb().select().from(tasks).where(eq(tasks.id, id)))[0]!;
const completions = async (id: string) =>
  getDb().select().from(taskCompletions).where(eq(taskCompletions.taskId, id));

/** A standing daily card whose occurrence is already overdue. */
async function standing(title: string, overrides: Record<string, unknown> = {}) {
  return createTask(ctx, {
    title,
    recurrence: '1d',
    dueAt: Date.now() - 2 * DAY,
    ...overrides,
  });
}

describe('✅ <date> comment closes an occurrence — card NxaXw3oBX3Wd part 2', () => {
  it('rolls dueAt, logs the completion, and changes nothing else', async () => {
    const t = await standing('Daily standup — website-builder');
    const before = await row(t.id);

    await createComment(ctx, {
      taskId: t.id,
      body: '✅ 2026-09-19 — https://example.com/standup\n\nfiled.',
      source: 'agent',
    });

    const afterRow = await row(t.id);
    assert.equal(afterRow.dueAt! - before.dueAt!, DAY, 'exactly one interval, not more');
    assert.equal(afterRow.status, before.status, 'no status change');
    assert.equal(afterRow.completedAt, null, 'the card is not completed, the occurrence is');

    const log = await completions(t.id);
    assert.equal(log.length, 1, 'the streak is stamped');
    // The claimed DAY, not the board's dueAt instant — see comments.ts for why
    // the moving field cannot be the identity of a fixed occurrence.
    assert.equal(log[0]!.occurrenceAt, dayStartInTz('2026-09-19'));
    assert.equal(log[0]!.completedByUserId, ctx.userId);
    assert.equal(log[0]!.source, 'agent');
  });

  it('does NOT fire on a ✅ that is not at the start — the discriminating pair', async () => {
    const t = await standing('Daily health check');
    const before = await row(t.id);

    // This lane's receipts are full of mid-body tick marks. A matcher that
    // found this one would roll the due date off a passing sub-check.
    await createComment(ctx, {
      taskId: t.id,
      body: 'Ran the sweep:\n\n- ✅ 2026-09-19 prod 200\n- 🔴 tracking still red',
      source: 'agent',
    });

    assert.equal((await row(t.id)).dueAt, before.dueAt, 'dueAt untouched');
    assert.equal((await completions(t.id)).length, 0, 'nothing stamped');
  });

  it('does NOT fire on a ✅ with no date, nor on a non-recurring task', async () => {
    const t = await standing('Daily with a bare tick');
    const before = await row(t.id);
    await createComment(ctx, { taskId: t.id, body: '✅ done for today', source: 'agent' });
    assert.equal((await row(t.id)).dueAt, before.dueAt);
    assert.equal((await completions(t.id)).length, 0);

    // Same body, same shape, only `recurrence` differs. This is what selects.
    const one = await createTask(ctx, { title: 'One-off', dueAt: Date.now() - 2 * DAY });
    await createComment(ctx, { taskId: one.id, body: '✅ 2026-09-19 shipped', source: 'agent' });
    assert.equal((await row(one.id)).dueAt, one.dueAt, 'a one-off has no occurrence to consume');
    assert.equal((await completions(one.id)).length, 0);
  });

  it('consumes one occurrence per occurrence, not one per hourly receipt', async () => {
    const t = await standing('Hourly-visited standing card');
    await createComment(ctx, { taskId: t.id, body: '✅ 2026-09-19 first', source: 'agent' });
    const afterFirst = await row(t.id);

    // The runner visits again the same hour and posts the same receipt. This
    // is the date-pump shape that pushed seven cards into 2027.
    await createComment(ctx, { taskId: t.id, body: '✅ 2026-09-19 again', source: 'agent' });
    await createComment(ctx, { taskId: t.id, body: '✅ 2026-09-19 and again', source: 'agent' });

    assert.equal((await row(t.id)).dueAt, afterFirst.dueAt, 'dueAt moved once');
    assert.equal((await completions(t.id)).length, 1, 'one occurrence, one completion row');
  });

  it('logs but does not advance an occurrence that has not come round — the shared clamp', async () => {
    // Same clamp the tick path uses (rollRecurrence). If this rolled, the
    // ✅ route would be a second door into the bug the tick path was fixed for.
    const t = await standing('Card whose dueAt is already 10 days out', {
      dueAt: Date.now() + 10 * DAY,
    });
    const before = await row(t.id);

    await createComment(ctx, { taskId: t.id, body: '✅ 2026-09-19 filed', source: 'agent' });

    assert.equal((await row(t.id)).dueAt, before.dueAt, 'premature: dueAt held where it was');
    assert.equal((await completions(t.id)).length, 1, 'attendance is still recorded truthfully');
  });

  it('leaves a deliverable template alone — its instances are what get completed', async () => {
    const t = await standing('Deliverable template', { recurrenceMode: 'deliverable' });
    const before = await row(t.id);
    await createComment(ctx, { taskId: t.id, body: '✅ 2026-09-19 posted', source: 'agent' });
    assert.equal((await row(t.id)).dueAt, before.dueAt);
    assert.equal((await completions(t.id)).length, 0);
  });
});
