/**
 * LOCAL blast-radius probe for `report_shipped(taskId=…)`.
 *
 * ## Why this exists
 *
 * The 2026-09-15 06:2xZ receipt on `Tx5g85uLq96D` named `report_shipped` as the
 * next **candidate** — deliberately not as a lead — and attached its open
 * question rather than a conclusion (precondition 18 on `F3JVD_0PuXGY`):
 *
 * > *"Its assert order is trivially right and that settles nothing; the open
 * > question is that an unrefused call writes into the HUMAN's shipped feed,
 * > the first probe here whose artifact lands in someone else's view rather
 * > than the caller's. Measure the blast radius before encoding it."*
 *
 * The assert-order half is readable from the source in a minute and it is true:
 *
 * ```
 * reportShipped(ctx, {taskId, title, url})              src/focus.ts:225
 *   const task = await assertAccessibleExists(ctx, input.taskId)  ← FIRST, and the only leg
 *   await db.insert(focusEvents).values({ …, userId: task.userId, … })
 * ```
 *
 * One argument, asserted before the insert, nothing else to design. Precondition
 * 17 exists because that is reachability and reachability is not blast radius.
 *
 * ## The three questions, asked separately
 *
 * In the world where the guard is ABSENT and the write lands, is the artifact
 *
 *   1. **readable**    — can this caller still fetch it?
 *   2. **enumerable**  — does any listing this caller can run still show it?
 *   3. **repairable**  — can this caller undo it with its own tools?
 *
 * `scratchpad_file` answers yes to all three (`scratch_entries.user_id` is an
 * ownership root). `update_note` answers no to all three by ORPHANING the
 * artifact; `delete_task` answers no by DESTROYING it.
 *
 * ## 🎯 What this one measures, and why it is a third shape
 *
 * `reportShipped` writes `userId: task.userId` — **the task's owner, not the
 * caller.** Every reader of that table is keyed on the caller:
 *
 * ```
 * listFocusEvents        focus.ts:78   eq(focusEvents.userId, ctx.userId)
 * listShippedFeed        focus.ts:262  eq(focusEvents.userId, ctx.userId)
 * deleteLatestFocusEvent focus.ts:102  eq(focusEvents.userId, ctx.userId)
 * ```
 *
 * A not-shared subject is by definition owned by somebody else, so the row it
 * mints is owned by somebody else too. The artifact is neither destroyed nor
 * orphaned: it is **intact, invisible to the caller, and delivered to a third
 * party** — a line in a human's "shipped because of past answers" feed claiming
 * that something went public, on a task the caller was never allowed to read.
 *
 * WRITE-SHAPE CTL is what keeps that honest. The unrefused write below is
 * applied at the DB layer, which means its `userId` is a hand-copy of a code
 * path — and a hand-copy drifts. So the rule is DERIVED instead: a task owned
 * by the owner and SHARED with the caller is the one fixture on which
 * `task.userId` and `ctx.userId` disagree, the real call succeeds there, and
 * the row it mints says which rule is in force. POS-CTL cannot answer it,
 * because on the caller's own task the two rules coincide. If a future fix
 * keys the row on the caller, this control fails loudly rather than letting the
 * probe keep asserting a blast radius that no longer exists.
 *
 * THIRD-PARTY-CTL is the leg that carries the finding itself. Without it this would read as
 * one more orphaning finding, and the remedy ("give the caller a reader") would
 * be the wrong remedy. With it the shape is: the damage is not lost, it has an
 * audience, and the audience is the one person who must not see it.
 *
 * ## The surface leg, which is independent of ownership
 *
 * `report_shipped` is the ONLY focus-event function on the MCP surface at all
 * (`grep focus src/mcp-tools.ts` → one import). There is no list, no get, no
 * delete. SURFACE-CTL measures that separately from the ownership question,
 * because they discharge differently: a reader could be added to the MCP
 * surface tomorrow and the ownership asymmetry would still make the row
 * unprobeable.
 *
 * ## What is NOT measured
 *
 * ⚠️ This does not test whether the guard fires — it is present in this tree,
 * and re-measuring it answers a different question. The insert is applied at the
 * DB layer so the world under test is the one where the assert is missing.
 * Every reading afterwards goes through the real public functions.
 *
 * Exit: 0 = the artifact is readable/enumerable/repairable by this caller
 * (SAFE TO PROBE) · 1 = it is not (UNSAFE-SUBJECT) · 2 = INCONCLUSIVE (a
 * control did not fire).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { closeDb, getDb, getDbUrl } from '../src/db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-shipped-blast-'));
process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
process.env['HOME'] = tmpDir;
process.env['GETSHIT_STORAGE'] = 'local';
process.env['GETSHIT_FILES_DIR'] = path.join(tmpDir, 'files');

const { createTask } = await import(`../src/tasks.js`);
const { reportShipped, listShippedFeed, listFocusEvents, deleteLatestFocusEvent } = await import(`../src/focus.js`);
const { shareTaskWithUserId } = await import(`../src/shares.js`);
const { users, focusEvents } = await import(`../src/schema.js`);

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

const HIDDEN_TITLE = 'hidden subject — the caller must never read this title';
const FAKE_SHIP = 'SHIPPED-PROBE — a ship the caller was never allowed to claim';
const OWN_SHIP = 'POS-CTL ship — on a task the caller owns';

// The hidden subject: a real project owned by somebody else, never shared.
const hidden = await createTask(owner, { title: HIDDEN_TITLE, kind: 'project' });
// The caller's own task, for the positive control.
const callerProject = await createTask(caller, { title: 'a project the caller owns', kind: 'project' });

let inconclusive = false;
const fail = (msg: string): void => {
  console.error(`⛔ ${msg}`);
  inconclusive = true;
};

/** What this caller can see of the focus events on a task, by every reader it has. */
async function seenByCaller(taskId: string): Promise<{ events: number; feed: number }> {
  const events = (await listFocusEvents(caller, { taskId })).length;
  const feed = (await listShippedFeed(caller, 50)).filter((r) => r.taskId === taskId).length;
  return { events, feed };
}

