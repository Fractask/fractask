import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { closeDb, getDb } from './db/client.js';
import { taskShares, users } from './schema.js';
import { createTask, moveTask, updateTask } from './tasks.js';
import { isAdmin, listAdmins, setUserAdmin, setWorkspaceAdmin } from './auth.js';
import { z } from 'zod';
import { TOOLS, findTool, zodInputShape } from './mcp-tools.js';
import { getStorage } from './storage/index.js';
import type { Context } from './context.js';
import { resetStorageCache } from './storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let ctx: Context;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-mcp-tools-'));
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
    await createTask(ctx, { title: 'tree-b', parentId: root.id });
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
      sizeBytes: bytes.length,
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
      sizeBytes: 4,
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
          sizeBytes: 1,
        }) as Promise<unknown>,
      /Exactly one of taskId or noteId/,
    );
  });

  // The whole point of this group: a base64 argument cut in transit decodes to
  // a SHORTER but perfectly valid file. Node's decoder never throws, so before
  // sizeBytes existed the server stored the fragment and reported success.
  it('rejects a truncated base64 payload instead of storing the fragment', async () => {
    const task = await createTask(ctx, { title: 'post — truncated' });
    const tool = findTool('attach_file');
    const real = Buffer.alloc(9000, 7);
    const full = real.toString('base64');
    // Cut on a 4-char boundary so the fragment is *valid* base64 — the nastiest
    // case, and the one a length-or-alphabet check cannot catch.
    const cut = full.slice(0, 400);
    assert.equal(cut.length % 4, 0);
    assert.equal(Buffer.from(cut, 'base64').byteLength, 300, 'fragment must decode cleanly');

    await assert.rejects(
      () =>
        tool!.handler(ctx, {
          taskId: task.id,
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          dataBase64: cut,
          sizeBytes: real.byteLength,
        }) as Promise<unknown>,
      /TRUNCATED in transit.*sizeBytes=9000.*decodes to 300 bytes/s,
    );

    const after = (await findTool('list_attachments')!.handler(ctx, {
      taskId: task.id,
    })) as unknown[];
    assert.equal(after.length, 0, 'nothing may be stored when the payload is short');
  });

  it('rejects a payload whose sha256 disagrees at the same byte count', async () => {
    const task = await createTask(ctx, { title: 'post — corrupt' });
    const tool = findTool('attach_file');
    const sent = Buffer.from('AAAABBBBCCCC');
    const expected = createHash('sha256').update(Buffer.from('AAAABBBBCCCD')).digest('hex');

    await assert.rejects(
      () =>
        tool!.handler(ctx, {
          taskId: task.id,
          filename: 'x.bin',
          mimeType: 'application/octet-stream',
          dataBase64: sent.toString('base64'),
          sizeBytes: sent.byteLength,
          sha256: expected,
        }) as Promise<unknown>,
      /CORRUPTED in transit.*content hash did not/s,
    );

    const after = (await findTool('list_attachments')!.handler(ctx, {
      taskId: task.id,
    })) as unknown[];
    assert.equal(after.length, 0, 'nothing may be stored when the hash disagrees');
  });

  it('accepts a matching sha256', async () => {
    const task = await createTask(ctx, { title: 'post — verified' });
    const tool = findTool('attach_file');
    const body = Buffer.from('integrity-checked payload');
    const out = (await tool!.handler(ctx, {
      taskId: task.id,
      filename: 'ok.txt',
      mimeType: 'text/plain',
      dataBase64: body.toString('base64'),
      sizeBytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex').toUpperCase(),
    })) as Record<string, unknown>;
    assert.equal(out['sizeBytes'], body.byteLength);
    assert.equal(out['sha256'], createHash('sha256').update(body).digest('hex'));
  });

  it('advertises sizeBytes as required on both transports', () => {
    const tool = findTool('attach_file')!;
    assert.ok(Object.keys(zodInputShape(tool.inputSchemaZod)).includes('sizeBytes'));
    const json = tool.inputSchemaJson as { required: string[] };
    assert.ok(json.required.includes('sizeBytes'));
  });
});

