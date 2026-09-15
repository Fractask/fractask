/**
 * LOCAL subject-reachability probe for `scratchpad_dismiss(id=…)`.
 *
 * ## The question this answers, and why it is not a safety question
 *
 * The 2026-09-15 13:3xZ hand-off on `Tx5g85uLq96D` left `scratchpad_dismiss` as
 * the **only** AT-RISK-but-unprobed tool carrying no printed reason — the blank
 * column — and named the question to ask before encoding it:
 *
 * > its single `id` is a scratch-entry id, so it is the `delete_note` shape —
 * > *can a share-scoped caller obtain a scratch entry it may not read?*
 * > `scratchpad_list(scope="all")` returns "every owner you can read", which is
 * > not the same population. Ask that first.
 *
 * That is a SUBJECT question. It is asked here rather than argued from the code
 * path, which is the move this card has now been wrong about five times, and it
 * turns out the honest answer is neither of the two the hand-off anticipated.
 *
 * ## The shape, stated before the legs
 *
 * `loadAccessible` (`src/scratchpad.ts:88`) is the whole access rule for this
 * surface — there is no share table for scratch entries, no scope, no CTE:
 *
 * ```
 *   88  const row = …where(eq(scratchEntries.id, id))
 *   92  if (!row) throw new ScratchNotFoundError(id)        ← the not_found leg
 *   93  if (row.userId === ctx.userId) return row           ← mine
 *   94  if (await isAdmin(ctx.userId)) return row           ← ⚠️ and here
 *   95  throw new NotSharedScratchError(id)                 ← the leg under test
 * ```
 *
 * and the only enumerator on the MCP surface widens on the SAME predicate:
 *
 * ```
 *  150  const wide = f.scope === 'all' && (await isAdmin(ctx.userId))
 *  152  if (!wide) conds.push(eq(scratchEntries.userId, ctx.userId))
 * ```
 *
 * So the two populations are **complementary**, not merely disjoint by accident:
 *
 * ```
 *   NON-ADMIN   the NOT_SHARED branch is REACHABLE   · the id is NOT enumerable
 *   ADMIN       the id IS enumerable                 · the branch is UNREACHABLE (:94 returns first)
 * ```
 *
 * `isAdmin` is the hinge on both sides, and CONTRAST-CTL below is the leg that
 * says this is a property of THIS surface rather than of access control in
 * general: `isAdmin` appears in no other access path in the package.
 *
 * ## Why it is not the `get_note` shape, which is what makes it a new row
 *
 * `get_note` is DEFERRED because a share-scoped caller *cannot find* a
 * not-shared note id — a missing enumerator, discharged by handing one in
 * (`NOT_SHARED_NOTE_ID`). Here the enumerator EXISTS and returns the row; it is
 * gated on the one predicate that also disarms the error. Handing in an id
 * still discharges the subject half, so the deferral is real — but it does not
 * discharge the row, because of the second half:
 *
 * ## The blast radius, which is a FOURTH shape
 *
 * ```
 *   delete_task        the artifact is GONE        → nothing to detect with
 *   update_note        the artifact is ORPHANED    → invisible to everyone
 *   report_shipped     the artifact is DELIVERED   → invisible to caller, visible to human
 *   scratchpad_dismiss the artifact is MUTATED     → it already existed; nothing is created
 * ```
 *
 * Every WRITE-SAFETY control on this card's table asks *"did a stray artifact
 * appear?"* and finds it by a marker. `dismissScratchEntry` creates nothing: it
 * flips a human's existing idea row from `new` to `dismissed`, stamps the
 * prober as `filedBy`, and the row leaves the default `scratchpad_list` queue —
 * the human's unfiled Scratchpad. **A marker-shaped detector is structurally
 * blind to a mutation of a row it never wrote.** DETECT-CTL and REPAIR-CTL
 * measure whether the prober could see or undo it; both answer no.
 *
 * Exit: 0 = obtainable AND safe (probeable) · 1 = UNPROBEABLE · 2 = INCONCLUSIVE
 * (a control did not fire — no verdict about `scratchpad_dismiss`).
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-subject-reach-'));
process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
process.env['HOME'] = tmpDir;
process.env['GETSHIT_STORAGE'] = 'local';
process.env['GETSHIT_FILES_DIR'] = path.join(tmpDir, 'files');

const { createScratchEntry, listScratchEntries, dismissScratchEntry, updateScratchEntry } = await import(
  `../src/scratchpad.js`
);
const { users, scratchEntries } = await import(`../src/schema.js`);

// ── DB-TARGET CTL — ordered ahead of everything, including the migration ────
// This probe WRITES (a dismiss is a write). `resolveDbUrl()` falls back to a
// default that, in a shell with the real credentials exported, is production.
// Read back the url the client actually resolved rather than trusting the
// assignment, and refuse before the first write rather than after it.
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
const admin = { userId: nanoid(12) };
const ts = Date.now();
await db.insert(users).values([
  { id: owner.userId, email: null, name: 'owner', googleId: null, image: null, createdAt: ts },
  { id: caller.userId, email: null, name: 'caller', googleId: null, image: null, createdAt: ts },
  { id: admin.userId, email: null, name: 'admin', googleId: null, image: null, isAdmin: true, createdAt: ts },
]);

// One foreign entry per destructive leg, so no leg reads a row a previous leg
// already mutated. `subjectEnum` is never written to and carries the census.
const subjectEnum = await createScratchEntry(owner, { body: "owner's idea — the enumeration subject" });
const subjectNonAdmin = await createScratchEntry(owner, { body: "owner's idea — the non-admin branch subject" });
const subjectAdmin = await createScratchEntry(owner, { body: "owner's idea — the admin disarm subject" });
const ownEntry = await createScratchEntry(caller, { body: "the caller's own entry" });

let inconclusive = false;
const fail = (msg: string): void => {
  console.error(`⛔ ${msg}`);
  inconclusive = true;
};

type Klass = 'ACCEPTED' | 'NOT_SHARED' | 'NOT_FOUND' | `ERR:${string}`;

/**
 * The read an MCP caller of `scratchpad_dismiss` actually performs. It is a
 * WRITE on the ACCEPTED branch, which is the whole reason this row is in
 * question — so every leg below gets its own virgin subject.
 */
