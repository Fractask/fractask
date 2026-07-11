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
import { createTask, updateTask } from './tasks.js';
import { findTool } from './mcp-tools.js';
import type { Context } from './context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let ctx: Context;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-mcp-tools-'));
  process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
  process.env['HOME'] = tmpDir;

  const db = getDb();
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../drizzle') });

  ctx = { userId: nanoid(12) };
  await db.insert(users).values({
    id: ctx.userId,
    email: null,
    name: 'mcp-test',
    googleId: null,
    image: null,
    createdAt: Date.now(),
  });
});

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mcp list_tasks projection', () => {
  it('defaults to id + title + dueAt only', async () => {
    const root = await createTask(ctx, { title: 'projection-root' });
    const dueAt = Date.now() + 86_400_000;
    await createTask(ctx, { title: 'child-a', parentId: root.id, dueAt });
    await createTask(ctx, { title: 'child-b', parentId: root.id });

    const tool = findTool('list_tasks');
    assert.ok(tool, 'list_tasks tool must exist');
    const rows = (await tool!.handler(ctx, { parentId: root.id })) as Record<string, unknown>[];
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['dueAt', 'id', 'title']);
    }
    const a = rows.find((r) => r['title'] === 'child-a')!;
    assert.equal(a['dueAt'], dueAt);
  });

  it('opts into extra fields via `fields`', async () => {
    const root = await createTask(ctx, { title: 'fields-root' });
    const c = await createTask(ctx, { title: 'fields-child', parentId: root.id });
    await updateTask(ctx, c.id, { status: 'doing' });

    const tool = findTool('list_tasks');
    const rows = (await tool!.handler(ctx, {
      parentId: root.id,
      fields: ['title', 'status'],
    })) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]!).sort(), ['id', 'status', 'title']);
    assert.equal(rows[0]!['status'], 'doing');
  });

  it('fields: [] returns only id', async () => {
    const root = await createTask(ctx, { title: 'empty-fields-root' });
    await createTask(ctx, { title: 'empty-child', parentId: root.id });
    const tool = findTool('list_tasks');
    const rows = (await tool!.handler(ctx, { parentId: root.id, fields: [] })) as Record<
      string,
      unknown
    >[];
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]!), ['id']);
  });
});

describe('mcp get_task tree', () => {
  it('returns full descendant tree with default projection', async () => {
    const root = await createTask(ctx, { title: 'tree-root' });
    const a = await createTask(ctx, { title: 'tree-a', parentId: root.id });
    const b = await createTask(ctx, { title: 'tree-b', parentId: root.id });
    await createTask(ctx, { title: 'tree-a1', parentId: a.id });
    await createTask(ctx, { title: 'tree-a2', parentId: a.id });

    const tool = findTool('get_task');
    assert.ok(tool, 'get_task tool must exist');
    const out = (await tool!.handler(ctx, { id: root.id })) as Record<string, unknown>;
    assert.equal(out['id'], root.id);
    assert.equal(out['title'], 'tree-root');
    // Default projection: id + title + dueAt at every node, plus children.
    const children = out['children'] as Record<string, unknown>[];
    assert.equal(children.length, 2);
    const aNode = children.find((c) => c['title'] === 'tree-a')!;
    const bNode = children.find((c) => c['title'] === 'tree-b')!;
    assert.deepEqual(Object.keys(aNode).sort(), ['children', 'dueAt', 'id', 'title']);
    assert.equal((aNode['children'] as unknown[]).length, 2);
    assert.equal((bNode['children'] as unknown[]).length, 0);

    // attachments / prompts / comments at the root payload.
    assert.ok(Array.isArray(out['attachments']));
    assert.ok(Array.isArray(out['prompts']));
    assert.ok(Array.isArray(out['comments']));
  });

  it('returns null for unknown id', async () => {
    const tool = findTool('get_task');
    const out = await tool!.handler(ctx, { id: 'definitely-missing' });
    assert.equal(out, null);
  });

  it('honors fields for nested nodes', async () => {
    const root = await createTask(ctx, { title: 'opt-root' });
    const c = await createTask(ctx, { title: 'opt-child', parentId: root.id });
    await updateTask(ctx, c.id, { status: 'doing' });

    const tool = findTool('get_task');
    const out = (await tool!.handler(ctx, {
      id: root.id,
      fields: ['title', 'status'],
    })) as Record<string, unknown>;
    const children = out['children'] as Record<string, unknown>[];
    assert.equal(children[0]!['status'], 'doing');
    assert.deepEqual(Object.keys(children[0]!).sort(), ['children', 'id', 'status', 'title']);
  });
});