describe('mcp create_upload / finalize_upload (direct-to-storage)', () => {
  // The storage key is a pure function of (owner, parent, attachmentId,
  // sanitized filename) — never taken from the caller — which is what stops a
  // forged attachmentId from adopting somebody else's object. Recomputing it
  // here stands in for the presigned PUT that the agent would run.
  const keyFor = (ownerId: string, taskId: string, id: string, name: string) =>
    `attachments/${ownerId}/${taskId}/${id}-${name}`;

  it('refuses on a local-disk server and names the alternative', async () => {
    const task = await createTask(ctx, { title: 'upload — local store' });
    const tool = findTool('create_upload')!;
    await assert.rejects(
      () =>
        tool.handler(ctx, {
          taskId: task.id,
          filename: 'cv.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
        }),
      (err: Error) => {
        assert.match(err.message, /attach_file/);
        return true;
      },
    );
  });

  it('finalize attaches an object that was uploaded out of band', async () => {
    const task = await createTask(ctx, { title: 'upload — finalize' });
    const body = Buffer.from('pretend this is a 3MB PDF');
    const id = 'upl000000001';
    const storage = await getStorage();
    await storage.put(keyFor(ctx.userId, task.id, id, 'cv.pdf'), body, 'application/pdf');

    const out = (await findTool('finalize_upload')!.handler(ctx, {
      attachmentId: id,
      taskId: task.id,
      filename: 'cv.pdf',
      mimeType: 'application/pdf',
      sizeBytes: body.byteLength,
    })) as Record<string, unknown>;
    assert.equal(out['id'], id);
    assert.equal(out['sizeBytes'], body.byteLength);
    assert.equal(out['source'], 'agent');

    const listed = (await findTool('list_attachments')!.handler(ctx, {
      taskId: task.id,
    })) as { id: string }[];
    assert.ok(listed.some((a) => a.id === id));
  });

  it('refuses a truncated upload and leaves nothing behind', async () => {
    const task = await createTask(ctx, { title: 'upload — truncated' });
    const id = 'upl000000002';
    const key = keyFor(ctx.userId, task.id, id, 'report.pdf');
    const storage = await getStorage();
    await storage.put(key, Buffer.from('only half arri'), 'application/pdf');

    await assert.rejects(
      () =>
        findTool('finalize_upload')!.handler(ctx, {
          attachmentId: id,
          taskId: task.id,
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 5000,
        }),
      (err: Error) => {
        assert.match(err.message, /declared/);
        return true;
      },
    );
    // The bad object is removed, not left orphaned in the bucket.
    assert.equal(await storage.head(key), null);
    const listed = (await findTool('list_attachments')!.handler(ctx, {
      taskId: task.id,
    })) as { id: string }[];
    assert.equal(listed.length, 0);
  });

  it('errors clearly when the PUT never happened', async () => {
    const task = await createTask(ctx, { title: 'upload — no bytes' });
    await assert.rejects(
      () =>
        findTool('finalize_upload')!.handler(ctx, {
          attachmentId: 'upl000000003',
          taskId: task.id,
          filename: 'missing.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
        }),
      (err: Error) => {
        assert.match(err.message, /No uploaded object found/);
        return true;
      },
    );
  });

  it('cannot attach to a task the caller has no access to', async () => {
    const stranger: Context = { userId: nanoid(12) };
    const task = await createTask(ctx, { title: 'upload — not yours' });
    await assert.rejects(() =>
      findTool('create_upload')!.handler(stranger, {
        taskId: task.id,
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
      }),
    );
    await assert.rejects(() =>
      findTool('finalize_upload')!.handler(stranger, {
        attachmentId: 'upl000000004',
        taskId: task.id,
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
      }),
    );
  });
});

