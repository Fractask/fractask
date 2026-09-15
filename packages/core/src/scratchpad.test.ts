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
import { createTask } from './tasks.js';
import { setUserAdmin } from './auth.js';
import { findTool } from './mcp-tools.js';
import {
  createScratchEntry,
  deleteScratchEntry,
  dismissScratchEntry,
  fileScratchEntry,
  getScratchEntry,
  listScratchEntries,
  countNewScratchEntries,
  updateScratchEntry,
  ScratchNotFoundError,
} from './scratchpad.js';
import {
  ForbiddenError,
  NotFoundError,
  NotSharedError,
  NotSharedScratchError,
  NOT_SHARED_MESSAGE,
  NOT_SHARED_NOTE_MESSAGE,
  NOT_SHARED_SCRATCH_MESSAGE,
} from './access.js';
import type { Context } from './context.js';
import { resetStorageCache } from './storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let joel: Context;
let jibin: Context;
let stranger: Context;

async function addUser(name: string): Promise<Context> {
  const id = nanoid(12);
  await getDb().insert(users).values({
    id,
    email: null,
    name,
    googleId: null,
    image: null,
    createdAt: Date.now(),
  });
  return { userId: id };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-scratch-'));
  process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
  process.env['HOME'] = tmpDir;
  process.env['GETSHIT_STORAGE'] = 'local';
  process.env['GETSHIT_FILES_DIR'] = path.join(tmpDir, 'files');
  resetStorageCache();
  await migrate(getDb(), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  joel = await addUser('joel');
  jibin = await addUser('jibin');
  stranger = await addUser('stranger');
  await setUserAdmin(jibin.userId, true);
});

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scratchpad', () => {
  it('owner writes, lists own new entries newest first, badge counts them', async () => {
    const a = await createScratchEntry(joel, { body: '  idea one  ' });
    assert.equal(a.body, 'idea one');
    assert.equal(a.status, 'new');
    await new Promise((r) => setTimeout(r, 2));
    const b = await createScratchEntry(joel, { body: 'idea two' });
    const rows = await listScratchEntries(joel);
    assert.deepEqual(
      rows.map((r) => r.id),
      [b.id, a.id],
    );
    assert.equal(rows[0]!.ownerName, 'joel');
    assert.equal(await countNewScratchEntries(joel), 2);
  });

  it('admin sees everyone with scope=all; a stranger sees nothing of Joel\'s', async () => {
    const mine = await createScratchEntry(jibin, { body: 'jibin own' });
    const all = await listScratchEntries(jibin, { scope: 'all' });
    assert.ok(all.some((r) => r.userId === joel.userId));
    assert.ok(all.some((r) => r.id === mine.id));
    const onlyMine = await listScratchEntries(jibin, { scope: 'mine' });
    assert.ok(onlyMine.every((r) => r.userId === jibin.userId));
    const strangerView = await listScratchEntries(stranger, { scope: 'all' });
    assert.equal(strangerView.length, 0);
    const joelEntry = (await listScratchEntries(joel))[0]!;
    // Was ScratchNotFoundError until 2026-09-13: the row EXISTS, so the honest
    // answer is not_shared. See the NotSharedScratchError suite below.
    await assert.rejects(
      () => updateScratchEntry(stranger, joelEntry.id, { body: 'hijack' }),
      NotSharedScratchError,
    );
    assert.equal(await getScratchEntry(stranger, joelEntry.id), null);
  });

  it('admin files an entry under a task it can reach; filed rows leave the new queue', async () => {
    const entry = await createScratchEntry(joel, { body: 'build the pricing page' });
    const project = await createTask(jibin, { title: 'Website', kind: 'project' });
    const task = await createTask(jibin, { title: 'Pricing page', parentId: project.id });
    const filed = await fileScratchEntry(jibin, entry.id, {
      taskId: task.id,
      note: 'Created under Website',
    });
    assert.equal(filed.status, 'filed');
    assert.equal(filed.filedBy, jibin.userId);
    const view = await getScratchEntry(joel, entry.id);
    assert.equal(view?.filedTaskTitle, 'Pricing page');
    assert.equal(view?.filedByName, 'jibin');
    assert.equal(view?.filedNote, 'Created under Website');
    const fresh = await listScratchEntries(joel);
    assert.ok(!fresh.some((r) => r.id === entry.id));
    const history = await listScratchEntries(joel, { status: 'filed' });
    assert.ok(history.some((r) => r.id === entry.id));
  });

  it('filing against an unreachable task fails and leaves the entry new', async () => {
    const entry = await createScratchEntry(joel, { body: 'orphan idea' });
    const secret = await createTask(stranger, { title: 'secret' });
    await assert.rejects(() => fileScratchEntry(joel, entry.id, { taskId: secret.id }));
    assert.equal((await getScratchEntry(joel, entry.id))?.status, 'new');
  });

  it('dismiss keeps the text; reopen clears the filing; owner-only delete', async () => {
    const entry = await createScratchEntry(joel, { body: 'noise' });
    const d = await dismissScratchEntry(jibin, entry.id, { note: 'duplicate of X' });
    assert.equal(d.status, 'dismissed');
    assert.equal(d.filedNote, 'duplicate of X');
    const reopened = await updateScratchEntry(joel, entry.id, { status: 'new' });
    assert.equal(reopened.status, 'new');
    assert.equal(reopened.filedBy, null);
    // jibin is an admin: he CAN read joel's entry, he just may not delete it.
    // Was ScratchNotFoundError; "not found" was false and "not shared" would
    // be false too — ForbiddenError is the one true answer of the three.
    await assert.rejects(() => deleteScratchEntry(jibin, entry.id), ForbiddenError);
    await deleteScratchEntry(joel, entry.id);
    assert.equal(await getScratchEntry(joel, entry.id), null);
  });

  it('MCP tools: list defaults to the new queue across owners, add/file/dismiss round-trip', async () => {
    const list = findTool('scratchpad_list')!;
    const add = findTool('scratchpad_add')!;
    const file = findTool('scratchpad_file')!;
    const dismiss = findTool('scratchpad_dismiss')!;
    assert.ok(list && add && file && dismiss);

    const added = (await add.handler(jibin, { body: 'from chat' })) as { id: string };
    const queue = (await list.handler(jibin, {})) as { id: string; ownerName: string | null }[];
    assert.ok(queue.some((r) => r.id === added.id));
    assert.ok(queue.some((r) => r.ownerName === 'joel'));

    const task = await createTask(jibin, { title: 'home for it' });
    const filed = (await file.handler(jibin, { id: added.id, taskId: task.id, note: 'ok' })) as {
      status: string;
    };
    assert.equal(filed.status, 'filed');

    const joelIdea = await createScratchEntry(joel, { body: 'already done' });
    const dis = (await dismiss.handler(jibin, { id: joelIdea.id, note: 'shipped last week' })) as {
      status: string;
    };
    assert.equal(dis.status, 'dismissed');
    await assert.rejects(() => dismiss.handler(jibin, { id: joelIdea.id }));
  });
});