console.log('');
console.log('  ── controls, before the unrefused write ──');

// POS-CTL: the caller reports a ship on its OWN task, through the real
// function, guard and all. If this is not readable / enumerable / repairable
// afterwards, every zero below is a fact about the instruments rather than
// about the write, and this probe measures nothing.
await reportShipped(caller, { taskId: callerProject.id, title: OWN_SHIP });
const posSeen = await seenByCaller(callerProject.id);
if (posSeen.events !== 1 || posSeen.feed !== 1) {
  fail(
    `POS-CTL FAILED — the caller's own ship reads events ${posSeen.events} / feed ${posSeen.feed}, expected 1 / 1`,
  );
}
const posRepaired = await deleteLatestFocusEvent(caller, { taskId: callerProject.id, types: ['shipped'] });
const posAfter = await seenByCaller(callerProject.id);
if (!posRepaired || posAfter.events !== 0) {
  fail(`POS-CTL FAILED — the caller could not undo its OWN ship (repair ${posRepaired}, left ${posAfter.events})`);
}
console.log(
  `  POS-CTL        own task: listFocusEvents → ${posSeen.events} · listShippedFeed → ${posSeen.feed} · ` +
    `deleteLatestFocusEvent → ${posRepaired}, left ${posAfter.events}`,
);