async function dismissKlass(ctx: { userId: string }, id: string): Promise<Klass> {
  try {
    await dismissScratchEntry(ctx, id, { note: 'subject-reachability probe' });
    return 'ACCEPTED';
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'ScratchNotFoundError') return 'NOT_FOUND';
    if (name === 'NotSharedScratchError') return 'NOT_SHARED';
    return `ERR:${name}`;
  }
}

/** Every enumerator the MCP surface offers, widened as far as it will go. */
async function enumerateIds(ctx: { userId: string }): Promise<string[]> {
  const rows = await listScratchEntries(ctx, { scope: 'all', status: 'all', limit: 500 });
  return rows.map((r) => r.id);
}

console.log('');
console.log('  ── POS-CTL — the enumerator must return something, or every zero below is dead ──');

const callerIds = await enumerateIds(caller);
if (!callerIds.includes(ownEntry.id)) {
  fail("POS-CTL FAILED — the caller's OWN entry is absent from its own listing; this query reads nothing");
}
console.log(`  POS-CTL        list(scope='all', status='all') as caller → ${callerIds.length} row(s), own entry present ${callerIds.includes(ownEntry.id)}`);

console.log('');
console.log('  ── LEG 1 · can a NON-ADMIN caller obtain a foreign scratch id? ──');

const leak = [subjectEnum.id, subjectNonAdmin.id, subjectAdmin.id].filter((id) => callerIds.includes(id));
console.log(`  non-admin sees 3 foreign entr(y/ies) as: ${leak.length} of 3`);
console.log(`     scope='all' is documented "every owner you can read" — measured, for a non-admin that is ONLY itself`);

console.log('');
console.log('  ── LEG 2 · is the NOT_SHARED branch reachable for that same non-admin? ──');

const nonAdminKlass = await dismissKlass(caller, subjectNonAdmin.id);
const neverReal = await dismissKlass(caller, 'zzzNoSuchEntry');
if (neverReal !== 'NOT_FOUND') {
  fail(`NEG-CTL FAILED — a never-real scratch id reads ${neverReal}, expected NOT_FOUND; the two shapes are not separable here`);
}
console.log(`  dismiss(foreign id)     → ${nonAdminKlass}`);
console.log(`  NEG-CTL never-real id   → ${neverReal}   ✅ this surface HAS a not_found shape to contrast against`);

console.log('');
console.log('  ── LEG 3 · the SAME query as an ADMIN — the control that makes LEG 1 a reading ──');

const adminIds = await enumerateIds(admin);
const adminSees = [subjectEnum.id, subjectNonAdmin.id, subjectAdmin.id].filter((id) => adminIds.includes(id));
if (adminSees.length !== 3) {
  fail(
    `ENUM-CTL FAILED — an admin sees ${adminSees.length} of 3 foreign entries, so LEG 1's zero may be about the QUERY, not about the gate`,
  );
}
console.log(`  admin sees 3 foreign entr(y/ies) as: ${adminSees.length} of 3   ✅ same call, same rows, different identity`);

console.log('');
console.log('  ── LEG 4 · and for THAT identity, can the NOT_SHARED branch fire at all? ──');

const adminKlass = await dismissKlass(admin, subjectAdmin.id);
console.log(`  dismiss(foreign id) as admin → ${adminKlass}   (:94 returns the row before :95 is reached)`);

console.log('');
console.log('  ── LEG 5 · REPAIR-CTL — LEG 4 landed a write. Can the PROBER undo it? ──');

