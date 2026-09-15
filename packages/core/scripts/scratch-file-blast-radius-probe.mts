/**
 * LOCAL blast-radius probe for `scratchpad_file(id, taskId=…)`.
 *
 * ## Why this exists
 *
 * The 2026-09-15 05:4xZ receipt on `Tx5g85uLq96D` retired `update_note` as the
 * next probed row and named `scratchpad_file` in its place, on the grounds that
 * it has the `move_task` assert order:
 *
 * ```
 * fileScratchEntry(ctx, id, {taskId})                   src/scratchpad.ts:207
 *   const row = await loadAccessible(ctx, id)              ← FIRST: an entry this caller owns
 *   await assertAccessibleExists(ctx, input.taskId)        ← SECOND: the leg under test
 * ```
 *
 * That argument is about REACHABILITY, and precondition 17 on `F3JVD_0PuXGY`
 * exists because reachability is not blast radius. The same receipt asserted a
 * second thing — *"whose filed state stays enumerable by
 * `scratchpad_list(status='filed')`"* — and that clause was an inference from
 * the code path, exactly the shape this card has been wrong about four times.
 * So it is measured here instead.
 *
 * ## The three questions, asked separately
 *
 * In the world where the guard is ABSENT and the write lands, is the artifact
 *
 *   1. **readable**    — can this caller still fetch it by id?
 *   2. **enumerable**  — does any listing this caller can run still show it?
 *   3. **repairable**  — can this caller undo the pointer with its own tools?
 *
 * `update_note` fails all three: `brain_notes` has no ownership root, so
 * scoping a note to a hidden task orphans it. `delete_task` fails all three for
 * the opposite reason — the artifact is gone. A row is probeable only when all
 * three answer yes.
 *
 * ## What is measured, and what is NOT
 *
 * ⚠️ This does **not** test whether the guard fires — the guard is present in
 * this tree, and re-measuring it would answer a different question. The filing
 * is applied at the DB layer so the world under test is the one where the
 * assert is missing. Every reading afterwards goes through the real public
 * functions.
 *
 * ## The control that carries the finding
 *
 * CONTRAST-CTL does the identical thing to a NOTE — scopes the caller's own
 * note to the same hidden task — and reads it back. Without it, three green
 * readings here would only say "hiding a parent is harmless", which is the
 * claim `note-scope-blast-radius` already disproved. With it, the difference is
 * localised to the one thing that actually differs: `scratch_entries.user_id`
 * is an ownership root and `brain_notes` has none (`access.ts`). That is a
 * property of the access rule, not of this probe, which is why it is also what
 * the test pins.
 *
 * Exit: 0 = the entry survives (scratchpad_file is safe to probe) · 1 = the
 * artifact is lost or unrepairable (UNSAFE-SUBJECT) · 2 = INCONCLUSIVE (a
 * control did not fire).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { closeDb, getDb, getDbUrl } from '../src/db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-file-blast-'));
process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
process.env['HOME'] = tmpDir;
process.env['GETSHIT_STORAGE'] = 'local';
process.env['GETSHIT_FILES_DIR'] = path.join(tmpDir, 'files');

const { createTask } = await import(`../src/tasks.js`);
const { createBrainNote, getBrainNote } = await import(`../src/brain.js`);
const { createScratchEntry, getScratchEntry, listScratchEntries, fileScratchEntry, dismissScratchEntry } =
  await import(`../src/scratchpad.js`);
const { users, scratchEntries } = await import(`../src/schema.js`);

// ── DB-TARGET CTL — ordered ahead of everything, including the migration ────
// This probe WRITES. `resolveDbUrl()` falls back to a default that, in a shell
// with the real credentials exported, is production. Read back the url the
// client actually resolved rather than trusting the assignment, and refuse
// before the first write rather than after it.
const expectedDbUrl = `file:${path.join(tmpDir, 'db.sqlite')}`;
const db = getDb();
const actualDbUrl = getDbUrl();
if (actualDbUrl !== expectedDbUrl) {
  console.error('⛔ DB-TARGET CTL FAILED — refusing to run: this probe writes.');
  console.error(`   expected  ${expectedDbUrl}`);
  console.error(`   resolved  ${actualDbUrl}`);
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(2);
}
console.log(`  DB-TARGET CTL  resolved → ${actualDbUrl}   ✅ throwaway, this probe writes`);
await migrate(db, { migrationsFolder: path.resolve(__dirname, '../drizzle') });

const owner = { userId: nanoid(12) };
const caller = { userId: nanoid(12) };
const ts = Date.now();
await db.insert(users).values([
  { id: owner.userId, email: null, name: 'owner', googleId: null, image: null, createdAt: ts },
  { id: caller.userId, email: null, name: 'caller', googleId: null, image: null, createdAt: ts },
]);

const NEVER_REAL_ENTRY = 'zzzNoSuchEntry';
const HIDDEN_TITLE = 'hidden scope — the caller must never read this title';

// The hidden subject: a real project owned by somebody else, never shared.
const hidden = await createTask(owner, { title: HIDDEN_TITLE, kind: 'project' });

// The caller's own rows. Readable at the start; asserted, not assumed.
const callerProject = await createTask(caller, { title: 'a project the caller owns', kind: 'project' });
const entry = await createScratchEntry(caller, { body: 'the fixture entry' });
// The NOT_SHARED subject for the access NEG-CTL: an entry somebody else owns.
const othersEntry = await createScratchEntry(owner, { body: "another owner's entry" });
const callerNote = await createBrainNote(caller, {
  title: 'the contrast note',
  scopeTaskId: callerProject.id,
  contentText: 'contrast',
});

type Read = 'READABLE' | 'NOT_SHARED' | 'NOT_FOUND' | 'NULL' | `ERR:${string}`;

/**
 * The WEB page's read. It swallows both unreachable cases into `null` on
 * purpose (`src/scratchpad.ts`, and the docblock says so), so it can answer
 * "is the artifact still there?" and cannot answer "if not, why not?".
 */