// NEG-CTL: the guard is present in THIS tree, so the real call must refuse the
// hidden subject. This is not the question the probe answers — it is the proof
// that the subject pair is the one this card is about, and that the DB-layer
// write below is simulating an absence rather than reproducing the present.
let guardKlass = 'NOT REFUSED';
try {
  await reportShipped(caller, { taskId: hidden.id, title: 'must not land' });
} catch (e) {
  guardKlass = (e as Error).name;
}
if (guardKlass === 'NOT REFUSED') {
  fail('NEG-CTL FAILED — this tree did NOT refuse a ship on the hidden task; the fixture pair is wrong');
}
const strayAfterGuard = (
  await db.select().from(focusEvents).where(eq(focusEvents.taskId, hidden.id))
).length;
if (strayAfterGuard !== 0) fail(`NEG-CTL FAILED — the refused call still left ${strayAfterGuard} row(s)`);
console.log(`  NEG-CTL        the REAL call on the hidden task → ${guardKlass} · rows left ${strayAfterGuard}`);

// SURFACE-CTL: independent of ownership, and it is why a reader on the MCP
// surface would not by itself discharge this row. `report_shipped` is the only
// focus-event tool there is — no get, no list, no delete — so an MCP caller has
// no instrument for this table at all, not even for its own rows.
const mcpToolsSrc = fs.readFileSync(path.resolve(__dirname, '../src/mcp-tools.ts'), 'utf8');
const focusReadersOnMcp = ['listShippedFeed', 'listFocusEvents', 'deleteLatestFocusEvent'].filter((fn) =>
  mcpToolsSrc.includes(fn),
);
const reportShippedOnMcp = mcpToolsSrc.includes("name: 'report_shipped'");
if (!reportShippedOnMcp) {
  fail('SURFACE-CTL FAILED — report_shipped is not on the MCP surface, so this probe has the wrong subject');
}
console.log(
  `  SURFACE-CTL    report_shipped on MCP ${reportShippedOnMcp} · focus-event READERS on MCP ` +
    `${focusReadersOnMcp.length}${focusReadersOnMcp.length ? ` (${focusReadersOnMcp.join(', ')})` : ' — none'}`,
);

// 🎯 WRITE-SHAPE CTL — the leg that stops the simulated write below from
// drifting away from the real one.
//
// The DB-layer insert further down is a hand-copy of what `reportShipped`
// would have written. A hand-copy of a code path is exactly the thing this
// card has been wrong about repeatedly: edit `focus.ts` to key the row on
// `ctx.userId` and the simulation keeps asserting the old rule, so the probe
// would report a blast radius that no longer exists.
//
// So it is DERIVED. A task owned by `owner` and SHARED with `caller` is the one
// fixture on which the two candidate rules disagree — the real call succeeds
// (the subject is accessible) and the row it mints says which rule is in force:
// `task.userId` (today) or `ctx.userId` (a future fix). POS-CTL cannot answer
// this, because on the caller's own task the two rules coincide.
const sharedTask = await createTask(owner, { title: 'owned by owner, shared with caller', kind: 'project' });
await shareTaskWithUserId(owner, sharedTask.id, caller.userId);
await reportShipped(caller, { taskId: sharedTask.id, title: 'WRITE-SHAPE CTL' });
const shapeRow = (await db.select().from(focusEvents).where(eq(focusEvents.taskId, sharedTask.id)))[0];
const writesTaskOwner = shapeRow?.userId === owner.userId;
const writesCaller = shapeRow?.userId === caller.userId;
// ⚠️ A rule that has CHANGED is not a broken instrument, and the first version
// of this control conflated the two: it failed inconclusive on any reading
// other than `task.userId`, so a genuine fix — the very outcome this row's
// discharge names — would have printed as "the probe is broken". INCONCLUSIVE
// is reserved for a reading this probe cannot interpret; a legible reading that
// happens to be the OTHER rule gets its own loud verdict further down, and the
// simulated write below follows it.
if (!shapeRow) {
  fail('WRITE-SHAPE CTL FAILED — the real call on a SHARED task minted no row; the fixture is wrong');
} else if (!writesTaskOwner && !writesCaller) {
  fail(
    `WRITE-SHAPE CTL FAILED — reportShipped keyed the row on ${shapeRow.userId}, which is neither the task ` +
      'owner nor the caller. This probe cannot interpret that; no verdict.',
  );
}
console.log(
  `  WRITE-SHAPE CTL  real call on a SHARED task → row.userId = ${
    writesTaskOwner ? 'task.userId (the OWNER)' : writesCaller ? 'ctx.userId (the CALLER)' : '???'
  }` +
    (writesTaskOwner
      ? '   ✅ the simulation below matches the real write'
      : writesCaller
        ? '   ⚠️ RULE CHANGED since this probe was written — see the verdict'
        : '   ⛔'),
);

