/**
 * move-note-hand-probe — measure the `move_note` row BY HAND, before it becomes
 * a row in `not-shared-behaviour-probe.mts`.
 *
 * ## Why a separate script and not a row in the probe straight away
 *
 * This is the path `create_task` took (2026-09-14 20:5xZ hand pass → 21:4xZ
 * probed row) and it is the right order here for a specific reason: `move_note`
 * is the first probed WRITE whose fixture this caller has to **mint**, and a
 * fixture minted badly is indistinguishable from a finding. Measuring it once,
 * standalone, with the repair in the same file, is cheaper to get wrong than
 * editing a 2,632-line instrument that nine other rows depend on.
 *
 * ## Why this row is safe, argued from the handler and not from the shape
 *
 * `moveBrainNote` (`src/brain.ts:353`) asserts twice — `assertAccessibleNoteExists`
 * on `id`, then again on `newParentNoteId` — and then writes **exactly**
 * `{ parentNoteId, position, updatedAt }`. It does **not** touch `scopeTaskId`.
 *
 * That matters because `noteVisibility` (`src/access.ts:343`) keys on
 * `scope_task_id`, never on `parent_note_id`:
 *
 *     (scope_task_id IS NULL AND user_id = caller) OR scope_task_id IN accessible
 *
 * So a fixture created with **no scope** stays on the `user_id = caller` leg no
 * matter what parent it acquires. An unrefused write re-parents it under a note
 * this caller cannot read and the fixture remains fully readable, enumerable and
 * repairable with `move_note(id, null)`.
 *
 * **This is the whole difference from `update_note`**, which is still deferred:
 * that one's subject slot is `scopeTaskId`, and setting a non-null unreadable
 * scope takes the note off the owner leg — it orphans from every enumerator AND
 * from the repair call. Same "caller-owned note in the id slot" shape, opposite
 * blast radius. The shape was never what made `move_task` safe; the visibility
 * predicate was.
 *
 * ## Controls
 *
 * - **POS** — `move_note(fixture, null)` must SUCCEED. Without it, a refusal on
 *   the subject leg is unreadable: it could be the access assert or it could be
 *   that this caller cannot call `move_note` at all.
 * - **SUBJECT** — the derived not-shared note in `newParentNoteId`.
 * - **NEG** — a never-real note id in the same slot. If SUBJECT and NEG answer
 *   the same thing, the tool CONFLATES.
 * - **AUTH** — a garbage bearer, because http 403 parses into the same shape as
 *   a refusal and that is the alarming reading reachable from a bad credential.
 * - **WRITE-SAFETY** — after every leg, the fixture's `parentNoteId` is read back
 *   with `get_note`. A leg that came back without an error **was not refused**
 *   and may have landed; this prints it rather than assuming the assert held.
 *   ⚠️ `get_note` is one of the tools this card reports as CONFLATING, but it
 *   conflates on *unreadable* subjects — the fixture is this caller's own note,
 *   which is exactly the case `get_note` answers correctly (POS-CTL below).
 *
 * The subject is **derived every run** via `deriveNotSharedNoteSubject()`, never
 * pasted: a remembered note id rots two ways and neither announces itself — the
 * note is deleted (the probe then reads a never-real subject and calls it
 * hidden) or its scope task gets shared (it reads a readable subject while
 * reporting on a hidden one).
 *
 * Exit: 0 = move_note DISTINGUISHES · 1 = CONFLATES · 2 = INCONCLUSIVE.
 */

import { readEndpoint, AUTH_NEG_CTL_TOKEN } from './not-shared-deploy-marker.mts';
import { callTool, classify } from './not-shared-behaviour-probe.mts';
import { deriveNotSharedNoteSubject } from './not-shared-note-subject.mts';

const NEVER_REAL_NOTE_ID = process.env.NEVER_REAL_NOTE_ID || 'zzzNoNote9XyZ';
const FIXTURE_TITLE = 'not_shared probe fixture — move_note id slot (safe to delete)';

type Leg = { label: string; klass: string; raw: string; parentAfter: string | null | 'unknown' };

const lines: string[] = [];
const say = (s = '') => {
  lines.push(s);
  console.log(s);
};

/** Read the fixture's own `parentNoteId` back. This is the WRITE-SAFETY gauge. */
async function readParent(
  url: string,
  auth: string,
  id: string,
): Promise<string | null | 'unknown'> {
  const r = await callTool(url, auth, 'get_note', { id });
  if (r.isError) return 'unknown';
  try {
    const body = JSON.parse(r.text) as { parentNoteId?: string | null } | null;
    if (!body || typeof body !== 'object') return 'unknown';
    return body.parentNoteId ?? null;
  } catch {
    return 'unknown';
  }
}

