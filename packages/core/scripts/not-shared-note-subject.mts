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
import { resolveTokenToUser } from '../src/auth.js';
import type { Context } from '../src/context.js';
import { getDb } from '../src/db/client.js';
import { readEndpoint } from './not-shared-deploy-marker.mts';

const ENV_USER_ID = process.env['GETSHIT_PROBE_USER_ID'] ?? process.env['GETSHIT_USER_ID'];

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

/**
 * ## Who is "this caller"? — and why an env var is the wrong answer
 *
 * Until 2026-09-16 the identity came from `GETSHIT_PROBE_USER_ID` alone: a
 * hand-typed id, with nothing tying it to the credential the behaviour probe
 * actually authenticates with. Two failures follow from that, and neither one
 * announces itself:
 *
 *   1. **nobody passes it.** `npm run not-shared-note-subject` with a bare
 *      environment exits 2, so the discharge is a remedy behind a flag — and
 *      the probe's default run then reports `get_note` as NOT PROBED, which is
 *      the BETTER-LOOKING verdict. Measured this morning: the default command
 *      printed `3 of 18 conflate` while the discharged run prints `4 of 19`.
 *   2. **a typed id can name a DIFFERENT user than the token does.** The whole
 *      output would then be a true statement about a note hidden from someone
 *      else, while reading as a statement about the prober.
 *
 * So the identity is RESOLVED FROM THE PROBE'S OWN BEARER TOKEN, through the
 * server's own `resolveTokenToUser` — the same function `/api/mcp` uses to
 * decide who a call is. The env var still works, and when both are present
 * they are CROSS-CHECKED: a disagreement is INCONCLUSIVE, not a preference.
 *
 * Side effect, stated because it is a write: `resolveTokenToUser` stamps
 * `cli_tokens.lastUsedAt`. That is the same write any MCP call makes, so it
 * mutates nothing this probe reports on.
 */
export type CallerIdentity = {
  id: string | null;
  from: 'env' | 'token' | 'env+token (agree)' | 'none';
  mismatch?: string;
};

/**
 * The decision alone, with no DB and no endpoint in it, so the cross-check can
 * be pinned by a test. `resolveCaller` below is the IO that feeds it.
 *
 * Note which way the disagreement resolves: to NOTHING. Preferring either side
 * would publish a subject derived for one identity under the other's name, and
 * that is the failure this cross-check exists to catch — so it refuses.
 */
export function decideCaller(
  envId: string | undefined,
  tokenId: string | null,
  tokenErr: string,
): CallerIdentity {
  if (envId && tokenId) {
    if (envId !== tokenId) {
      return {
        id: null,
        from: 'none',
        mismatch: `GETSHIT_PROBE_USER_ID=${envId} but the bearer token belongs to ${tokenId}`,
      };
    }
    return { id: tokenId, from: 'env+token (agree)' };
  }
  if (tokenId) return { id: tokenId, from: 'token' };
  if (envId) return { id: envId, from: 'env' };
  return { id: null, from: 'none', mismatch: tokenErr };
}

export async function resolveCaller(): Promise<CallerIdentity> {
  let tokenId: string | null = null;
  let tokenErr = '';
  try {
    const { auth } = readEndpoint();
    const raw = auth.replace(/^Bearer\s+/i, '').trim();
    tokenId = raw ? ((await resolveTokenToUser(raw))?.id ?? null) : null;
    if (!tokenId) tokenErr = 'the bearer token resolves to no user';
  } catch (e) {
    tokenErr = (e as Error).message.split('\n')[0] ?? 'endpoint unreadable';
  }
  return decideCaller(ENV_USER_ID, tokenId, tokenErr);
}

export type NoteSubject =
  | { status: 'DERIVED'; noteId: string; callerId: string; scope: string | null; title: string; lines: string[] }
  | { status: 'NONE'; callerId: string; lines: string[] }
  | { status: 'INCONCLUSIVE'; reason: string; lines: string[] };

/**
 * The whole derivation, as a value rather than as printed output, so the
 * behaviour probe can run it in-process instead of asking a human to paste an
 * id between two commands. `lines` carries the controls at their measured
 * values — a caller that hides them is publishing a subject nobody can audit.
 */