describe('mcp tool schema advertising', () => {
  // The stdio transport advertises zodInputShape(); the HTTP transport
  // advertises inputSchemaJson. If they disagree, one transport silently drops
  // arguments — which is exactly how attach_file(_from_url)/get_user broke
  // (refine() wraps the object in ZodEffects → empty shape). Lock the invariant
  // that every tool exposes the SAME property names both ways.
  it('every tool advertises the same properties via Zod shape and JSON schema', () => {
    for (const tool of TOOLS) {
      const zodKeys = Object.keys(zodInputShape(tool.inputSchemaZod)).sort();
      const json = tool.inputSchemaJson as { properties?: Record<string, unknown> };
      const jsonKeys = Object.keys(json.properties ?? {}).sort();
      assert.deepEqual(
        zodKeys,
        jsonKeys,
        `tool "${tool.name}": Zod shape [${zodKeys}] != JSON properties [${jsonKeys}]`,
      );
      // The refine() bug we guard against surfaces as a zod/JSON MISMATCH
      // (caught above), not as an empty schema — so a genuinely argument-less
      // tool (e.g. agent_activity) advertising no properties is fine.
    }
  });

  it('refine()-wrapped tools still expose their fields (regression)', () => {
    // These three use .refine() (ZodEffects) and previously advertised {}.
    for (const name of ['attach_file', 'attach_file_from_url', 'get_user']) {
      const tool = findTool(name)!;
      const keys = Object.keys(zodInputShape(tool.inputSchemaZod));
      assert.ok(keys.length > 0, `${name} must expose its input fields`);
    }
    assert.ok(Object.keys(zodInputShape(findTool('attach_file_from_url')!.inputSchemaZod)).includes('url'));
    assert.ok(Object.keys(zodInputShape(findTool('attach_file')!.inputSchemaZod)).includes('dataBase64'));
  });
});

