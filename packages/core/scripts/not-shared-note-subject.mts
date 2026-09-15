/**
 * # Derive a NOT-SHARED *note* subject for the behaviour probe
 *
 *     cd packages/core && npm run not-shared-note-subject
 *       exit 0  a hidden note was derived — its id is printed, ready for NOT_SHARED_NOTE_ID
 *       exit 1  no hidden note exists for this caller — the deferral cannot be discharged today
 *       exit 2  INCONCLUSIVE — a control failed, or the DB was not readable
 *
 * ## Why this file exists at all
 *
 * `not-shared-behaviour-probe.mts` defers `get_note` because **a share-scoped
 * caller cannot DISCOVER a note it may not read** — that is what share-scoping
 * means. The deferral is discharged by `NOT_SHARED_NOTE_ID`.
 *
 * The obvious way to discharge it is to paste an id into a receipt and carry it
 * forward. That is the `2 of 32` defect this card already wrote up: a remembered
 * value has no clock, so nothing re-derives it and it outlives the fact that
 * made it true. Two ways this particular id rots:
 *
 *   1. the note is deleted        → the probe silently reads a NEVER-REAL subject
 *   2. its scope task is shared   → the note becomes VISIBLE, and the probe reads
 *                                   a readable subject while reporting on a hidden one
 *
 * Both turn the probe's `get_note` row into a measurement of something else,
 * and neither announces itself. So the subject is DERIVED on every run.
 *
 * ## How it decides, and why it does not ask the MCP
 *
 * It cannot ask. `get_note` is the tool under test; if it conflates — which is
 * what the probe is there to find out — its answer cannot tell "not shared"
 * from "no such note", so using it to pick the subject is circular.
 *
 * The visibility rule is therefore read from the same place the server reads
 * it: `noteVisibility` / `accessibleTasksCte` in `../src/access.ts`, imported
 * here rather than re-typed, so a change to the rule cannot leave this file
 * quietly asserting the old one.
 *
 * ## Controls, printed at their value whether they pass or fail
 *
 *   POPULATION  brain_notes is non-empty                — an empty table yields
 *               "no hidden note" for the wrong reason
 *   POS-CTL     at least one note IS visible to us      — a visibility function
 *               that returned `hidden` for everything would "find" a subject
 *               on any input, which is the reassuring direction
 *   NEG-CTL     a never-real note id classifies as      — `missing`, not `hidden`:
 *               `missing`                                 the two must not collapse
 *   ROUND-TRIP  the chosen id is re-read from the DB     — proves the row still
 *               and still classifies `hidden`              exists at print time
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { noteVisibility } from '../src/access.js';
import type { Context } from '../src/context.js';
import { getDb } from '../src/db/client.js';

const USER_ID = process.env['GETSHIT_PROBE_USER_ID'] ?? process.env['GETSHIT_USER_ID'];

/**
 * `getDb()` falls back to a LOCAL sqlite file when `GETSHIT_DB_URL` is unset —
 * which does not fail, it succeeds against an empty database and reports
 * "0 notes". That is the reassuring direction from the wrong source, so the
 * workspace credentials are loaded here before the client is ever built, from
 * the same file the web package uses.
 */
