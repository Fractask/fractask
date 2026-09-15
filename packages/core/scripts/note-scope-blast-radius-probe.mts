/**
 * LOCAL blast-radius probe for `update_note(scopeTaskId=…)`.
 *
 * ## Why this exists
 *
 * The 2026-09-15 04:3xZ receipt on `Tx5g85uLq96D` named `update_note` as the
 * *cheapest next row* for the prod behaviour probe, on the grounds that it has
 * the `move_task` shape:
 *
 * ```
 * updateBrainNote(ctx, id, patch)                       src/brain.ts:270
 *   await assertAccessibleNoteExists(ctx, id)              ← FIRST: a note this caller owns
 *   if (parsed.scopeTaskId !== undefined)
 *     await ensureScopeTaskValid(ctx, parsed.scopeTaskId)  ← SECOND: the leg under test
 *       → assertAccessibleExists(ctx, scopeTaskId)            src/brain.ts:56
 * ```
 *
 * The assert order is right and the subject really does go in `scopeTaskId`.
 * What that argument never asked is what the write DOES in the world where the
 * guard is missing — which is the only world a probe exists for. `move_task`'s
 * blast radius was defensible because the row it moves stays readable and
 * reversible by the caller. This probe asks whether the same is true of a note,
 * and the answer decides whether `update_note` is a probeable row or a
 * `delete_task`-shaped one.
 *
 * ## What is measured, and what is NOT
 *
 * ⚠️ This does **not** test whether the guard fires. It tests the CONSEQUENCE of
 * an unrefused write, so the scope change is applied at the DB layer rather than
 * through `updateBrainNote` — going through the function would only re-measure
 * the guard that is present in this tree, which is not the question. Every
 * reading afterwards is taken through the real public functions.
 *
 * ## The control that carries the finding
 *
 * CONTRAST-CTL does the identical thing to a TASK the caller owns — reparents it
 * under the same hidden row — and reads it back. If the task were also orphaned,
 * this would be a finding about hidden parents in general and `move_task`'s row
 * on the prod probe would be wrong too. It is the leg that makes "notes are
 * different" a measurement instead of a sentence.
 *
 * Exit: 0 = the note survives (update_note is safe to probe) · 1 = ORPHANED
 * (update_note is UNSAFE-SUBJECT) · 2 = INCONCLUSIVE (a control did not fire).
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-scope-blast-'));
process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
process.env['HOME'] = tmpDir;
process.env['GETSHIT_STORAGE'] = 'local';
process.env['GETSHIT_FILES_DIR'] = path.join(tmpDir, 'files');

const { createTask, listTasks, getTask, updateTask } = await import(`../src/tasks.js`);
const { createBrainNote, listBrainNotes, searchBrainNotes, getBrainNote, updateBrainNote } = await import(
  `../src/brain.js`
);
const { NotFoundError } = await import(`../src/access.js`);
const { users, brainNotes, tasks } = await import(`../src/schema.js`);

// ── DB-TARGET CTL — ordered ahead of everything, including the migration ────
// Same reason as `not-shared-local-collection-probe`: this probe WRITES, and
// `resolveDbUrl()` falls back to a default that, in a shell with the real
// credentials exported, is production. Read back the url the client actually
// resolved rather than trusting the assignment, and refuse before the first
// write rather than after it.
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
console.log(`  DB-TARGET CTL  resolved → ${actualDbUrl}   ✅ throwaway, not the live database`);
await migrate(db, { migrationsFolder: path.resolve(__dirname, '../drizzle') });

const owner = { userId: nanoid(12) };
const caller = { userId: nanoid(12) };
const ts = Date.now();
await db.insert(users).values([
  { id: owner.userId, email: null, name: 'owner', googleId: null, image: null, createdAt: ts },
  { id: caller.userId, email: null, name: 'caller', googleId: null, image: null, createdAt: ts },
]);

const MARKER = 'blastradiusmarker';
const NEVER_REAL_NOTE = 'zzzNoSuchNote9X';

// The hidden subject: a real project owned by somebody else, never shared.
// kind=project because a brain note only attaches to an entity or a project.
const hidden = await createTask(owner, { title: 'hidden scope', kind: 'project' });

// The caller's own rows. Both start fully readable by the caller; that is
// asserted below rather than assumed.
const callerProject = await createTask(caller, { title: 'a project the caller owns', kind: 'project' });
const callerNote = await createBrainNote(caller, {
  title: 'the fixture note',
  scopeTaskId: callerProject.id,
  contentText: MARKER,
});
const callerTask = await createTask(caller, { title: 'the fixture task', parentId: callerProject.id });

type Read = 'READABLE' | 'NOT_SHARED' | 'NOT_FOUND' | 'NULL' | `ERR:${string}`;

async function readNote(id: string): Promise<Read> {
  try {
    const n = await getBrainNote(caller, id);
    return n === null ? 'NULL' : 'READABLE';
  } catch (e) {
    const err = e as Error;
    if (err instanceof NotFoundError) return 'NOT_FOUND';
    if (err.name === 'NotSharedNoteError' || /not[_ ]shared/i.test(err.message)) return 'NOT_SHARED';
    return `ERR:${err.name}`;
  }
}

async function readTask(id: string): Promise<Read> {
  try {
    const t = await getTask(caller, id);
    return t === null ? 'NULL' : 'READABLE';
  } catch (e) {
    const err = e as Error;
    if (err instanceof NotFoundError) return 'NOT_FOUND';
    if (/not[_ ]shared/i.test(err.message)) return 'NOT_SHARED';
    return `ERR:${err.name}`;
  }
}

/** Every enumerator a caller could reach for to find a stray note afterwards. */
async function enumerators(): Promise<{ list: number; scoped: number; search: number }> {
  const list = (await listBrainNotes(caller, {})).filter((n) => n.id === callerNote.id).length;
  // Scoped at the hidden task: in THIS tree the guard refuses the filter id
  // outright. A refusal and an empty list are the same thing for the question
  // being asked — neither hands the caller the row back — so both count 0.
  let scoped = 0;
  try {
    scoped = (await listBrainNotes(caller, { scopeTaskId: hidden.id })).filter((n) => n.id === callerNote.id).length;
  } catch {
    scoped = 0;
  }
  const search = (await searchBrainNotes(caller, MARKER, {})).filter((n) => n.id === callerNote.id).length;
  return { list, scoped, search };
}