describe('ask_human review templates', () => {
  // The hosted MCP endpoint (web /api/mcp) serves the hand-written
  // `inputSchemaJson`, while the stdio server derives its schema from
  // `inputSchemaZod`. Adding a template type to one and not the other ships a
  // schema remote agents cannot use, and the top-level shape check above will
  // not catch it because `template` is a single top-level key.
  it('template schema: hand-written JSON matches the zod union', () => {
    const tool = findTool('ask_human')!;
    const jsonTemplate = (
      tool.inputSchemaJson as {
        properties: { template: { properties: Record<string, unknown> & { type: { enum: string[] } } } };
      }
    ).properties.template;
    const shape = zodInputShape(tool.inputSchemaZod) as Record<string, z.ZodTypeAny>;
    const union = shape.template!._def as { innerType?: { _def: { options: z.ZodObject<z.ZodRawShape>[] } } };
    const branches = union.innerType!._def.options;

    const zodTypes = branches.map((b) => (b.shape.type as z.ZodLiteral<string>)._def.value).sort();
    assert.deepEqual([...jsonTemplate.properties.type.enum].sort(), zodTypes);

    const zodKeys = [...new Set(branches.flatMap((b) => Object.keys(b.shape)))].sort();
    assert.deepEqual(Object.keys(jsonTemplate.properties).sort(), zodKeys);
  });

  it('email template round-trips through ask_human → get_task', async () => {
    const task = await createTask(ctx, { title: 'template-email' });
    const askHuman = findTool('ask_human')!;
    const { id } = (await askHuman.handler(ctx, {
      taskId: task.id,
      kind: 'approval',
      prompt: 'OK to send this renewal email?',
      template: {
        type: 'email',
        to: ['dana@acme.com'],
        cc: ['legal@sunbek.com'],
        subject: 'Renewal quote',
        body: 'Hi Dana,\n\nQuote attached.',
      },
    })) as { id: string };
    assert.ok(id);

    const getTask = findTool('get_task')!;
    const out = (await getTask.handler(ctx, { id: task.id })) as {
      prompts: { id: string; template: { type: string; subject?: string } | null }[];
    };
    const p = out.prompts.find((x) => x.id === id)!;
    assert.equal(p.template?.type, 'email');
    assert.equal(p.template?.subject, 'Renewal quote');
  });

  it('whatsapp template keeps history and draft verbatim (incl. RTL text)', async () => {
    const task = await createTask(ctx, { title: 'template-whatsapp' });
    const askHuman = findTool('ask_human')!;
    const draft = 'Good news — 12% off for 2 years.';
    const { id } = (await askHuman.handler(ctx, {
      taskId: task.id,
      kind: 'approval',
      prompt: 'Send this WhatsApp reply?',
      template: {
        type: 'whatsapp',
        contactName: 'Dana Levy',
        history: [{ from: 'them', text: 'אפשר הנחה?', time: '14:02' }],
        draft,
      },
    })) as { id: string };

    const getTask = findTool('get_task')!;
    const out = (await getTask.handler(ctx, { id: task.id })) as {
      prompts: {
        id: string;
        template: { type: string; draft?: string; history?: { text: string }[] } | null;
      }[];
    };
    const p = out.prompts.find((x) => x.id === id)!;
    assert.equal(p.template?.draft, draft);
    assert.equal(p.template?.history?.[0]?.text, 'אפשר הנחה?');
  });

  it('rejects an email template missing required fields', async () => {
    const task = await createTask(ctx, { title: 'template-invalid' });
    const askHuman = findTool('ask_human')!;
    await assert.rejects(() =>
      askHuman.handler(ctx, {
        taskId: task.id,
        kind: 'approval',
        prompt: 'Send?',
        // no `to`, no `body` — the template contract must force these
        template: { type: 'email', subject: 'Oops' },
      }),
    );
    await assert.rejects(() =>
      askHuman.handler(ctx, {
        taskId: task.id,
        kind: 'approval',
        prompt: 'Send?',
        // chat requires customerName + draft
        template: { type: 'chat', history: [] },
      }),
    );
  });

  it('tweet template round-trips and requires text', async () => {
    const task = await createTask(ctx, { title: 'template-tweet' });
    const askHuman = findTool('ask_human')!;
    const { id } = (await askHuman.handler(ctx, {
      taskId: task.id,
      kind: 'approval',
      prompt: 'Post this tweet?',
      template: { type: 'tweet', handle: '@verikal', displayName: 'Verikal', text: 'Ship day 🚀' },
    })) as { id: string };
    const getTask = findTool('get_task')!;
    const out = (await getTask.handler(ctx, { id: task.id })) as {
      prompts: { id: string; template: { type: string; text?: string } | null }[];
    };
    assert.equal(out.prompts.find((x) => x.id === id)!.template?.text, 'Ship day 🚀');

    await assert.rejects(() =>
      askHuman.handler(ctx, {
        taskId: task.id,
        kind: 'approval',
        prompt: 'Post?',
        template: { type: 'tweet', handle: '@verikal' },
      }),
    );
  });

  it('instagram template round-trips media + caption and requires media', async () => {
    const task = await createTask(ctx, { title: 'template-instagram' });
    const askHuman = findTool('ask_human')!;
    const caption = 'שלוש דקות ואת מסיימת ✨\n#verikal #מיון';
    const { id } = (await askHuman.handler(ctx, {
      taskId: task.id,
      kind: 'approval',
      prompt: 'Post this to Instagram?',
      template: {
        type: 'instagram',
        handle: 'verikal',
        format: 'post',
        media: [{ url: 'https://cdn.example.com/slide-1.png' }, { url: 'https://cdn.example.com/slide-2.png' }],
        caption,
        firstComment: '#hiring #tlv',
      },
    })) as { id: string };

    const getTask = findTool('get_task')!;
    const out = (await getTask.handler(ctx, { id: task.id })) as {
      prompts: {
        id: string;
        template: { type: string; caption?: string; media?: { url?: string }[] } | null;
      }[];
    };
    const p = out.prompts.find((x) => x.id === id)!;
    assert.equal(p.template?.type, 'instagram');
    assert.equal(p.template?.caption, caption);
    assert.equal(p.template?.media?.length, 2);
    assert.equal(p.template?.media?.[1]?.url, 'https://cdn.example.com/slide-2.png');

    // The visual IS the post: a caption on its own is not approvable.
    await assert.rejects(() =>
      askHuman.handler(ctx, {
        taskId: task.id,
        kind: 'approval',
        prompt: 'Post?',
        template: { type: 'instagram', caption: 'no image' },
      }),
    );
    // ...and each slide needs a source.
    await assert.rejects(() =>
      askHuman.handler(ctx, {
        taskId: task.id,
        kind: 'approval',
        prompt: 'Post?',
        template: { type: 'instagram', media: [{ kind: 'image' }], caption: 'orphan slide' },
      }),
    );
  });

  it('prompts without a template still deserialize with template: null', async () => {
    const task = await createTask(ctx, { title: 'template-none' });
    const askHuman = findTool('ask_human')!;
    const { id } = (await askHuman.handler(ctx, {
      taskId: task.id,
      kind: 'text',
      prompt: 'Plain question, no template',
    })) as { id: string };
    const getTask = findTool('get_task')!;
    const out = (await getTask.handler(ctx, { id: task.id })) as {
      prompts: { id: string; template: unknown }[];
    };
    assert.equal(out.prompts.find((x) => x.id === id)!.template, null);
  });
});