console.log('');
console.log('  ── the unrefused write, applied at the DB layer (the guard is not the question) ──');

// Exactly what `reportShipped` would have inserted had `assertAccessibleExists`
// not been there. `userId` is taken from the rule WRITE-SHAPE CTL just read off
// the real call, not from a re-reading of the source by hand.
const strayId = nanoid(12);
await db.insert(focusEvents).values({
  id: strayId,
  userId: writesCaller ? caller.userId : hidden.userId,
  taskId: hidden.id,
  promptId: null,
  type: 'shipped',
  seconds: null,
  meta: JSON.stringify({ title: FAKE_SHIP, url: 'https://example.invalid/shipped', byUserId: caller.userId }),
  createdAt: Date.now(),
});

const post = await seenByCaller(hidden.id);
console.log(`  readable    listFocusEvents(caller, {taskId})   → ${post.events}`);
console.log(`  enumerable  listShippedFeed(caller)             → ${post.feed}`);

// ROW-CTL is read HERE, before the repair is attempted, so it is a fact about
// the WRITE. Read after the repair it fuses two directions: "the row was never
// there" and "the row was there and the caller successfully removed it" are
// the same zero, and only one of them is this probe's finding.
const rowBeforeRepair = (await db.select().from(focusEvents).where(eq(focusEvents.id, strayId)))[0];

// Repair, on the caller's own tools, and the answer is read back from the table
// rather than taken from the repair call's reply.
const repairReply = await deleteLatestFocusEvent(caller, { taskId: hidden.id, types: ['shipped'] });
const stillThere = (
  await db.select().from(focusEvents).where(eq(focusEvents.id, strayId))
).length;
console.log(`  repairable  deleteLatestFocusEvent(caller)      → ${repairReply} · row still present ${stillThere === 1}`);

console.log('');
console.log('  ── ROW-CTL and THIRD-PARTY-CTL ──');

// ROW-CTL: the row is in the table and it is NOT the caller's. Reads the table
// directly, because "is it gone or merely unreachable?" cannot be answered by
// the surface that would be unreachable.
const row = rowBeforeRepair;
if (!row) fail('ROW-CTL FAILED — the stray focus event was never in the table at all; the write did not land');
const rowOwnedByOther = row?.userId === hidden.userId && row?.userId !== caller.userId;
console.log(
  `  ROW-CTL        row present before repair ${Boolean(row)} · user_id = the TASK OWNER ${rowOwnedByOther}` +
    (rowOwnedByOther ? ' (meta.byUserId is the caller, and nothing reads it)' : ' — the caller owns it'),
);