const fail: string[] = [];
const ctl = (label: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? '✅' : '⛔'} ${label.padEnd(16)} ${detail}`);
  if (!ok) fail.push(label);
};

console.log('\n── BEFORE: the fixture is readable, and every enumerator can see it ──');
const beforeNote = await readNote(callerNote.id);
const beforeEnum = await enumerators();
const beforeTask = await readTask(callerTask.id);

// POS-CTL. "Absent afterwards" proves nothing unless the same gauges were
// PRESENT beforehand — an enumerator that never returned the row cannot report
// its disappearance.
ctl('POS-CTL note', beforeNote === 'READABLE', `get_note → ${beforeNote}`);
ctl(
  'POS-CTL enum',
  beforeEnum.list === 1 && beforeEnum.search === 1,
  `list_notes(all) → ${beforeEnum.list} · search_notes → ${beforeEnum.search}`,
);
ctl('POS-CTL task', beforeTask === 'READABLE', `get_task → ${beforeTask}`);

// NEG-CTL. What a never-real note id answers, so the AFTER reading below has
// something to be compared against.
//
// ⚠️ It came back `NULL`, not `NOT_FOUND` — and that is not a broken control,
// it is the reason `get_note` sits in the prod probe's DEFERRED bucket. This
// surface has no "not_found" shape at all: `getBrainNote` answers `null` to a
// never-real id. So `get_note` cannot be the leg that separates "unreachable"
// from "gone", and ROW-CTL below does that job instead, from the DB.
const neverReal = await readNote(NEVER_REAL_NOTE);
ctl('NEG-CTL', neverReal === 'NULL' || neverReal === 'NOT_FOUND', `never-real note id → ${neverReal}`);

console.log('\n── THE UNREFUSED WRITE, applied at the DB layer (see header) ──');
// This is what `update_note(id, { scopeTaskId: <hidden> })` would leave behind
// in a build whose access assert is missing. Going through updateBrainNote
// would only re-measure this tree's guard, which is not the question.
await db.update(brainNotes).set({ scopeTaskId: hidden.id }).where(eq(brainNotes.id, callerNote.id));
console.log(`  note ${callerNote.id}  scope_task_id  ${callerProject.id} → ${hidden.id}  (owner unchanged: caller)`);

console.log('\n── AFTER ──');
const afterNote = await readNote(callerNote.id);
const afterEnum = await enumerators();

// The repair a WRITE-SAFETY remedy would reach for: put the scope back.
let repair: string;
try {
  await updateBrainNote(caller, callerNote.id, { scopeTaskId: null });
  repair = 'SUCCEEDED';
} catch (e) {
  repair = `REFUSED (${(e as Error).name})`;
}

// ROW-CTL. "No reader can see it" is only a loss if the row is still THERE —
// otherwise this probe would be reporting its own deletion. Read the table
// directly, underneath every access rule.
const rawRows = await db.select().from(brainNotes).where(eq(brainNotes.id, callerNote.id));
ctl(
  'ROW-CTL',
  rawRows.length === 1 && rawRows[0]!.userId === caller.userId,
  `brain_notes row still present, user_id still the caller — the note was orphaned, not deleted`,
);

const orphaned = afterNote !== 'READABLE' && afterEnum.list === 0 && afterEnum.scoped === 0 && afterEnum.search === 0;

console.log(`  get_note(own note)        → ${afterNote}   (a never-real id answers ${neverReal} — identical)`);
console.log(`  list_notes(no filter)     → ${afterEnum.list} row(s) matching the fixture`);
console.log(`  list_notes(scope=hidden)  → ${afterEnum.scoped} row(s)`);
console.log(`  search_notes("${MARKER}") → ${afterEnum.search} row(s)`);
console.log(`  update_note(scope → null) → ${repair}   ← the repair path`);

console.log('\n── CONTRAST-CTL: the SAME thing done to a TASK the caller owns ──');
// If a task were orphaned too, this would be a finding about hidden parents in
// general and `move_task`'s row on the prod behaviour probe would be unsound.
// It is not: accessibleTasksCte (access.ts:142) makes `user_id = caller` a ROOT
// of the accessible set regardless of parent, and brain_notes has no equivalent
// — its owner leg applies only when scope_task_id IS NULL (access.ts:343).
//
// Applied at the DB layer for the SAME reason the note write was: `moveTask`
// refuses it in this tree (measured — it throws NotSharedError from
// tasks.ts:809), and the question is what an unrefused write leaves behind, not
// whether the guard is present. Both arms of the contrast therefore bypass the
// same layer, which is what makes them comparable.
await db.update(tasks).set({ parentId: hidden.id }).where(eq(tasks.id, callerTask.id));
const afterTaskRead = await readTask(callerTask.id);
const afterTaskInList = (await listTasks(caller, {})).filter((t) => t.id === callerTask.id).length;
let taskRepair: string;
try {
  await updateTask(caller, callerTask.id, { title: 'repaired' });
  taskRepair = 'SUCCEEDED';
} catch (e) {
  taskRepair = `REFUSED (${(e as Error).name})`;
}
console.log(`  get_task(own task, now under hidden) → ${afterTaskRead}`);
console.log(`  it is still in the caller's own tree  → ${afterTaskInList} row(s)`);
console.log(`  update_task on it                     → ${taskRepair}   ← the repair path`);
ctl(
  'CONTRAST-CTL',
  afterTaskRead === 'READABLE' && taskRepair === 'SUCCEEDED',
  'the task survives the same move — so this is about NOTES, not about hidden parents',
);

console.log('\n── VERDICT ──');
if (fail.length > 0) {
  console.log(`  ⚠️  INCONCLUSIVE — ${fail.length} control(s) did not fire: ${fail.join(', ')}`);
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(2);
}
if (orphaned && repair !== 'SUCCEEDED') {
  console.log('  🔴 ORPHANED — an unrefused update_note(scopeTaskId=<not-shared>) puts the CALLER\'S OWN note');
  console.log('     beyond every enumerator this caller has, and the repair call is refused by the same assert.');
  console.log('     WRITE-SAFETY is a detector, not a preventer, and here there is nothing left to detect with.');
  console.log('     ⇒ update_note belongs in UNPROBEABLE, not in PROBES.');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}
console.log('  🟢 the note survives an unrefused write — update_note is safe to probe as a move_task-shaped row.');
closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(0);
