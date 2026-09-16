/**
 * LOCAL two-subject probe for the tools prod is measured to CONFLATE on.
 *
 * The card asserts "prod needs f2cea19+ for the collection half", which is a
 * claim that THIS TREE repairs list_tasks / list_notes / search_notes. That
 * claim has only ever been read off access.ts — never executed. The prod
 * behaviour probe cannot test it: it measures prod, which is the unrepaired
 * side. This runs the local build in-process against a throwaway DB.
 *
 * Two subjects, same as the prod probe:
 *   not-shared  a row that EXISTS, is non-empty, and this caller cannot read
 *   never-real  an id that was never a row
 * A tool DISTINGUISHES iff the two answers differ.
 *
 * ── 2026-09-16 03:4xZ — the NOTE-SCALAR half was added, and why ────────────
 * `npm run not-shared-behaviour` measures FIVE conflating tools on prod:
 * list_tasks, list_notes, search_notes (collection) and get_note, move_note
 * (note-scalar, added 09-16 00:4xZ and 02:3xZ). This file covered only the
 * first three, so "what would a deploy actually buy" had a MEASURED answer for
 * 3 of the 5 and a READ-OFF-THE-SOURCE answer for the other 2 — and this card
 * has already been burned once by exactly that ("the note half of that sentence
 * was an inference from access.ts, never a call"). A deploy ask carrying 3
 * measured rows and 2 inferred ones is an ask whose headline nobody re-derives.
 *
 * The two halves ask different questions of the same rule and neither implies
 * the other: the collection half is about `[]` — the SUCCESS shape — while the
 * note-scalar half is about which ERROR comes back. get_note's repair lives in
 * a `.catch()` that re-throws one error class and swallows another, which no
 * amount of reading the collection guard can tell you about.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { nanoid } from 'nanoid';
import { closeDb, getDb, getDbUrl } from '../src/db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coll-probe-'));
process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
process.env['HOME'] = tmpDir;
process.env['GETSHIT_STORAGE'] = 'local';
process.env['GETSHIT_FILES_DIR'] = path.join(tmpDir, 'files');

const { createTask, listTasks } = await import(`../src/tasks.js`);
const { createBrainNote, listBrainNotes, searchBrainNotes, getBrainNote } =
  await import(`../src/brain.js`);
const { NotSharedError, NotFoundError } = await import(`../src/access.js`);
// The note-scalar half is probed through the MCP TOOL HANDLER, not through the
// core function — see the SURFACE note on that section below. This is the same
// object the prod behaviour probe calls over HTTP.
const { findTool } = await import(`../src/mcp-tools.js`);
const { users } = await import(`../src/schema.js`);

// ── DB-TARGET CTL — ordered ahead of everything, including the migration ────
// This probe CREATES tasks and notes. `resolveDbUrl()` falls back to a default
// when GETSHIT_DB_URL is unset or ignored, and a dev shell with the real
// credentials exported has that default pointing at production — so a probe
// that silently missed its env var would seed fixtures into the live tree and
// still print a clean table. The env var is set above; this asserts it was
// actually HONOURED, by reading back the url the client resolved rather than
// trusting the assignment. Refuse before the first write, not after.
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

// The not-shared subject: a real task, owned by someone else, WITH children and
// WITH a note scoped to it — so every `[]` below is a lie about a non-empty set.
// kind=project because brain notes only attach to an entity or a project —
// the scope argument the note tools take is not merely "a task id".
const hidden = await createTask(owner, { title: 'hidden parent', kind: 'project' });
await createTask(owner, { title: 'hidden child', parentId: hidden.id });
await createBrainNote(owner, { title: 'hidden note', scopeTaskId: hidden.id, contentText: 'xyzzy' });

const NEVER_REAL = 'zzzNoSuch9XyZ';

type Answer = { kind: 'ROWS'; n: number } | { kind: 'EMPTY_SUCCESS' } | { kind: 'NOT_SHARED' } | { kind: 'OTHER_ERR'; name: string };

async function ask(fn: () => Promise<unknown[]>): Promise<Answer> {
  try {
    const rows = await fn();
    return rows.length === 0 ? { kind: 'EMPTY_SUCCESS' } : { kind: 'ROWS', n: rows.length };
  } catch (e) {
    const err = e as Error;
    if (err instanceof NotSharedError) return { kind: 'NOT_SHARED' };
    return { kind: 'OTHER_ERR', name: err.name };
  }
}

const show = (a: Answer) => (a.kind === 'ROWS' ? `ROWS(${a.n})` : a.kind === 'OTHER_ERR' ? `ERR:${a.name}` : a.kind);

const rows: Array<{ tool: string; world: string; ns: Answer; nr: Answer }> = [];

async function probe(tool: string, world: string, run: (id: string) => Promise<unknown[]>) {
  rows.push({ tool, world, ns: await ask(() => run(hidden.id)), nr: await ask(() => run(NEVER_REAL)) });
}

// The variable under test is the CALLER'S OWN ACCESSIBLE SET, because each of
// these three functions opens with `if (accessibleIds.length === 0) return []`.
// Each tool reads its own set — listTasks reads accessible TASKS, the two note
// tools read accessible NOTES — so world B has to grant both, or a row stays in
// world A while its label says otherwise.

// ── world A: the caller's accessible set is EMPTY (owns no tasks, no notes) ──
const A = 'accessible set EMPTY';
// Read the worlds rather than asserting them from the fixture code above: a
// world label nothing measures is how a row ends up filed under a condition it
// was never in — which is the error the first run of this probe actually made.
const worldA = { tasks: (await listTasks(caller, {})).length, notes: (await listBrainNotes(caller, {})).length };
await probe('list_tasks', A, (id) => listTasks(caller, { parentId: id }));
await probe('list_notes', A, (id) => listBrainNotes(caller, { scopeTaskId: id }));
await probe('search_notes', A, (id) => searchBrainNotes(caller, 'xyzzy', { scopeTaskId: id }));

// ── world B: identical, except the caller owns one unrelated task and note ──
// POSITIVE CONTROL. Nothing about the subject changes — only the caller's own
// set — so a row that flips between A and B is pinned to the early return and
// to nothing else.
const B = 'owns 1 task + 1 note';
const ownProject = await createTask(caller, { title: 'a project the caller owns', kind: 'project' });
await createBrainNote(caller, { title: 'a note the caller owns', scopeTaskId: ownProject.id, contentText: 'unrelated' });
const worldB = { tasks: (await listTasks(caller, {})).length, notes: (await listBrainNotes(caller, {})).length };
await probe('list_tasks', B, (id) => listTasks(caller, { parentId: id }));
await probe('list_notes', B, (id) => listBrainNotes(caller, { scopeTaskId: id }));
await probe('search_notes', B, (id) => searchBrainNotes(caller, 'xyzzy', { scopeTaskId: id }));

console.log('# LOCAL collection-half probe — tree HEAD, in-process, throwaway DB');
console.log(`  not-shared subject  ${hidden.id}  (real task, 1 child, 1 scoped note, owned by another user)`);
console.log(`  never-real subject  ${NEVER_REAL}`);
console.log('');
console.log('  tool          world                  not-shared      never-real      verdict');
let conflicts = 0;
for (const r of rows) {
  const same = show(r.ns) === show(r.nr);
  if (same) conflicts++;
  console.log(
    `  ${r.tool.padEnd(13)} ${r.world.padEnd(22)} ${show(r.ns).padEnd(15)} ${show(r.nr).padEnd(15)} ${same ? '🔴 CONFLATES' : '✅ distinguishes'}`,
  );
}

// ── CONTROLS ───────────────────────────────────────────────────────────────
console.log('');
// CTL 1: the owner must see the rows the caller is being told do not exist.
// Without this, every `[]` above could just mean "the fixture is empty".
const ownerTasks = await listTasks(owner, { parentId: hidden.id });
const ownerNotes = await listBrainNotes(owner, { scopeTaskId: hidden.id });
const ownerOk = ownerTasks.length > 0 && ownerNotes.length > 0;
console.log(
  `  SUBJECT CTL  owner reads the same ids → ${ownerTasks.length} task(s), ${ownerNotes.length} note(s)   ${ownerOk ? '✅ the set is NON-EMPTY, so every [] above is a false report' : '⛔ FIXTURE EMPTY — probe says nothing'}`,
);
// CTL 2: a never-real id must stay `[]` and must NOT throw, or the two columns
// could differ for a reason that has nothing to do with sharing.
const worldsOk = worldA.tasks === 0 && worldA.notes === 0 && worldB.tasks > 0 && worldB.notes > 0;
console.log(
  `  WORLD   CTL  A = ${worldA.tasks} task(s)/${worldA.notes} note(s) · B = ${worldB.tasks} task(s)/${worldB.notes} note(s)   ${worldsOk ? '✅ the two worlds differ in the one variable the labels claim' : '⛔ a world is not what its label says — rows are filed under the wrong condition'}`,
);
const nrClean = rows.every((r) => r.nr.kind === 'EMPTY_SUCCESS');
console.log(`  NEVER CTL    every never-real answer is EMPTY_SUCCESS   ${nrClean ? '✅' : '⛔ a never-real id errored — the contrast is confounded'}`);
// CTL 3: a task the caller CAN read and that is genuinely empty must answer []
// and not throw — otherwise the guard is firing on the argument, not the empty
// result, and would break working queries.
const ownEmpty = await createTask(caller, { title: 'genuinely empty, caller-owned' });
const ownEmptyAns = await ask(() => listTasks(caller, { parentId: ownEmpty.id }));
console.log(
  `  EMPTY CTL    caller's own childless task → ${show(ownEmptyAns)}   ${ownEmptyAns.kind === 'EMPTY_SUCCESS' ? '✅ guard fires on the EMPTY RESULT, not on the argument' : '⛔ guard is firing on the argument — it would break working queries'}`,
);

// ── NOTE-SCALAR half — get_note and move_note ──────────────────────────────
// Prod conflates on both. Neither is a collection, so nothing above covers
// them and the answer is an ERROR CLASS rather than an empty array.
//
// The subject is a NOTE this time, not a task: the note scoped to `hidden`,
// which exists, is non-empty, and the caller cannot read. `get_note` refuses a
// task id by answering null to both subjects — two never-real notes looking
// alike — which is why the prod probe had to DERIVE a real hidden note id and
// why this local probe can simply mint one.
//
// ⚠️ SURFACE — the first draft of this section probed the CORE functions
// (`getBrainNote`, `moveBrainNote`) and printed `get_note 🔴 CONFLATES`, which
// is true of the core function and FALSE of the tool. `getBrainNote` swallows
// NotSharedNoteError because that class *extends* NotFoundError and its
// `.catch` tests the superclass — but the MCP handler then re-asks
// `noteVisibility` on the null and returns `{error:"not_shared"}`. The card is
// about MCP TOOLS, and prod is measured through its tool surface, so a local
// row taken from a different surface is not comparable to the prod row it is
// placed beside. Probed through `findTool(...)`.handler from here on.
type ScalarAnswer =
  | { kind: 'VALUE' }
  | { kind: 'NULL' }
  | { kind: 'NOT_SHARED' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'OTHER_ERR'; name: string };

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = findTool(name);
  if (!tool) throw new Error(`TOOL-CTL: ${name} is not registered in this tree`);
  return tool.handler(caller, args);
}

async function askScalar(fn: () => Promise<unknown>): Promise<ScalarAnswer> {
  try {
    const v = await fn();
    // The tool surface reports not_shared as a RESULT BODY, not as a throw —
    // that is the whole shape this card asked for — so the classifier has to
    // read the body too or a fixed tool would still print CONFLATES.
    if (v && typeof v === 'object' && (v as Record<string, unknown>)['error'] === 'not_shared') {
      return { kind: 'NOT_SHARED' };
    }
    return v === null || v === undefined ? { kind: 'NULL' } : { kind: 'VALUE' };
  } catch (e) {
    const err = e as Error;
    // ORDER IS LOAD-BEARING: NotSharedNoteError extends NotSharedError extends
    // NotFoundError. Testing NotFoundError first would classify every
    // not_shared answer as not_found and print a clean CONFLATES table — the
    // reassuring direction, and invisible without this comment.
    if (err instanceof NotSharedError) return { kind: 'NOT_SHARED' };
    if (err instanceof NotFoundError) return { kind: 'NOT_FOUND' };
    return { kind: 'OTHER_ERR', name: err.name };
  }
}
const showS = (a: ScalarAnswer) => (a.kind === 'OTHER_ERR' ? `ERR:${a.name}` : a.kind);

const hiddenNotes = await listBrainNotes(owner, { scopeTaskId: hidden.id });
const hiddenNote = hiddenNotes[0];
const NEVER_REAL_NOTE = 'zzzNoNote9XyZ';

// The caller's own fixture, for move_note's `id` slot. Minted with NO scope, so
// it sits on the `user_id = caller` leg of noteVisibility and stays readable,
// enumerable and repairable whatever happens to its parent — the same safety
// argument the prod hand-probe makes, and it is about the visibility PREDICATE,
// not about the argument shape. (`update_note` has the identical shape and the
// opposite blast radius; it is deliberately not probed here.)
const fixture = await createBrainNote(caller, { title: 'move fixture', contentText: 'fixture' });

const subjectNoteId = hiddenNote ? hiddenNote.id : NEVER_REAL_NOTE;
const scalarRows: Array<{ tool: string; ns: ScalarAnswer; nr: ScalarAnswer }> = [];
scalarRows.push({
  tool: 'get_note',
  ns: await askScalar(() => callTool('get_note', { id: subjectNoteId })),
  nr: await askScalar(() => callTool('get_note', { id: NEVER_REAL_NOTE })),
});
scalarRows.push({
  tool: 'move_note',
  ns: await askScalar(() =>
    callTool('move_note', { id: fixture.id, newParentNoteId: subjectNoteId }),
  ),
  nr: await askScalar(() =>
    callTool('move_note', { id: fixture.id, newParentNoteId: NEVER_REAL_NOTE }),
  ),
});

console.log('');
console.log('# LOCAL note-scalar half — the other two tools prod conflates on');
console.log(
  `  not-shared subject  ${hiddenNote ? hiddenNote.id : '⛔ NONE'}  (real note, scoped to a task this caller cannot read)`,
);
console.log(`  never-real subject  ${NEVER_REAL_NOTE}`);
console.log('');
console.log('  tool          not-shared      never-real      verdict');
let scalarConflicts = 0;
for (const r of scalarRows) {
  const same = showS(r.ns) === showS(r.nr);
  if (same) scalarConflicts++;
  console.log(
    `  ${r.tool.padEnd(13)} ${showS(r.ns).padEnd(15)} ${showS(r.nr).padEnd(15)} ${same ? '🔴 CONFLATES' : '✅ distinguishes'}`,
  );
}

console.log('');
// CTL 4: the subject has to BE a hidden note. Without this the table could be
// two never-real ids agreeing, which is an artifact and not a finding — the
// exact reason get_note sat DEFERRED on the prod probe for a week.
const subjectOwnerRead = hiddenNote ? await askScalar(() => getBrainNote(owner, hiddenNote.id)) : null;
const noteSubjectOk = !!hiddenNote && subjectOwnerRead?.kind === 'VALUE';
console.log(
  `  NOTE-SUBJ CTL  owner reads the subject note → ${hiddenNote ? showS(subjectOwnerRead!) : 'NO NOTE'}   ${noteSubjectOk ? '✅ it exists and is hidden from the caller, not absent' : '⛔ the subject is not a hidden note — the table says nothing'}`,
);
// CTL 5: REACH. Without it, NOT_FOUND on the subject could equally mean "this
// caller cannot call move_note at all" — the control the prod hand-probe added
// for the same row.
const reach = await askScalar(() =>
  callTool('move_note', { id: fixture.id, newParentNoteId: null }),
);
console.log(
  `  REACH   CTL    caller moves its OWN note to root → ${showS(reach)}   ${reach.kind === 'VALUE' ? '✅ move_note is callable by this caller' : '⛔ move_note is unreachable — the two columns are confounded'}`,
);
// CTL 6: WRITE-SAFETY. Both move_note legs must have been REFUSED, i.e. the
// fixture is still where the REACH leg left it. Detects, does not prevent.
const fixtureAfter = await getBrainNote(caller, fixture.id);
const fixtureParent = fixtureAfter ? fixtureAfter.parentNoteId : 'UNREADABLE';
const writeSafe = fixtureAfter !== null && fixtureAfter.parentNoteId === null;
console.log(
  `  WRITE-SAFETY   fixture ${fixture.id} parent after 2 refused move(s) → ${String(fixtureParent)}   ${writeSafe ? '✅ nothing landed' : '⛔ a refused write LANDED — the verdict above is not the only finding'}`,
);
// NOUN CTL, not gate-weighted: a separate defect this card recorded on 09-16
// 01:5xZ. NotFoundError hardcodes `Task ${id} not found` for every entity, so a
// genuinely-missing NOTE is reported as a missing TASK. This card is about the
// VERB (found vs not shared); that is the NOUN, and it misdirects on its own.
let nounText = 'n/a';
try {
  await callTool('move_note', { id: fixture.id, newParentNoteId: NEVER_REAL_NOTE });
} catch (e) {
  nounText = (e as Error).message;
}
console.log(
  `  NOUN    CTL    a never-real NOTE id reports: "${nounText}"   ${nounText.startsWith('Task ') ? '⚠️ still the wrong noun (separate defect, NOT gate-weighted here)' : '✅ correct noun'}`,
);

console.log('');
if (!ownerOk || !nrClean || !worldsOk || ownEmptyAns.kind !== 'EMPTY_SUCCESS') {
  console.log('  ⚠️ INCONCLUSIVE — a control failed; the collection table above is not readable.');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(2);
}
if (!noteSubjectOk || reach.kind !== 'VALUE' || !writeSafe) {
  console.log('  ⚠️ INCONCLUSIVE — a note-scalar control failed; that table is not readable.');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(2);
}
const total = rows.length + scalarRows.length;
const allConflicts = conflicts + scalarConflicts;
console.log(
  `  RESULT  ${allConflicts} of ${total} row(s) CONFLATE on this tree — ${conflicts} of ${rows.length} collection (tool × world), ${scalarConflicts} of ${scalarRows.length} note-scalar.`,
);
console.log(
  `          prod conflates on all 5 of these tools (npm run not-shared-behaviour). The gap between the two numbers is what a deploy buys.`,
);
closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(allConflicts === 0 ? 0 : 1);
