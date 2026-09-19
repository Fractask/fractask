import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq, and } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from './db/client.js';
import { createTask, listTasks } from './tasks.js';
import { materializeRecurrences } from './recurrence-cron.js';
import { taskComments, tasks, users } from './schema.js';
import type { Context } from './context.js';
import { nanoid } from 'nanoid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;
let ctx: Context;

// 2026-07-29 is a Wednesday. "now" = 12:00 Israel that day.
const NOW = Date.UTC(2026, 6, 29, 9, 0, 0);
const WED_9AM = Date.UTC(2026, 6, 29, 6, 0, 0); // 09:00 Israel, same day, earlier than NOW

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-cron-'));
  process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
  process.env['HOME'] = tmpDir;
  const db = getDb();
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  ctx = { userId: nanoid(12) };
  await db.insert(users).values({ id: ctx.userId, email: null, name: 'me', googleId: null, image: null, createdAt: NOW });
});

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('materializeRecurrences', () => {
  it('spawns a deliverable instance for today and rolls the template forward', async () => {
    const tpl = await createTask(ctx, {
      title: 'Daily IG post',
      recurrence: 'weekdays',
      recurrenceMode: 'deliverable',
      dueAt: WED_9AM,
    });

    const res = await materializeRecurrences(NOW);
    assert.equal(res.spawned, 1);
    assert.equal(res.rolled, 1);

    const children = await listTasks(ctx, { parentId: tpl.id });
    assert.equal(children.length, 1);
    const inst = children[0]!;
    assert.equal(inst.title, 'Daily IG post');
    assert.equal(inst.status, 'open');
    assert.equal(inst.recurrence, null); // instance is not itself recurring
    assert.ok(inst.occurrenceDate && inst.occurrenceDate <= WED_9AM); // start-of-day for Wed

    // template rolled to Thursday (next weekday), strictly in the future
    const db = getDb();
    const rolled = (await db.select().from(tasks).where(eq(tasks.id, tpl.id)))[0]!;
    assert.ok(rolled.dueAt! > NOW);
  });

  it('is idempotent — a second run spawns nothing new for the same day', async () => {
    const before = (await getDb().select().from(tasks)).length;
    const res = await materializeRecurrences(NOW);
    assert.equal(res.spawned, 0);
    const afterCount = (await getDb().select().from(tasks)).length;
    assert.equal(afterCount, before);
  });

  it('age-archives a done instance older than the default 7 days', async () => {
    const db = getDb();
    // A done instance completed 10 days ago.
    const old = Date.UTC(2026, 6, 19, 9, 0, 0);
    await db.insert(tasks).values({
      id: nanoid(12), userId: ctx.userId, title: 'old post', description: null,
      status: 'done', kind: 'task', rules: null, parentId: null, position: 0, source: 'agent',
      dueAt: old, assigneeId: null, reviewerId: null, recurrence: null, recurrenceMode: 'checkbox',
      occurrenceDate: old, priority: null, createdAt: old, updatedAt: old, completedAt: old,
    });
    await materializeRecurrences(NOW);
    const rows = await db.select().from(tasks).where(and(eq(tasks.title, 'old post')));
    assert.equal(rows[0]!.status, 'archived');
  });

  it('spawns occurrences carrying the template assignee and reviewer', async () => {
    const db = getDb();
    const assignee = nanoid(12);
    const reviewer = nanoid(12);
    for (const id of [assignee, reviewer]) {
      await db.insert(users).values({ id, email: null, name: id, googleId: null, image: null, createdAt: NOW });
    }
    const tpl = await createTask(ctx, {
      title: 'Post Kitkoo social — daily',
      recurrence: '1d',
      recurrenceMode: 'deliverable',
      dueAt: WED_9AM,
      assigneeId: assignee,
      reviewerId: reviewer,
    });

    const res = await materializeRecurrences(NOW);
    assert.equal(res.spawned, 1);

    const children = await listTasks(ctx, { parentId: tpl.id });
    assert.equal(children.length, 1);
    // The whole bug: an occurrence that lands in nobody's queue.
    assert.equal(children[0]!.assigneeId, assignee);
    assert.equal(children[0]!.reviewerId, reviewer);
  });

  it('back-fills a live occurrence that lost its assignee, and leaves done ones alone', async () => {
    const db = getDb();
    const assignee = nanoid(12);
    await db.insert(users).values({ id: assignee, email: null, name: assignee, googleId: null, image: null, createdAt: NOW });
    const tpl = await createTask(ctx, {
      title: 'Daily outreach',
      recurrence: '1d',
      recurrenceMode: 'deliverable',
      dueAt: WED_9AM,
      assigneeId: assignee,
    });

    // Two pre-existing ownerless occurrences: one still in flight (approved but
    // parked in review — the shape Jibin found), one already done.
    const day = Date.UTC(2026, 6, 27, 0, 0, 0);
    const base = {
      userId: ctx.userId, description: null, kind: 'task' as const, rules: null,
      parentId: tpl.id, position: 0, source: 'agent' as const, dueAt: day,
      assigneeId: null, reviewerId: null, recurrence: null, recurrenceMode: 'checkbox' as const,
      priority: null, createdAt: day, updatedAt: day, completedAt: null,
    };
    const stalled = nanoid(12);
    const finished = nanoid(12);
    await db.insert(tasks).values({ ...base, id: stalled, title: 'stalled', status: 'review', occurrenceDate: day });
    await db.insert(tasks).values({
      ...base, id: finished, title: 'finished', status: 'done',
      occurrenceDate: Date.UTC(2026, 6, 28, 0, 0, 0), completedAt: NOW,
    });

    const res = await materializeRecurrences(NOW);
    assert.equal(res.repaired, 1);

    const after = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
    assert.equal((await after(stalled)).assigneeId, assignee);
    assert.equal((await after(finished)).assigneeId, null);
  });

  it('does not touch occurrences of a template that has no assignee', async () => {
    const tpl = await createTask(ctx, {
      title: 'Unowned daily',
      recurrence: '1d',
      recurrenceMode: 'deliverable',
      dueAt: WED_9AM,
    });
    const res = await materializeRecurrences(NOW);
    const children = await listTasks(ctx, { parentId: tpl.id });
    assert.ok(children.length >= 1);
    assert.equal(children[0]!.assigneeId, null);
    assert.equal(res.repaired, 0);
  });
});