describe('mcp get_user / search_users', () => {
  const seeded = [
    { id: nanoid(12), name: 'Alice Anderson', email: 'alice@example.com', kind: 'human' as const },
    { id: nanoid(12), name: 'Bob Builder', email: 'bob@example.com', kind: 'guest' as const },
    { id: nanoid(12), name: 'Scout Agent', email: null, kind: 'agent' as const },
  ];

  before(async () => {
    const db = getDb();
    for (const u of seeded) {
      await db.insert(users).values({
        id: u.id,
        email: u.email,
        name: u.name,
        googleId: null,
        image: null,
        kind: u.kind,
        endpoint: null,
        createdAt: Date.now(),
      });
    }
  });

  it('get_user by id returns the summary', async () => {
    const tool = findTool('get_user');
    assert.ok(tool);
    const out = (await tool!.handler(ctx, { id: seeded[0]!.id })) as Record<string, unknown>;
    assert.equal(out['id'], seeded[0]!.id);
    assert.equal(out['name'], 'Alice Anderson');
    assert.equal(out['email'], 'alice@example.com');
    assert.equal(out['kind'], 'human');
  });

  it('get_user by name is case-insensitive', async () => {
    const tool = findTool('get_user');
    const out = (await tool!.handler(ctx, { name: 'bob builder' })) as Record<string, unknown>;
    assert.equal(out['id'], seeded[1]!.id);
    assert.equal(out['kind'], 'guest');
  });

  it('get_user returns null for unknown id', async () => {
    const tool = findTool('get_user');
    assert.equal(await tool!.handler(ctx, { id: 'nope-missing' }), null);
  });

  it('get_user rejects when neither id nor name given', async () => {
    const tool = findTool('get_user');
    await assert.rejects(() => tool!.handler(ctx, {}) as Promise<unknown>);
  });

  it('search_users matches a name substring', async () => {
    const tool = findTool('search_users');
    assert.ok(tool);
    const rows = (await tool!.handler(ctx, { query: 'ander' })) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['id'], seeded[0]!.id);
  });

  it('search_users matches an email substring', async () => {
    const tool = findTool('search_users');
    const rows = (await tool!.handler(ctx, { query: 'bob@example' })) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['id'], seeded[1]!.id);
  });

  it('search_users with no query lists everyone', async () => {
    const tool = findTool('search_users');
    const rows = (await tool!.handler(ctx, {})) as Record<string, unknown>[];
    // 3 seeded here + the mcp-test user from the top-level before().
    assert.ok(rows.length >= 4);
  });
});

describe('mcp create_task / update_task dueAt', () => {
  it('create_task accepts an ISO date string and stores epoch ms', async () => {
    const tool = findTool('create_task');
    const out = (await tool!.handler(ctx, {
      title: 'post — launch day',
      dueAt: '2026-07-15',
    })) as Record<string, unknown>;
    assert.equal(out['dueAt'], Date.parse('2026-07-15'));
  });

  it('create_task accepts epoch ms directly', async () => {
    const tool = findTool('create_task');
    const ms = Date.parse('2026-08-01T00:00:00Z');
    const out = (await tool!.handler(ctx, { title: 'post — august', dueAt: ms })) as Record<
      string,
      unknown
    >;
    assert.equal(out['dueAt'], ms);
  });

  it('update_task sets and clears dueAt', async () => {
    const create = findTool('create_task');
    const update = findTool('update_task');
    const task = (await create!.handler(ctx, { title: 'post — TBD' })) as Record<string, unknown>;
    const id = task['id'] as string;

    const scheduled = (await update!.handler(ctx, { id, dueAt: '2026-09-09' })) as Record<
      string,
      unknown
    >;
    assert.equal(scheduled['dueAt'], Date.parse('2026-09-09'));

    const cleared = (await update!.handler(ctx, { id, dueAt: null })) as Record<string, unknown>;
    assert.equal(cleared['dueAt'], null);
  });

  it('rejects a garbage date string', async () => {
    const tool = findTool('create_task');
    await assert.rejects(
      () => tool!.handler(ctx, { title: 'bad', dueAt: 'not-a-date' }) as Promise<unknown>,
      /Invalid dueAt/,
    );
  });
});

describe('mcp attach_file (base64)', () => {
  it('attaches raw base64 bytes to a task', async () => {
    const task = await createTask(ctx, { title: 'post — with image' });
    const tool = findTool('attach_file');
    const bytes = 'hello world';
    const out = (await tool!.handler(ctx, {
      taskId: task.id,
      filename: 'greeting.txt',
      mimeType: 'text/plain',
      dataBase64: Buffer.from(bytes).toString('base64'),
    })) as Record<string, unknown>;
    assert.equal(out['mimeType'], 'text/plain');
    assert.equal(out['filename'], 'greeting.txt');
    assert.equal(out['sizeBytes'], bytes.length);
  });

  it('accepts a full data: URL', async () => {
    const task = await createTask(ctx, { title: 'post — data url' });
    const tool = findTool('attach_file');
    const b64 = Buffer.from([1, 2, 3, 4]).toString('base64');
    const out = (await tool!.handler(ctx, {
      taskId: task.id,
      filename: 'blob.bin',
      mimeType: 'application/octet-stream',
      dataBase64: `data:application/octet-stream;base64,${b64}`,
    })) as Record<string, unknown>;
    assert.equal(out['sizeBytes'], 4);
  });

  it('requires exactly one of taskId/noteId', async () => {
    const tool = findTool('attach_file');
    await assert.rejects(
      () =>
        tool!.handler(ctx, {
          filename: 'x.txt',
          mimeType: 'text/plain',
          dataBase64: Buffer.from('x').toString('base64'),
        }) as Promise<unknown>,
      /Exactly one of taskId or noteId/,
    );
  });
});
