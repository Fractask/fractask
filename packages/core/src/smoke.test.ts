import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from './db/client.js';
import { tasks } from './schema.js';
import type { Context } from './context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-smoke-'));
  const tmpDb = path.join(tmpDir, 'db.sqlite');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-home-'));

  process.env['GETSHIT_DB_URL'] = `file:${tmpDb}`;
  process.env['HOME'] = tmpHome;

  const db = getDb();
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../drizzle') });

  // Lazy-import bootstrap so it picks up the patched HOME env var.
  const { getCurrentUser } = await import('./bootstrap.js');
  const user = await getCurrentUser();
  assert.equal(typeof user.id, 'string');
  assert.equal(user.id.length, 12);

  // Re-invoking returns the same user (config persisted).
  const again = await getCurrentUser();
  assert.equal(again.id, user.id);

  const ctx: Context = { userId: user.id };

  // Insert a task scoped to this user, query it back through Context.
  const taskId = nanoid(12);
  const now = Date.now();
  await db.insert(tasks).values({
    id: taskId,
    userId: ctx.userId,
    title: 'first task',
    status: 'open',
    position: 0,
    source: 'human',
    createdAt: now,
    updatedAt: now,
  });

  const fetched = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, ctx.userId)));

  assert.equal(fetched.length, 1);
  assert.equal(fetched[0]?.title, 'first task');
  assert.equal(fetched[0]?.userId, ctx.userId);

  // A query for the same task under a different userId must return nothing.
  const otherUser = nanoid(12);
  const leak = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, otherUser)));
  assert.equal(leak.length, 0, 'tenant isolation: task must not leak across userIds');

  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
  console.log('smoke test passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