describe('the backpressure guard — card NxaXw3oBX3Wd part 1', () => {
  const db = () => getDb();
  const SKIP_MARKER = '<!-- recurrence:skipped-occurrence -->';
  const notes = async (taskId: string) =>
    db().select().from(taskComments).where(eq(taskComments.taskId, taskId));
  // materializeRecurrences is system-wide and this file's earlier tests leave
  // their own templates behind, so the returned counters are FLEET totals, not
  // this template's. Every assertion below is scoped to `tpl` for that reason;
  // reading res.spawned here would be counting other tests' work.
  const kids = async (parentId: string) => listTasks(ctx, { parentId });

  // NOW is Wed; run the cron on Thu so the template owes a second day.
  const THU = Date.UTC(2026, 6, 30, 9, 0, 0);
  const FRI = Date.UTC(2026, 6, 31, 9, 0, 0);

  it('skips the next occurrence while the previous one is still in flight — and the positive control spawns', async () => {
    const tpl = await createTask(ctx, {
      title: 'Post Verikal social content — daily',
      recurrence: '1d',
      recurrenceMode: 'deliverable',
      dueAt: WED_9AM,
    });

    // Day 1: nothing in flight, so it spawns. This is the control arm — same
    // template, same cron, same code path; the ONLY thing that differs on the
    // next run is whether yesterday's child is still open.
    await materializeRecurrences(NOW);
    const afterDay1 = await kids(tpl.id);
    assert.equal(afterDay1.length, 1);
    const wed = afterDay1[0]!;
    assert.equal(wed.status, 'open');

    // Day 2: yesterday's is still open.
    await materializeRecurrences(THU);
    assert.equal((await kids(tpl.id)).length, 1, 'no second front while day 1 is open');

    // The miss is visible, on the template, naming the blocker.
    const posted = await notes(tpl.id);
    assert.equal(posted.length, 1);
    assert.ok(posted[0]!.body.includes(SKIP_MARKER));
    assert.ok(posted[0]!.body.includes(wed.id), 'the note names the occurrence that blocked it');
    assert.ok(posted[0]!.body.includes('2026-07-30'), 'the note names the day that was skipped');
    assert.equal(posted[0]!.source, 'agent');

    // Skipped, not queued: the template still tracks the calendar.
    const rolledTo = (await db().select().from(tasks).where(eq(tasks.id, tpl.id)))[0]!.dueAt!;
    assert.ok(rolledTo > THU, 'dueAt rolled past the skipped day');

    // ABLATION: close the blocker, change nothing else, run the same cron one
    // day on. If the skip had any other cause, this stays at one child.
    await db().update(tasks).set({ status: 'done' }).where(eq(tasks.id, wed.id));
    await materializeRecurrences(FRI);
    assert.equal(
      (await kids(tpl.id)).length,
      2,
      'control: with nothing in flight the same template spawns again',
    );
    assert.equal((await notes(tpl.id)).length, 1, 'and posts no new skip note');
  });

  it('review counts as in flight, and the note is posted once, not once per run', async () => {
    const tpl = await createTask(ctx, {
      title: 'Daily write-up',
      recurrence: '1d',
      recurrenceMode: 'deliverable',
      dueAt: WED_9AM,
    });
    await materializeRecurrences(NOW);
    const child = (await kids(tpl.id))[0]!;

    // Parked awaiting approval — done as far as the agent is concerned, and
    // exactly the state the four duplicate social cards were found in.
    await db().update(tasks).set({ status: 'review' }).where(eq(tasks.id, child.id));

    await materializeRecurrences(THU);
    assert.equal((await kids(tpl.id)).length, 1, 'review blocks the spawn too');
    assert.equal((await notes(tpl.id)).length, 1);

    // Re-run the same occurrence day. The roll normally makes this
    // unreachable; force it back so the idempotency guard is what is tested.
    await db().update(tasks).set({ dueAt: WED_9AM }).where(eq(tasks.id, tpl.id));
    await materializeRecurrences(THU);
    assert.equal((await kids(tpl.id)).length, 1);
    assert.equal((await notes(tpl.id)).length, 1, 'the same skip is not re-announced');
  });
});