export async function deriveNotSharedNoteSubject(): Promise<NoteSubject> {
  const lines: string[] = [];
  const line = (label: string, detail: string, ok: boolean | null) => {
    const mark = ok === null ? '  ' : ok ? '✅' : '🔴';
    lines.push(`  ${label.padEnd(12)}${detail}   ${mark}`);
  };

  // ORDER IS LOAD-BEARING: the credentials come first because resolving the
  // caller is itself a DB read (`cli_tokens`). Written the other way round on
  // the first attempt, and the failure was instructive — `getDb()` fell back to
  // the empty local sqlite file and the token lookup threw "Failed query:
  // select … from cli_tokens", which reads as a broken token rather than as a
  // missing database. On a local file that HAPPENED to carry the table it would
  // not have thrown at all: it would have resolved to "no such token" and the
  // whole run would have reported on nobody, quietly.
  const envFrom = loadWorkspaceEnv();
  line('DB', `credentials from ${envFrom}`, Boolean(process.env['GETSHIT_DB_URL']));
  if (!process.env['GETSHIT_DB_URL']) {
    return {
      status: 'INCONCLUSIVE',
      reason: 'no workspace DB — getDb() would read an EMPTY local sqlite file and report "0 notes"',
      lines,
    };
  }

  const caller = await resolveCaller();
  if (!caller.id) {
    lines.push(`  caller      🔴 UNRESOLVED — ${caller.mismatch ?? 'no identity available'}`);
    return {
      status: 'INCONCLUSIVE',
      reason: caller.mismatch ?? 'no caller identity',
      lines,
    };
  }
  line('caller', `${caller.id}   (from ${caller.from})`, true);

  const ctx: Context = { userId: caller.id };
  const db = getDb();
  const notes = await db.all<{ id: string; user_id: string; scope_task_id: string | null; title: string }>(
    sql`SELECT id, user_id, scope_task_id, title FROM brain_notes ORDER BY created_at`,
  );

  line('POPULATION', `${notes.length} note(s) in brain_notes`, notes.length > 0);
  if (notes.length === 0) {
    return {
      status: 'INCONCLUSIVE',
      reason: 'brain_notes is empty — cannot distinguish "no hidden note" from "no notes"',
      lines,
    };
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
    return {
      status: 'INCONCLUSIVE',
      reason:
        'the classifier cannot be shown to return more than one answer, so a "hidden" verdict from it carries no information',
      lines,
    };
  }

  lines.push(`  hidden ${hidden.length} · visible ${visible.length} · of ${seen.length}`);
  if (hidden.length === 0) {
    return { status: 'NONE', callerId: caller.id, lines };
  }

  // Prefer a note whose scope task exists but is simply not shared — the shape the
  // card is about. A note owned by a wholly different workspace is hidden too, but
  // it tests a coarser boundary.
  const chosen = hidden.find((h) => h.scope !== null) ?? hidden[0]!;
  const again = await noteVisibility(ctx, chosen.id);
  line('ROUND-TRIP', `re-read ${chosen.id} → ${again}`, again === 'hidden');
  if (again !== 'hidden') {
    return {
      status: 'INCONCLUSIVE',
      reason: `the chosen note ${chosen.id} no longer classifies hidden on re-read (${again})`,
      lines,
    };
  }

  return {
    status: 'DERIVED',
    noteId: chosen.id,
    callerId: caller.id,
    scope: chosen.scope,
    title: chosen.title,
    lines,
  };
}

/**
 * A crash must not land on exit 1. Exit 1 is the reading "no hidden note
 * exists"; a thrown query is the instrument failing, which is exit 2.
 */
export function exitCodeFor(r: NoteSubject): number {
  return r.status === 'DERIVED' ? 0 : r.status === 'NONE' ? 1 : 2;
}

async function main(): Promise<number> {
  console.log('# not_shared note subject — derived, never remembered');
  const r = await deriveNotSharedNoteSubject();
  for (const l of r.lines) console.log(l);

  if (r.status === 'INCONCLUSIVE') {
    console.log(`  🔴 INCONCLUSIVE — ${r.reason}`);
    console.log('     Exit 2, never 1: a reader that measured nothing is not the reading "none exists".');
    return 2;
  }
  if (r.status === 'NONE') {
    console.log('  🔴 no hidden note exists for this caller — the deferral stands, undischargeable today.');
    console.log('     This is exit 1, a real reading, not a failure of the instrument.');
    return 1;
  }

  console.log(`\n  NOT_SHARED_NOTE_ID=${r.noteId}`);
  console.log(`     scope task ${r.scope ?? 'NULL'} · ${r.title.slice(0, 48)}`);
  console.log('\n  The behaviour probe now runs this derivation ITSELF when NOT_SHARED_NOTE_ID is');
  console.log('  unset, so there is nothing to paste between commands. Set the env var only to');
  console.log('  pin a specific subject — it is cross-checked, not merely preferred.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(await main());
  } catch (e) {
    console.log(`  🔴 INCONCLUSIVE — ${(e as Error).message.split('\n')[0]}`);
    console.log('     Exit 2, not 1: a reader that threw has measured nothing.');
    process.exit(2);
  }
}
