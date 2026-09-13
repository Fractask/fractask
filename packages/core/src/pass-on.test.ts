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
  createPrompt,
  HumanResolutionRequiredError,
  listPromptsForTask,
  passPromptOn,
  passTaskOn,
} from './prompts.js';
import { listCommentsForTask } from './comments.js';
import { listFocusEvents } from './focus.js';
import type { Context } from './context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let ctx: Context; // human owner
let askerCtx: Context; // agent that asked
let triageCtx: Context; // agent the question is passed to

const packaged = {
  deck: [{ kind: 'text' as const, body: 'evidence for the decision' }],
  recommendation: 'Approve — matches the brief.',
  estSeconds: 30,
};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-pass-on-'));
  process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
  process.env['HOME'] = tmpDir;

  const db = getDb();
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../drizzle') });

  ctx = { userId: nanoid(12) };
  askerCtx = { userId: nanoid(12) };
  triageCtx = { userId: nanoid(12) };
  const ts = Date.now();
  await db.insert(users).values([
    { id: ctx.userId, email: null, name: 'joel', googleId: null, image: null, createdAt: ts },
    {
      id: askerCtx.userId,
      email: null,
      name: 'asker',
      kind: 'agent',
      googleId: null,
      image: null,
      createdAt: ts,
    },
    {
      id: triageCtx.userId,
      email: null,
      name: 'jibin',
      kind: 'agent',
      googleId: null,
      image: null,
      createdAt: ts,
    },
  ]);
});

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function askedTask(title: string) {
  const t = await createTask(ctx, { title });
  await updateTask(ctx, t.id, { assigneeId: askerCtx.userId });
  const p = await createPrompt(askerCtx, {
    taskId: t.id,
    kind: 'approval',
    prompt: 'ship it?',
    ...packaged,
  });
  return { t, p };
}

describe('passing a question on from Focus', () => {
  it('withdraws the ask as sent_back, tags the recipient, and moves the task to them at open', async () => {
    const { t, p } = await askedTask('pass-basic');
    assert.equal((await getTask(ctx, t.id))?.status, 'review');

    const passed = await passPromptOn(
      ctx,
      p.id,
      { toUserId: triageCtx.userId, note: 'already shipped last week' },
      { seconds: 12 },
    );
    assert.equal(passed.status, 'cancelled');
    assert.equal(passed.answerKind, 'sent_back');
    assert.equal(passed.answeredByUserId, ctx.userId);

    const task = await getTask(ctx, t.id);
    assert.equal(task?.assigneeId, triageCtx.userId);
    assert.equal(task?.status, 'open');

    const comments = await listCommentsForTask(ctx, t.id);
    const tag = comments.find((c) => c.body.startsWith('↪️ Passed to jibin'));
    assert.ok(tag, 'pass-on comment posted');
    assert.match(tag.body, /already shipped last week/);
    assert.match(tag.body, /@jibin — joel passed you this/);
    assert.match(tag.body, /ask_human/);

    const events = await listFocusEvents(ctx, { taskId: t.id, types: ['sent_back'] });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.seconds, 12);
    assert.deepEqual(JSON.parse(events[0]!.meta ?? '{}'), {
      estSeconds: 30,
      passedTo: triageCtx.userId,
    });
  });

  it('is human-only and refuses passing to yourself — the ask stays pending either way', async () => {
    const { t, p } = await askedTask('pass-guards');
    await assert.rejects(
      () => passPromptOn(askerCtx, p.id, { toUserId: triageCtx.userId }),
      HumanResolutionRequiredError,
    );
    await assert.rejects(() => passPromptOn(ctx, p.id, { toUserId: ctx.userId }), /someone else/);
    await assert.rejects(() => passPromptOn(ctx, p.id, { toUserId: 'nobody-here' }));
    const pending = (await listPromptsForTask(ctx, t.id)).filter((x) => x.status === 'pending');
    assert.equal(pending.length, 1);
    assert.equal((await getTask(ctx, t.id))?.status, 'review');
    assert.equal((await getTask(ctx, t.id))?.assigneeId, askerCtx.userId);
  });

  it('the recipient can close a moot task — the human withdrew the ask, so no gate blocks it', async () => {
    const { t, p } = await askedTask('pass-close');
    await passPromptOn(ctx, p.id, { toUserId: triageCtx.userId });
    const closed = await updateTask(triageCtx, t.id, { status: 'archived' });
    assert.equal(closed.status, 'archived');
  });

  it('a bare review card passes the same way without a prompt', async () => {
    // A bare review needs context (description / comment) to enter review at all.
    const t = await createTask(ctx, {
      title: 'pass-review-card',
      description: 'Landing page draft — look it over.',
    });
    await updateTask(ctx, t.id, { status: 'review' });
    await passTaskOn(
      ctx,
      t.id,
      { toUserId: triageCtx.userId, note: 'check this follows the brief' },
      { seconds: 5 },
    );
    const task = await getTask(ctx, t.id);
    assert.equal(task?.assigneeId, triageCtx.userId);
    assert.equal(task?.status, 'open');
    const comments = await listCommentsForTask(ctx, t.id);
    assert.ok(comments.some((c) => c.body.includes('check this follows the brief')));
    const events = await listFocusEvents(ctx, { taskId: t.id, types: ['sent_back'] });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.seconds, 5);
  });
});