async function main() {
  const { url, auth } = readEndpoint();
  say(`# move_note hand probe — ${url}`);
  say(`  at   ${new Date().toISOString()}`);
  say('');

  // ── the derived subject ────────────────────────────────────────────────────
  let subject: Awaited<ReturnType<typeof deriveNotSharedNoteSubject>>;
  try {
    subject = await deriveNotSharedNoteSubject();
  } catch (e) {
    say(`⛔ INCONCLUSIVE — could not derive a not-shared note subject: ${String(e).slice(0, 200)}`);
    process.exitCode = 2;
    return;
  }
  say('## subject, derived this run (never pasted) — the derivation`s own controls, at their values');
  say('```');
  for (const l of subject.lines) say(l);
  if (subject.status !== 'DERIVED') {
    say(`  status ${subject.status}`);
    say('```');
    say(
      subject.status === 'NONE'
        ? '⛔ INCONCLUSIVE — this caller can read every note in the workspace, so there is no hidden subject to probe with.'
        : `⛔ INCONCLUSIVE — ${subject.reason}`,
    );
    process.exitCode = 2;
    return;
  }
  say(`  NOT_SHARED_NOTE_ID   ${subject.noteId}   scope ${subject.scope ?? '(null)'}   caller ${subject.callerId}`);
  say('```');
  say('');

  // ── the fixture this caller OWNS ───────────────────────────────────────────
  const created = await callTool(url, auth, 'create_note', {
    title: FIXTURE_TITLE,
    contentText: 'Fixture for the move_note access probe. Personal scope on purpose — see the script header.',
  });
  if (created.isError) {
    say(`⛔ INCONCLUSIVE — could not mint the caller-owned fixture: ${created.text.slice(0, 200)}`);
    process.exitCode = 2;
    return;
  }
  const fixtureId = (JSON.parse(created.text) as { id: string }).id;
  const parentAtStart = await readParent(url, auth, fixtureId);
  say('## fixture (minted this run, personal scope so the owner leg always applies)');
  say('```');
  say(`  id                   ${fixtureId}`);
  say(`  parentNoteId at start ${String(parentAtStart)}`);
  say(
    `  POS-CTL get_note on it  ${parentAtStart === 'unknown' ? '🔴 unreadable — the safety gauge is blind' : '✅ readable, so the WRITE-SAFETY read means something'}`,
  );
  say('```');
  say('');
  if (parentAtStart === 'unknown') {
    say('⛔ INCONCLUSIVE — the fixture is not readable, so no leg below could be checked for a landed write.');
    process.exitCode = 2;
    return;
  }

  // ── the legs ───────────────────────────────────────────────────────────────
  const legs: Leg[] = [];
  const run = async (label: string, tok: string, args: Record<string, unknown>) => {
    const r = await callTool(url, tok, 'move_note', args);
    const parentAfter = await readParent(url, auth, fixtureId);
    legs.push({ label, klass: classify(r.isError, r.text), raw: r.text.slice(0, 120), parentAfter });
  };

  await run('POS   fixture → root (must SUCCEED)', auth, { id: fixtureId, newParentNoteId: null });
  await run('SUBJECT  newParentNoteId = hidden note', auth, {
    id: fixtureId,
    newParentNoteId: subject.noteId,
  });
  await run('NEG      newParentNoteId = never-real', auth, {
    id: fixtureId,
    newParentNoteId: NEVER_REAL_NOTE_ID,
  });
  await run('AUTH     garbage bearer', `Bearer ${AUTH_NEG_CTL_TOKEN}`, {
    id: fixtureId,
    newParentNoteId: subject.noteId,
  });

  say('## legs');
  say('```');
  for (const l of legs) {
    const landed = l.parentAfter !== null && l.parentAfter !== 'unknown';
    say(`  ${l.label.padEnd(38)} ${String(l.klass).padEnd(14)} fixture.parent=${String(l.parentAfter)} ${landed ? '🚨 LANDED' : ''}`);
    say(`      ${l.raw.replace(/\s+/g, ' ')}`);
  }
  say('```');
  say('');

  const [pos, subj, neg, authLeg] = legs as [Leg, Leg, Leg, Leg];
  const landedAny = legs.some((l) => l.parentAfter !== null && l.parentAfter !== 'unknown');

  say('## verdict');
  say('```');
  say(`  WRITE-SAFETY  ${legs.length} leg(s) · ${landedAny ? '🚨 at least one LANDED' : '0 landed — the fixture is at root after every leg'}`);
  say(`  POS  CTL      ${pos.klass === 'OTHER_OK' ? '✅ move_note is callable by this caller' : `🔴 ${pos.klass} — the POS leg did not succeed`}`);
  say(`  AUTH CTL      ${authLeg.klass !== subj.klass ? '✅ distinguishable from a bad credential' : `🔴 ${authLeg.klass} — IDENTICAL to the subject leg`}`);
  say(`  SUBJECT       ${subj.klass}`);
  say(`  NEG           ${neg.klass}`);

  if (pos.klass !== 'OTHER_OK' || authLeg.klass === subj.klass) {
    say('  ⛔ INCONCLUSIVE — a control did not hold, so neither answer below is readable.');
    process.exitCode = 2;
  } else if (subj.klass === neg.klass) {
    say(`  🔴 CONFLATES — move_note answers ${subj.klass} to both subjects.`);
    process.exitCode = 1;
  } else {
    say(`  ✅ DISTINGUISHES — ${subj.klass} on the hidden note, ${neg.klass} on the never-real one.`);
    process.exitCode = 0;
  }
  say('```');

  // ── repair, unconditionally ────────────────────────────────────────────────
  const finalParent = await readParent(url, auth, fixtureId);
  if (finalParent !== null && finalParent !== 'unknown') {
    const fix = await callTool(url, auth, 'move_note', { id: fixtureId, newParentNoteId: null });
    say('');
    say(`REPAIR  fixture was under ${String(finalParent)} → move to root: ${fix.isError ? `🔴 FAILED ${fix.text.slice(0, 120)}` : '✅'}`);
  }
  say('');
  say(`fixture left in place as ${fixtureId} ("${FIXTURE_TITLE}") — a note this caller owns, deletable by hand.`);
}

await main();