/**
 * The fourth object type. `Tx5g85uLq96D` fixed task ids (2026-09-03), note ids
 * (2026-09-13 07:4x) and comment ids (2026-09-13 09:4x); a scratchpad ENTRY id
 * is neither, and `scratchpad_file` / `scratchpad_dismiss` are MCP tools.
 *
 * One case per entry point, per the card's "add a test per tool, not one
 * shared test". The cases that must NOT move under ablation are marked — they
 * are the half that stops this becoming a blanket relabel.
 */
describe('NotSharedScratchError — "not yours" is not "not there", one object type on again', () => {
  it('scratchpad_dismiss: another owner\'s entry is not_shared', async () => {
    const dismiss = findTool('scratchpad_dismiss')!;
    const mine = await createScratchEntry(joel, { body: 'joel keeps this' });
    await assert.rejects(
      () => dismiss.handler(stranger, { id: mine.id, note: 'nope' }),
      NotSharedScratchError,
    );
    // and it is still `new` — the throw happened before any write
    assert.equal((await getScratchEntry(joel, mine.id))?.status, 'new');
  });

  it('scratchpad_file: another owner\'s entry is not_shared', async () => {
    const file = findTool('scratchpad_file')!;
    const mine = await createScratchEntry(joel, { body: 'joel keeps this too' });
    const home = await createTask(stranger, { title: 'strangers home' });
    await assert.rejects(
      () => file.handler(stranger, { id: mine.id, taskId: home.id }),
      NotSharedScratchError,
    );
    assert.equal((await getScratchEntry(joel, mine.id))?.status, 'new');
  });

  it('updateScratchEntry: another owner\'s entry is not_shared', async () => {
    const mine = await createScratchEntry(joel, { body: 'not yours to edit' });
    await assert.rejects(
      () => updateScratchEntry(stranger, mine.id, { body: 'hijacked' }),
      NotSharedScratchError,
    );
  });

  it('deleteScratchEntry: another owner\'s entry is not_shared, not a zero-row miss', async () => {
    const mine = await createScratchEntry(joel, { body: 'not yours to delete' });
    await assert.rejects(() => deleteScratchEntry(stranger, mine.id), NotSharedScratchError);
    assert.ok(await getScratchEntry(joel, mine.id), 'still there');
  });

  it('deleteScratchEntry: an admin who is not the owner is forbidden, not not_shared', async () => {
    const mine = await createScratchEntry(joel, { body: 'admin can see, cannot delete' });
    await assert.rejects(() => deleteScratchEntry(jibin, mine.id), (err: unknown) => {
      assert.ok(err instanceof ForbiddenError);
      assert.ok(!(err instanceof NotSharedError), 'an admin CAN read it — not_shared would be a lie');
      return true;
    });
  });

  // ---- neg-controls: these must NOT move when the fix is ablated ----

  it('NEG-CTL an entry id that was never real stays a plain not_found', async () => {
    const dismiss = findTool('scratchpad_dismiss')!;
    await assert.rejects(
      () => dismiss.handler(joel, { id: 'zzzNEVERREAL9', note: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof ScratchNotFoundError);
        assert.ok(!(err instanceof NotSharedError), 'a missing row must not be relabelled');
        return true;
      },
    );
  });

  it('NEG-CTL a deleted entry stays a plain not_found', async () => {
    const doomed = await createScratchEntry(joel, { body: 'about to go' });
    await deleteScratchEntry(joel, doomed.id);
    await assert.rejects(() => updateScratchEntry(joel, doomed.id, { body: 'zombie' }), (err: unknown) => {
      assert.ok(err instanceof ScratchNotFoundError);
      assert.ok(!(err instanceof NotSharedError));
      return true;
    });
  });

  it('NEG-CTL the owner and an admin can still file and dismiss', async () => {
    const dismiss = findTool('scratchpad_dismiss')!;
    const own = await createScratchEntry(joel, { body: 'owner path' });
    assert.equal(
      ((await dismiss.handler(joel, { id: own.id, note: 'mine' })) as { status: string }).status,
      'dismissed',
    );
    const other = await createScratchEntry(joel, { body: 'admin path' });
    assert.equal(
      ((await dismiss.handler(jibin, { id: other.id, note: 'admin' })) as { status: string }).status,
      'dismissed',
    );
  });

  // ---- shape: what the transports and the web depend on ----

  it('NotSharedScratchError is a NotSharedError, so one mapper check covers all three nouns', () => {
    const err = new NotSharedScratchError('abc123');
    assert.ok(err instanceof NotSharedError, 'transports test NotSharedError first — must match');
    assert.ok(err instanceof NotFoundError, 'and it stays a NotFoundError for existing handlers');
    assert.equal(err.entryId, 'abc123');
    assert.match(err.message, /^Scratch entry abc123 not shared — /);
  });

  it('ScratchNotFoundError is a NotFoundError, so a miss reports not_found: and not error:', () => {
    const err = new ScratchNotFoundError('abc123');
    assert.ok(err instanceof NotFoundError, 'was a plain Error — mapped to the catch-all prefix');
    assert.ok(!(err instanceof NotSharedError), 'and it must not be caught by the not_shared branch');
    assert.equal(err.message, 'Scratch entry abc123 not found');
  });

  it('getScratchEntry still returns null for BOTH unreachable cases', async () => {
    const mine = await createScratchEntry(joel, { body: 'read blast radius' });
    assert.equal(await getScratchEntry(stranger, mine.id), null); // exists, not theirs
    assert.equal(await getScratchEntry(stranger, 'zzzNEVERREAL9'), null); // never existed
  });

  it('the do-not-recreate clause is byte-identical across task, note and scratch wording', () => {
    const clause = 'It is not missing — do not recreate it.';
    for (const m of [NOT_SHARED_MESSAGE, NOT_SHARED_NOTE_MESSAGE, NOT_SHARED_SCRATCH_MESSAGE]) {
      assert.ok(m.includes(clause), `missing the load-bearing clause: ${m}`);
    }
    // The scratch sentence must NOT promise the task/note remedy: scratchpad
    // entries have no share mechanism, so "ask its owner to share it" would
    // send an agent after something that cannot be done.
    assert.ok(!NOT_SHARED_SCRATCH_MESSAGE.includes('share it'));
    assert.ok(NOT_SHARED_MESSAGE.includes('Ask its owner to share it'));
  });
});