describe('mcp list_tasks deep + pendingPrompt', () => {
  // Acceptance for "Add coordinator/admin scope + deep assignee queries":
  // an agent must be able to enumerate its own work, and a coordinator must be
  // able to pull the whole review queue with its answer-time in ONE call.
  let agentCtx: Context;

  before(async () => {
    const db = getDb();
    agentCtx = { userId: nanoid(12) };
    await db.insert(users).values({
      id: agentCtx.userId,
      email: null,
      name: 'mcp-agent',
      googleId: null,
      image: null,
      createdAt: Date.now(),
    });
  });

  it('an assignee query is deep by default — the "agent thinks it is idle" bug', async () => {
    const entity = await createTask(ctx, { title: 'mcp-deep-entity' });
    const nested = await createTask(ctx, { title: 'mcp-deep-nested', parentId: entity.id });
    await updateTask(ctx, entity.id, { assigneeId: agentCtx.userId });
    await updateTask(ctx, nested.id, { assigneeId: agentCtx.userId });

    const tool = findTool('list_tasks')!;
    const rows = (await tool.handler(agentCtx, {
      assigneeId: agentCtx.userId,
    })) as Record<string, unknown>[];
    const ids = rows.map((r) => r['id']);
    assert.ok(ids.includes(nested.id), 'the nested assigned task is enumerated');
    assert.ok(ids.includes(entity.id), 'and so is the top-level one');
  });

  it('deep=false opts back out to roots-only', async () => {
    const entity = await createTask(ctx, { title: 'mcp-optout-entity' });
    const nested = await createTask(ctx, { title: 'mcp-optout-nested', parentId: entity.id });
    await updateTask(ctx, entity.id, { assigneeId: agentCtx.userId });
    await updateTask(ctx, nested.id, { assigneeId: agentCtx.userId });

    const tool = findTool('list_tasks')!;
    const rows = (await tool.handler(agentCtx, {
      assigneeId: agentCtx.userId,
      deep: false,
    })) as Record<string, unknown>[];
    assert.ok(!rows.map((r) => r['id']).includes(nested.id));
  });

  it('an explicit parentId is still a direct-children query', async () => {
    const entity = await createTask(ctx, { title: 'mcp-parent-entity' });
    const child = await createTask(ctx, { title: 'mcp-parent-child', parentId: entity.id });
    const gc = await createTask(ctx, { title: 'mcp-parent-gc', parentId: child.id });

    const tool = findTool('list_tasks')!;
    const rows = (await tool.handler(ctx, { parentId: entity.id })) as Record<string, unknown>[];
    const ids = rows.map((r) => r['id']);
    assert.ok(ids.includes(child.id));
    assert.ok(!ids.includes(gc.id));
  });

  it('pendingPrompt returns the review queue with estSeconds in one call', async () => {
    const entity = await createTask(ctx, { title: 'mcp-queue-entity' });
    const asked = await createTask(ctx, { title: 'mcp-queue-asked', parentId: entity.id });

    const ask = findTool('ask_human')!;
    await ask.handler(ctx, {
      taskId: asked.id,
      kind: 'approval',
      prompt: 'Ship it?',
      recommendation: 'Yes — matches the brief.',
      estSeconds: 45,
      deck: [{ kind: 'text', body: 'evidence' }],
    });

    const tool = findTool('list_tasks')!;
    const rows = (await tool.handler(ctx, {
      status: 'review',
      deep: true,
      pendingPrompt: true,
    })) as Record<string, unknown>[];

    const row = rows.find((r) => r['id'] === asked.id);
    assert.ok(row, 'the nested review task is in the queue');
    const p = row!['pendingPrompt'] as Record<string, unknown> | null;
    assert.ok(p, 'its pending prompt is attached');
    assert.equal(p!['estSeconds'], 45);
    assert.equal(p!['kind'], 'approval');
    assert.equal(p!['prompt'], 'Ship it?');
  });

  it('pendingPrompt is null on tasks with no open question', async () => {
    const t = await createTask(ctx, { title: 'mcp-noprompt' });
    const tool = findTool('list_tasks')!;
    const rows = (await tool.handler(ctx, {
      deep: true,
      pendingPrompt: true,
    })) as Record<string, unknown>[];
    const row = rows.find((r) => r['id'] === t.id);
    assert.ok(row);
    assert.equal(row!['pendingPrompt'], null);
  });

  it('advertises deep + pendingPrompt in its JSON schema', () => {
    const tool = findTool('list_tasks')!;
    const props = (tool.inputSchemaJson as { properties: Record<string, unknown> }).properties;
    assert.ok(props['deep'], 'deep is advertised');
    assert.ok(props['pendingPrompt'], 'pendingPrompt is advertised');
    assert.ok(zodInputShape(tool.inputSchemaZod)['deep'], 'deep survives shape extraction');
  });
});

