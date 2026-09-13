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
import { tasks, users } from './schema.js';
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