/**
 * The property that makes `scratchpad_file` a probeable row on
 * `not-shared-behaviour-probe` while `update_note` — which has the IDENTICAL
 * assert order — is `UNSAFE-SUBJECT`.
 *
 * What is pinned here is the ACCESS RULE, not the probe: `scratch_entries` has
 * an ownership root (`user_id`), and `loadAccessible` never consults
 * `filed_task_id`, so no filing target can take an entry out of its owner's
 * reach. `brain_notes` has no such root — `(scope_task_id IS NULL AND user_id =
 * caller) OR scope_task_id IN accessible` — which is why the same write orphans
 * a note (`npm run note-scope-blast-radius`).
 *
 * A future schema change that couples entry visibility to `filed_task_id` reds
 * this, and that is exactly the moment someone must be told the probe row is no
 * longer safe. Precondition 17(b) on `F3JVD_0PuXGY`.
 */
describe('an entry filed under a task the owner cannot read is still the owner\'s', () => {
  it('stays readable, enumerable and repairable — measured through the public functions', async () => {
    const hidden = await createTask(stranger, { title: 'a task joel cannot read', kind: 'project' });
    const mine = await createScratchEntry(joel, { body: 'blast radius fixture' });
    const home = await createTask(joel, { title: 'a task joel owns', kind: 'project' });

    // PRECONDITION, asserted rather than assumed: joel really cannot read the
    // filing target. Without this the three readings below are a test that
    // already passed. Precondition 16.
    await assert.rejects(() => fileScratchEntry(joel, mine.id, { taskId: hidden.id }), NotSharedError);

    // The world where the guard is missing, reached the only way the public
    // API allows: an admin CAN file it there, and the entry is still joel's.
    await fileScratchEntry(jibin, mine.id, { taskId: hidden.id });

    // 1 · readable
    const read = await getScratchEntry(joel, mine.id);
    assert.ok(read, 'the owner can still fetch it');
    assert.equal(read.filedTaskId, hidden.id);
    // 2 · enumerable
    const filed = await listScratchEntries(joel, { status: 'filed', limit: 500 });
    assert.ok(filed.some((e) => e.id === mine.id), 'the owner can still enumerate it');
    // 3 · repairable, on the owner's OWN tools, both paths
    await dismissScratchEntry(joel, mine.id, { note: 'cleared' });
    assert.equal((await getScratchEntry(joel, mine.id))?.filedTaskId, null);
    await fileScratchEntry(joel, mine.id, { taskId: home.id });
    assert.equal((await getScratchEntry(joel, mine.id))?.filedTaskId, home.id);
  });

  it('the repair path does NOT require reaching the bad target — that is what orphans a note', async () => {
    // `update_note(id, {scopeTaskId: null})` refuses on the note's own access
    // assert once the scope is hidden, so the repair is unreachable. The
    // scratch equivalent asserts on `user_id`, so it is always reachable.
    const hidden = await createTask(stranger, { title: 'another hidden task', kind: 'project' });
    const mine = await createScratchEntry(joel, { body: 'repair reachability' });
    await fileScratchEntry(jibin, mine.id, { taskId: hidden.id });
    await updateScratchEntry(joel, mine.id, { status: 'new' });
    const back = await getScratchEntry(joel, mine.id);
    assert.equal(back?.status, 'new');
    assert.equal(back?.filedTaskId, null);
  });
});