// The office tools were built so the head-of-staff agent could replace ~13
// hand-walked list_tasks calls with one. They are adminOnly, and agents are
// never admins (users.is_admin defaults false; nothing in the agent-creation
// path sets it). So the tools are BOTH denied on call and filtered out of
// tools/list for the one caller they exist for — a silent failure, not a loud
// one. Pinning it here so the constraint is a documented decision rather than
// something discovered in production after the deploy.
describe('office tools — admin gating is a hard prerequisite, not a detail', () => {
  it('office_pulse and office_venture are marked adminOnly', () => {
    for (const name of ['office_pulse', 'office_venture']) {
      const tool = findTool(name);
      assert.ok(tool, `${name} is registered`);
      assert.equal(tool!.adminOnly, true, `${name} is adminOnly`);
    }
  });

  it('a non-admin caller is REFUSED by both tools', async () => {
    for (const name of ['office_pulse', 'office_venture']) {
      await assert.rejects(
        () => findTool(name)!.handler(ctx, { entityId: 'whatever' }),
        (err: Error) => err.name === 'AdminRequiredError',
        `${name} refuses a non-admin`,
      );
    }
  });

  it('the transports hide adminOnly tools from a non-admin listing', () => {
    // Mirrors packages/web/src/app/api/mcp/route.ts:99 and
    // packages/mcp/src/index.ts:165 — both filter on the same flag.
    const listedForNonAdmin = TOOLS.filter((t) => !t.adminOnly).map((t) => t.name);
    assert.ok(
      !listedForNonAdmin.includes('office_pulse'),
      'office_pulse is invisible to a non-admin: it cannot be discovered, only guessed',
    );
    const listedForAdmin = TOOLS.map((t) => t.name);
    assert.ok(listedForAdmin.includes('office_pulse'), 'an admin does see it');
    assert.ok(listedForAdmin.includes('office_venture'), 'an admin does see it');
  });

  it('getVenturePulse is org-wide, so the gate cannot simply be dropped', () => {
    // ventures.ts:261 is literally `void ctx; // admin-gated at the route`.
    // Recording the coupling: removing adminOnly without adding caller
    // scoping would widen every venture in the workspace to every agent.
    const src = fs.readFileSync(path.join(__dirname, 'ventures.ts'), 'utf8');
    assert.match(
      src,
      /void ctx;\s*\/\/ admin-gated at the route/,
      'getVenturePulse still ignores ctx — access must be granted, not un-gated',
    );
  });
});