// 🎯 THIRD-PARTY-CTL — the leg that makes this a different shape from
// `update_note`. The artifact is not orphaned. Read as the OWNER it is right
// there in the human's feed, with the caller's title on it.
const ownerFeed = await listShippedFeed(owner, 50);
const landed = ownerFeed.find((r) => r.taskId === hidden.id);
// ⚠️ This control is aimed by the rule WRITE-SHAPE CTL read, not by the rule
// this file was written under. Under `task.userId` the row MUST reach the
// owner — that is the finding. Under `ctx.userId` it must NOT, and scoring
// that as a control failure would be the same mistake WRITE-SHAPE CTL was
// just fixed for: reading a repaired world as a broken instrument.
if (writesTaskOwner && (!landed || landed.title !== FAKE_SHIP)) {
  fail(
    'THIRD-PARTY-CTL FAILED — the row did NOT surface in the owner\'s feed even though the write is keyed on ' +
      'task.userId, so this is an orphaning finding, not a delivery one, and the reason text below would be wrong',
  );
}
if (writesCaller && landed) {
  fail(
    'THIRD-PARTY-CTL FAILED — the write is keyed on ctx.userId yet the row still reached the OWNER; ' +
      'the two readings disagree and neither can be trusted',
  );
}
console.log(
  `  THIRD-PARTY-CTL  listShippedFeed(OWNER) → ${ownerFeed.length} row(s), ours present ${Boolean(landed)} · ` +
    `title ${JSON.stringify(landed?.title ?? null)}` +
    (writesCaller ? '   ✅ correctly ABSENT under the ctx.userId rule' : ''),
);

// ORPHAN-CONTRAST: and it is NOT orphaned — a direct count keyed on the owner
// proves the row is reachable by somebody, which is what separates this from
// `update_note`'s dead end.
const ownerRows = (
  await db
    .select()
    .from(focusEvents)
    .where(and(eq(focusEvents.userId, hidden.userId), eq(focusEvents.taskId, hidden.id)))
).length;
console.log(
  `  ORPHAN-CONTRAST  rows on the SUBJECT visible to the OWNER ${ownerRows}` +
    (writesTaskOwner ? ' — intact and delivered, not orphaned' : ' — expected 0 under the ctx.userId rule'),
);

console.log('');
const survives = post.events > 0 && post.feed > 0 && repairReply && stillThere === 0;

if (inconclusive) {
  console.log('🟡 INCONCLUSIVE — a control did not fire; no verdict about report_shipped.');
} else if (survives) {
  console.log('🟢 SURVIVES — an unrefused report_shipped leaves an artifact that is');
  console.log('   readable · enumerable · repairable by this caller.');
  console.log('   → report_shipped is SAFE TO PROBE against prod.');
  if (writesCaller) {
    console.log('');
    console.log('   ⚠️ AND THE REASON IS A CHANGE, not a re-reading. When this probe was');
    console.log('   written `reportShipped` keyed the row on `task.userId`; WRITE-SHAPE CTL');
    console.log('   read `ctx.userId` this run. The UNPROBEABLE entry for report_shipped');
    console.log("   (kind THIRD-PARTY-ARTIFACT) and its reason text are now STALE — its");
    console.log('   discharge is met. Delete the row and encode the probe; do not just');
    console.log('   quote this green.');
  }
} else {
  console.log('🔴 THIRD-PARTY ARTIFACT — an unrefused report_shipped is not readable,');
  console.log('   not enumerable and not repairable by this caller, and it is NOT lost:');
  console.log('   `reportShipped` writes `userId: task.userId` (focus.ts:230) while every');
  console.log('   reader keys on `ctx.userId` (focus.ts:78, 102, 262). A not-shared subject');
  console.log('   is owned by somebody else by definition, so the row it mints is too — it');
  console.log("   lands in that human's \"shipped because of past answers\" feed, asserting");
  console.log('   that something went public, on a task the caller may not read.');
  console.log('   → report_shipped is UNSAFE-SUBJECT, kind THIRD-PARTY-ARTIFACT.');
  console.log('');
  console.log('   This is a THIRD shape, not a repeat of the other two:');
  console.log('     delete_task   the artifact is GONE        → nothing to detect with');
  console.log('     update_note   the artifact is ORPHANED    → invisible to everyone');
  console.log('     report_shipped  the artifact is DELIVERED → invisible to the caller,');
  console.log('                                                 visible to the human');
  console.log('   A WRITE-SAFETY control detects damage by reading it back. Here the one');
  console.log('   party who cannot read it back is the one running the probe.');
}

closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(inconclusive ? 2 : survives ? 0 : 1);