let repairKlass: Klass | 'OK' = 'OK';
try {
  await updateScratchEntry(caller, subjectAdmin.id, { status: 'new' });
} catch (e) {
  const name = (e as Error).name;
  repairKlass = name === 'NotSharedScratchError' ? 'NOT_SHARED' : `ERR:${name}`;
}
const afterRepair = (await db.select().from(scratchEntries).where(eq(scratchEntries.id, subjectAdmin.id)).limit(1))[0];
const repaired = afterRepair?.status === 'new';
console.log(`  update(status='new') as the non-admin prober → ${repairKlass} · status is still ${JSON.stringify(afterRepair?.status)}`);

console.log('');
console.log('  ── LEG 6 · DETECT-CTL — can the prober SEE the damage it just caused? ──');

const postIds = await enumerateIds(caller);
const detectable = postIds.includes(subjectAdmin.id);
const rowStillThere = afterRepair !== undefined;
console.log(`  the mutated row in any listing the prober has → ${detectable ? 'VISIBLE' : 'INVISIBLE'} (${postIds.length} row(s) returned)`);
console.log(`  ROW-CTL  the row is still in the table: ${rowStillThere} · filedBy now ${JSON.stringify(afterRepair?.filedBy)} · nothing was CREATED, a field was FLIPPED`);
if (!rowStillThere) fail('ROW-CTL FAILED — the row is gone, so this probe measured a delete and not a mutation');

console.log('');
console.log('  ── CONTRAST-CTL — is "admin disarms the refusal" a property of THIS surface? ──');

// Read from source, because the claim is about where the predicate is USED, and
// no runtime reading can enumerate call sites. If a future edit adds an admin
// bypass to the task or note access path, this control fires and the finding
// above stops being localised to the scratch surface.
const srcDir = path.resolve(__dirname, '../src');
const others = ['access.ts', 'tasks.ts', 'brain.ts'];
const otherHits = others.map((f) => ({
  file: f,
  n: (fs.readFileSync(path.join(srcDir, f), 'utf8').match(/\bisAdmin\b/g) ?? []).length,
}));
const scratchHits = (fs.readFileSync(path.join(srcDir, 'scratchpad.ts'), 'utf8').match(/\bisAdmin\(/g) ?? []).length;
const otherTotal = otherHits.reduce((a, b) => a + b.n, 0);
if (scratchHits !== 2) {
  fail(`CONTRAST-CTL FAILED — scratchpad.ts calls isAdmin() ${scratchHits} time(s), expected the 2 named in the docblock (:94 and :150)`);
}
console.log(`  scratchpad.ts  isAdmin() call site(s): ${scratchHits}   — :94 disarms the refusal, :150 opens the enumerator`);
for (const h of otherHits) console.log(`  ${h.file.padEnd(14)} isAdmin mention(s): ${h.n}`);
console.log(`  → the task and note access paths have ${otherTotal} — no identity there can enumerate a row it cannot be refused by`);

console.log('');

const subjectObtainable = leak.length > 0;
const branchReachableByEnumerator = adminKlass === 'NOT_SHARED';
const damageVisible = detectable;
const damageRepairable = repaired;

if (inconclusive) {
  console.log('🟡 INCONCLUSIVE — a control did not fire; no verdict about scratchpad_dismiss.');
} else if (subjectObtainable && branchReachableByEnumerator && damageVisible && damageRepairable) {
  console.log('🟢 PROBEABLE — the subject is obtainable by an identity the branch can refuse,');
  console.log('   and an unrefused write is visible and repairable by the prober.');
} else {
  console.log('🔴 UNPROBEABLE — and it is two independent blockers, not one:');
  console.log('');
  console.log(`   SUBJECT   a non-admin enumerates ${leak.length} of 3 foreign entries; an admin enumerates ${adminSees.length} of 3.`);
  console.log(`             For the non-admin the branch IS reachable (${nonAdminKlass}); for the admin it is`);
  console.log(`             NOT (${adminKlass}). The id and the error live in COMPLEMENTARY populations,`);
  console.log('             both gated on isAdmin — scratchpad.ts:94 and :150. Handing in an id');
  console.log('             out-of-band discharges this half, and only this half.');
  console.log('');
  console.log(`   DAMAGE    the landed dismiss is ${damageVisible ? 'visible' : 'INVISIBLE'} to the prober and ${damageRepairable ? 'repairable' : 'NOT repairable'} by it.`);
  console.log('             Nothing was created: a human\'s existing idea row was flipped new → dismissed');
  console.log('             with the prober stamped as filedBy, and it left the default scratchpad_list');
  console.log('             queue. A marker-shaped WRITE-SAFETY control cannot see a mutation of a row');
  console.log('             it never wrote — this is a FOURTH blast-radius shape, not a repeat of the three.');
  console.log('');
  console.log('   → scratchpad_dismiss is UNPROBEABLE. It stays AT-RISK, stays in the unprobed');
  console.log('     count, and its discharge needs BOTH an out-of-band subject AND a detector.');
}

closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(inconclusive ? 2 : subjectObtainable && branchReachableByEnumerator && damageVisible && damageRepairable ? 0 : 1);