describe('workspace admin — the flag now has a checked surface', () => {
  // Context: Joel answered "make jibin a workspace admin" on card g8OtfOd9UefI.
  // At that moment `users.is_admin` had NO way to be changed from inside the
  // product: `setUserAdmin` was exported and called from zero production code,
  // so the only path was a hand-written UPDATE. These tests pin the checked
  // path that replaces it, and the two ways it must refuse.
  let adminCtx: Context;
  let targetId: string;

  before(async () => {
    const db = getDb();
    adminCtx = { userId: nanoid(12) };
    targetId = nanoid(12);
    const now = Date.now();
    await db.insert(users).values([
      { id: adminCtx.userId, email: null, name: 'root-admin', googleId: null, image: null, createdAt: now },
      { id: targetId, email: null, name: 'grantee', googleId: null, image: null, createdAt: now },
    ]);
    // Bootstrap the first admin with the UNCHECKED helper — by definition
    // there is no admin yet to authorise it. That is the only legitimate use.
    await setUserAdmin(adminCtx.userId, true);
  });

  after(async () => {
    await setUserAdmin(adminCtx.userId, false);
  });

  it('a non-admin cannot grant admin — the page gate is UX, not the boundary', async () => {
    await assert.rejects(
      () => setWorkspaceAdmin(ctx, targetId, true),
      (err: Error) => err.name === 'AdminRequiredError',
    );
    assert.equal(await isAdmin(targetId), false, 'the refusal actually left the flag alone');
  });

  it('an admin grants admin, and the grant is readable by the check the transports run', async () => {
    const res = await setWorkspaceAdmin(adminCtx, targetId, true);
    assert.equal(res.isAdmin, true);
    // isAdmin() is what buildToolList and every assertAdmin call read, so this
    // is the assertion that says the granted user can see adminOnly tools.
    assert.equal(await isAdmin(targetId), true);
  });

  it('granting twice is a no-op that still reports the resulting state', async () => {
    const res = await setWorkspaceAdmin(adminCtx, targetId, true);
    assert.equal(res.isAdmin, true);
    assert.equal((await listAdmins()).length, 2);
  });

  it('with two admins, one can be demoted', async () => {
    const res = await setWorkspaceAdmin(adminCtx, targetId, false);
    assert.equal(res.isAdmin, false);
    assert.equal(await isAdmin(targetId), false);
    assert.equal((await listAdmins()).length, 1);
  });

  it('the LAST admin cannot be demoted — including by themselves', async () => {
    // Without this guard one click empties the admin set, and every surface
    // that could put someone back into it is itself admin-gated. There is no
    // recovery inside the product, only another hand-written UPDATE.
    await assert.rejects(
      () => setWorkspaceAdmin(adminCtx, adminCtx.userId, false),
      (err: Error) => err.name === 'LastAdminError',
    );
    assert.equal(await isAdmin(adminCtx.userId), true, 'the refusal left them admin');
  });

  it('an unknown user id is refused rather than silently doing nothing', async () => {
    await assert.rejects(() => setWorkspaceAdmin(adminCtx, 'no-such-user-id', true), /No such user/);
  });
});