const ENV_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'web',
  '.env.local',
);
function loadWorkspaceEnv(): string {
  if (process.env['GETSHIT_DB_URL']) return 'already set in the environment';
  if (!fs.existsSync(ENV_FILE)) return `NOT FOUND at ${ENV_FILE}`;
  for (const l of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    if (!l.includes('=') || l.trim().startsWith('#')) continue;
    const i = l.indexOf('=');
    const k = l.slice(0, i).trim();
    if (k !== 'GETSHIT_DB_URL' && k !== 'GETSHIT_DB_AUTH_TOKEN') continue;
    process.env[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return process.env['GETSHIT_DB_URL'] ? ENV_FILE : `no GETSHIT_DB_URL in ${ENV_FILE}`;
}

function line(label: string, detail: string, ok: boolean | null) {
  const mark = ok === null ? '  ' : ok ? '✅' : '🔴';
  console.log(`  ${label.padEnd(12)}${detail}   ${mark}`);
}

async function main() {
  console.log('# not_shared note subject — derived, never remembered');

  if (!USER_ID) {
    console.log('  🔴 INCONCLUSIVE — no caller identity.');
    console.log('     Set GETSHIT_PROBE_USER_ID to the user the behaviour probe authenticates as.');
    console.log('     Exit 2, never 1: "no hidden note for nobody" is not a reading of anything.');
    process.exit(2);
  }
  console.log(`  caller      ${USER_ID}`);

  const envFrom = loadWorkspaceEnv();
  line('DB', `credentials from ${envFrom}`, Boolean(process.env['GETSHIT_DB_URL']));
  if (!process.env['GETSHIT_DB_URL']) {
    console.log('     Exit 2: with no workspace DB this reads an EMPTY local sqlite file and');
    console.log('     reports "0 notes" — a clean-looking answer about the wrong database.');
    process.exit(2);
  }

  const ctx: Context = { userId: USER_ID };
  const db = getDb();
  const notes = await db.all<{ id: string; user_id: string; scope_task_id: string | null; title: string }>(
    sql`SELECT id, user_id, scope_task_id, title FROM brain_notes ORDER BY created_at`,
  );

  line('POPULATION', `${notes.length} note(s) in brain_notes`, notes.length > 0);
  if (notes.length === 0) {
    console.log('     Exit 2: an empty table cannot distinguish "no hidden note" from "no notes".');
    process.exit(2);
  }

  const seen: { id: string; v: string; scope: string | null; title: string }[] = [];
  for (const n of notes) {
    seen.push({
      id: n.id,
      v: await noteVisibility(ctx, n.id),
      scope: n.scope_task_id,
      title: n.title,
    });
  }
  const hidden = seen.filter((s) => s.v === 'hidden');
  const visible = seen.filter((s) => s.v === 'visible');

  line('POS-CTL', `${visible.length} note(s) VISIBLE to this caller`, visible.length > 0);
  const neg = await noteVisibility(ctx, 'zzzNoSuchNote9X');
  line('NEG-CTL', `a never-real note id → ${neg}`, neg === 'missing');

  if (visible.length === 0 || neg !== 'missing') {
    console.log('     Exit 2: the classifier cannot be shown to return more than one answer,');
    console.log('     so a "hidden" verdict from it carries no information.');
    process.exit(2);
  }

  console.log(`\n  hidden ${hidden.length} · visible ${visible.length} · of ${seen.length}`);
  if (hidden.length === 0) {
    console.log('  🔴 no hidden note exists for this caller — the deferral stands, undischargeable today.');
    console.log('     This is exit 1, a real reading, not a failure of the instrument.');
    process.exit(1);
  }

  // Prefer a note whose scope task exists but is simply not shared — the shape the
  // card is about. A note owned by a wholly different workspace is hidden too, but
  // it tests a coarser boundary.
  const chosen = hidden.find((h) => h.scope !== null) ?? hidden[0]!;
  const again = await noteVisibility(ctx, chosen.id);
  line('ROUND-TRIP', `re-read ${chosen.id} → ${again}`, again === 'hidden');
  if (again !== 'hidden') process.exit(2);

  console.log(`\n  NOT_SHARED_NOTE_ID=${chosen.id}`);
  console.log(`     scope task ${chosen.scope ?? 'NULL'} · ${chosen.title.slice(0, 48)}`);
  console.log('\n  Feed it to the probe in the same command, so the id is never transcribed:');
  console.log('     NOT_SHARED_NOTE_ID=$(npm run -s not-shared-note-subject | sed -n "s/.*NOT_SHARED_NOTE_ID=//p") \\');
  console.log('       npm run not-shared-behaviour');
  process.exit(0);
}

/**
 * A crash must not land on exit 1. Exit 1 is the reading "no hidden note
 * exists"; a thrown query is the instrument failing, which is exit 2.
 */
try {
  await main();
} catch (e) {
  console.log(`  🔴 INCONCLUSIVE — ${(e as Error).message.split('\n')[0]}`);
  console.log('     Exit 2, not 1: a reader that threw has measured nothing.');
  process.exit(2);
}