async function readEntry(id: string): Promise<Read> {
  try {
    const e = await getScratchEntry(caller, id);
    return e === null ? 'NULL' : 'READABLE';
  } catch (e) {
    return `ERR:${(e as Error).name}`;
  }
}

/**
 * The read an MCP CALLER actually has. There is no scalar getter on that
 * surface — `scratchpad_file` / `scratchpad_dismiss` reach the entry through
 * `loadAccessible`, which is the function that distinguishes. Aimed at a
 * never-real id it mutates nothing, which is why the NEG-CTL can use it.
 *
 * ⚠️ This is the leg the first version of this probe got wrong: it pointed the
 * NEG-CTL at `getScratchEntry`, read `NULL`, and scored the control FAILED.
 * The control was aimed at a function documented to collapse the distinction —
 * a control can be pointed at the wrong reader and its silence then says
 * nothing about the surface.
 */
async function accessKlass(id: string): Promise<Read> {
  try {
    await dismissScratchEntry(caller, id, { note: 'access probe' });
    return 'READABLE';
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'ScratchNotFoundError') return 'NOT_FOUND';
    if (name === 'NotSharedScratchError') return 'NOT_SHARED';
    return `ERR:${name}`;
  }
}

async function countFiled(): Promise<number> {
  return (await listScratchEntries(caller, { status: 'filed', limit: 500 })).length;
}

/** The title `scratchpad_list` puts next to the entry, or null. */
async function filedTitleSeenByCaller(): Promise<string | null> {
  const rows = await listScratchEntries(caller, { status: 'all', limit: 500 });
  return rows.find((r) => r.id === entry.id)?.filedTaskTitle ?? null;
}

let inconclusive = false;
const fail = (msg: string): void => {
  console.error(`⛔ ${msg}`);
  inconclusive = true;
};

console.log('');
console.log('  ── controls, before the unrefused write ──');

// POS-CTL: the fixture must start readable AND enumerable, or every reading
// below is a fact about the fixture rather than about the write.
const preRead = await readEntry(entry.id);
if (preRead !== 'READABLE') fail(`POS-CTL FAILED — the fixture entry reads ${preRead} before anything happened`);
const preFiled = await countFiled();
console.log(`  POS-CTL        get_scratch_entry → ${preRead} · list(status='filed') → ${preFiled}`);

// NEG-CTL: this surface HAS a not_found shape on the path an MCP caller uses.
// It is the leg `get_note` cannot supply — there, a never-real id and an
// orphaned note both answer `null`, so no reading can separate *unreachable*
// from *gone*. Here they are distinct answers, which is what makes the
// readings below interpretable at all.
const negRead = await accessKlass(NEVER_REAL_ENTRY);
if (negRead !== 'NOT_FOUND') fail(`NEG-CTL FAILED — a never-real entry id reads ${negRead}, expected NOT_FOUND`);
const negShared = await accessKlass(othersEntry.id);
if (negShared !== 'NOT_SHARED') {
  fail(`NEG-CTL FAILED — another owner's entry reads ${negShared}, expected NOT_SHARED`);
}
console.log(`  NEG-CTL        never-real entry id → ${negRead} · another owner's entry → ${negShared}`);
console.log(`  READER NOTE    the WEB read collapses both: getScratchEntry(never-real) → ${await readEntry(
  NEVER_REAL_ENTRY,
)}`);

console.log('');
console.log('  ── the unrefused write, applied at the DB layer (the guard is not the question) ──');

// Exactly what `fileScratchEntry` would have written had `assertAccessibleExists`
// not been there: status filed, pointer at a task this caller cannot read.
await db
  .update(scratchEntries)
  .set({ status: 'filed', filedTaskId: hidden.id, filedBy: caller.userId, filedAt: Date.now(), updatedAt: Date.now() })
  .where(eq(scratchEntries.id, entry.id));

