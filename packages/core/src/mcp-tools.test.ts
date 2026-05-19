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
