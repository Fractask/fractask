/**
 * LOCAL two-subject probe for the COLLECTION half of the not_shared rule.
 *
 * The card asserts "prod needs f2cea19+ for the collection half", which is a
 * claim that THIS TREE repairs list_tasks / list_notes / search_notes. That
 * claim has only ever been read off access.ts — never executed. The prod
 * behaviour probe cannot test it: it measures prod, which is the unrepaired
 * side. This runs the local build in-process against a throwaway DB.
 *
 * Two subjects, same as the prod probe:
 *   not-shared  a task that EXISTS, has children/notes, and this caller cannot read
 *   never-real  an id that was never a row
 * A tool DISTINGUISHES iff the two answers differ.
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
const { createBrainNote, listBrainNotes, searchBrainNotes } = await import(`../src/brain.js`);
const { NotSharedError } = await import(`../src/access.js`);
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

console.log('');
if (!ownerOk || !nrClean || !worldsOk || ownEmptyAns.kind !== 'EMPTY_SUCCESS') {
  console.log('  ⚠️ INCONCLUSIVE — a control failed; the table above is not readable.');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(2);
}
console.log(`  RESULT  ${conflicts} of ${rows.length} (tool × world) row(s) CONFLATE on this tree.`);
closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(conflicts === 0 ? 0 : 1);