const postRead = await readEntry(entry.id);
const postFiled = await countFiled();
const leakedTitle = await filedTitleSeenByCaller();
console.log(`  get_scratch_entry(own entry)  → ${postRead}`);
console.log(`  list(status='filed')          → ${postFiled}`);
console.log(`  …its filedTaskTitle           → ${leakedTitle === null ? 'null' : JSON.stringify(leakedTitle)}`);

// Repair: the caller's own tools, and the answer is read back rather than
// taken from the repair call's reply.
let repairKlass: Read | 'OK' = 'OK';
try {
  await fileScratchEntry(caller, entry.id, { taskId: callerProject.id, note: 'repaired' });
} catch (e) {
  repairKlass = `ERR:${(e as Error).name}`;
}
const repairedRow = (await db.select().from(scratchEntries).where(eq(scratchEntries.id, entry.id)).limit(1))[0];
const repaired = repairedRow?.filedTaskId === callerProject.id;
console.log(`  re-file → a task the caller CAN read   → ${repairKlass} · filedTaskId now ${repairedRow?.filedTaskId}`);

// The second repair path, because the first one needs a readable task in hand
// and `scratchpad_dismiss` needs nothing at all.
await db.update(scratchEntries).set({ filedTaskId: hidden.id }).where(eq(scratchEntries.id, entry.id));
await dismissScratchEntry(caller, entry.id, { note: 'cleared' });
const dismissedRow = (await db.select().from(scratchEntries).where(eq(scratchEntries.id, entry.id)).limit(1))[0];
const dismissClears = dismissedRow?.filedTaskId === null;
console.log(`  scratchpad_dismiss(id)                 → filedTaskId now ${dismissedRow?.filedTaskId}`);

console.log('');
console.log('  ── ROW-CTL and CONTRAST-CTL ──');

// ROW-CTL: the row is in the table and still belongs to the caller. Reads the
// table directly, because the question "is it gone or merely unreachable?"
// cannot be answered by the same surface that would be unreachable.
const rowOwned = dismissedRow?.userId === caller.userId;
if (!dismissedRow) fail('ROW-CTL FAILED — the entry row is not in the table at all');
console.log(`  ROW-CTL        row present ${dismissedRow ? 'yes' : 'no'} · user_id still the caller ${rowOwned}`);

// CONTRAST-CTL: the identical move done to a NOTE. If this also survived, the
// finding would be "hidden parents are harmless" — which `note-scope-blast-radius`
// already disproved — and nothing here would be about scratch entries.
const { brainNotes } = await import(`../src/schema.js`);
await db.update(brainNotes).set({ scopeTaskId: hidden.id }).where(eq(brainNotes.id, callerNote.id));
const contrastNote = await getBrainNote(caller, callerNote.id);
const contrastLost = contrastNote === null;
if (!contrastLost) {
  fail('CONTRAST-CTL FAILED — the note survived the identical write, so this probe is not measuring the asymmetry');
}
console.log(`  CONTRAST-CTL   the SAME write to a NOTE → ${contrastLost ? 'NULL (orphaned)' : 'READABLE'}`);

console.log('');
const survives = postRead === 'READABLE' && postFiled === 1 && repaired && dismissClears;

if (inconclusive) {
  console.log('🟡 INCONCLUSIVE — a control did not fire; no verdict about scratchpad_file.');
} else if (survives) {
  console.log('🟢 SURVIVES — an unrefused scratchpad_file leaves an artifact that is');
  console.log('   readable · enumerable · repairable by this caller, on its OWN tools.');
  console.log('   Mechanism: scratch_entries.user_id is an ownership root. `loadAccessible`');
  console.log('   returns the row on `row.userId === ctx.userId` and never consults');
  console.log('   filed_task_id, so the pointer cannot take the entry out of its owner\'s');
  console.log('   reach. brain_notes has no such root, which is the whole contrast.');
  console.log('   → scratchpad_file is SAFE TO PROBE against prod.');
} else {
  console.log('🔴 LOST — the artifact is not readable, not enumerable, or not repairable.');
  console.log('   → scratchpad_file is UNSAFE-SUBJECT, like update_note and delete_task.');
}

if (leakedTitle !== null) {
  console.log('');
  console.log('⚠️  SIDE READING, not part of the verdict — `filedTaskTitle` resolved to');
  console.log(`    ${JSON.stringify(leakedTitle)} for a task this caller cannot read.`);
  console.log('    `enrich()` (src/scratchpad.ts) selects titles straight from `tasks` with');
  console.log('    no access filter. It is the inverse of this card\'s usual defect: not a');
  console.log('    refusal that hides a row, a listing that discloses one. Whether that is');
  console.log('    a leak worth closing is a product call — the caller supplied the id, but');
  console.log('    it need not have known the title. Carded, not fixed here.');
}

closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(inconclusive ? 2 : survives ? 0 : 1);