/**
 * §5.2b — the reroute must be visible AT THE TOOL BOUNDARY, not only inside core.
 *
 * `createPrompt` has computed `reroutedFromUserId` since 2026-09-03 and
 * `prompt-guards.test.ts` asserts on it — but only by calling the core function
 * directly. An agent does not call `createPrompt`; it calls the `ask_human`
 * TOOL, and that handler returned a bare `{ id }`. So the fix existed and the
 * caller could not see it: the exact failure the addressing bug was made of, a
 * success value identical whether the question reached a human or not.
 *
 * These assert on the tool's RETURN VALUE. A test that goes through core would
 * pass with the handler unfixed, which is why the earlier suite did.
 */
describe('ask_human returns who the question was addressed to', () => {
  const packaged = {
    deck: [{ kind: 'text' as const, body: 'evidence for the decision' }],
    recommendation: 'Approve — matches the brief.',
    estSeconds: 30,
  };
  let agentCtx: Context;

  before(async () => {
    agentCtx = { userId: nanoid(12) };
    await getDb().insert(users).values({
      id: agentCtx.userId,
      email: null,
      name: 'addressing-bot',
      kind: 'agent',
      googleId: null,
      image: null,
      createdAt: Date.now(),
    });
  });

  it('a rerouted ask names the human it went to AND the agent it came from', async () => {
    // The move_task shape: created top-level by the agent (so agent-owned),
    // later filed under a card the human owns. There IS a human above it.
    const parent = await createTask(ctx, { title: 'venture' });
    const t = await createTask(agentCtx, { title: 'agent-owned, later filed' });
    await getDb().insert(taskShares).values({ taskId: t.id, userId: ctx.userId, createdAt: Date.now() });
    await moveTask(ctx, t.id, parent.id);

    const askHuman = findTool('ask_human')!;
    const out = (await askHuman.handler(agentCtx, {
      taskId: t.id,
      kind: 'approval',
      prompt: 'ship it?',
      ...packaged,
    })) as { id: string; addressedToUserId?: string; reroutedFromUserId?: string; note?: string };

    assert.ok(out.id);
    assert.equal(out.addressedToUserId, ctx.userId, 'the tool result names the human recipient');
    assert.equal(out.reroutedFromUserId, agentCtx.userId, 'and the agent it was rerouted away from');
    assert.match(out.note ?? '', /owned by an agent/, 'and says why, in the result the agent reads');
  });

  it('CONTROL: an un-rerouted ask still carries addressedToUserId, and no reroute keys', async () => {
    // Must not fire on the fix. If this went red too, the test above would be
    // proving only that ask_human returns *something* extra.
    const t = await createTask(ctx, { title: 'human-owned' });
    await updateTask(ctx, t.id, { assigneeId: agentCtx.userId });

    const askHuman = findTool('ask_human')!;
    const out = (await askHuman.handler(agentCtx, {
      taskId: t.id,
      kind: 'approval',
      prompt: 'ship it?',
      ...packaged,
    })) as Record<string, unknown>;

    assert.equal(out['addressedToUserId'], ctx.userId);
    assert.ok(!('reroutedFromUserId' in out), 'nothing was rerouted, so no reroute key');
    assert.ok(!('note' in out), 'and no note explaining a reroute that did not happen');
  });

  it('CONTROL: the tool description tells the agent the field exists', async () => {
    // The field is only an instrument if the caller knows to read it. This is
    // the half that lives in the description, and it was lost with the code.
    const d = findTool('ask_human')!.description;
    assert.match(d, /ADDRESSING:/);
    assert.match(d, /addressedToUserId/);
  });
});
