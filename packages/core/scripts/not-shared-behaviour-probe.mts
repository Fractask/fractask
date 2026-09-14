/**
 * The `not_shared` BEHAVIOUR probe — the axis the deploy marker does not read.
 *
 * ## Why this file exists
 *
 * `not-shared-deploy-marker.mts` counts how many of prod's tool DESCRIPTIONS
 * carry the string `not_shared`. Its own header states the assumption that
 * makes that a proxy: *"a tool which now ANSWERS `not_shared` also SAYS so in
 * the description."*
 *
 * On 2026-09-14 18:4xZ that assumption was measured against prod and it is
 * false, in the direction that flatters nobody — prod ANSWERS `not_shared` on
 * six tools while DOCUMENTING it on one:
 *
 * ```
 *   subject  TfmR7QJFqluo   the exact id from this card's 2026-09-03 report
 *            get_task, list_comments, list_prompts, list_attachments,
 *            update_task, attach_file   ->  not_shared      ✅ behaviour live
 *            tools/list descriptions     ->  1 of 32        🔴 docs not live
 * ```
 *
 * So the marker's red was true of the DOC axis and was being read as a claim
 * about the ANSWER axis. Those are two objects. A card whose motivating harm
 * is *"it cost me a wrong conclusion"* is about the answer; the marker cannot
 * see the answer at all. This script reads the answer, and the two are meant
 * to be run and quoted together — never one in place of the other.
 *
 * ## What it measures
 *
 * For each probed tool, the SAME call is made twice against two subjects:
 *
 * ```
 *   NOT_SHARED subject   a task that EXISTS and is not shared with this caller
 *   NEVER_REAL subject   an id that was never a row
 * ```
 *
 * A tool PASSES when the two subjects produce different classifications — that
 * is the whole point of the card: *"not shared" is not "not there."* A tool
 * CONFLATES when they produce the same one. `list_tasks` conflates by
 * answering `[]` to both, which is worse than either error text, because `[]`
 * is the SUCCESS shape: it does not report a failure, it reports *"here are
 * the children: none"* — and an agent fills an empty subtree.
 *
 * ## Controls, and what each one stops
 *
 *  - **SUBJECT.** If the NOT_SHARED subject does not actually read as
 *    not-shared, every row below is about the wrong kind of row. Exit 2.
 *    This is checked FIRST: a subject that has since been shared with this
 *    caller would turn the whole probe green for the wrong reason.
 *  - **AUTH.** A garbage bearer returns a well-formed error for every tool,
 *    and a uniform error is indistinguishable from "this tool never
 *    distinguishes". If the garbage run classifies the same as the real run,
 *    this run measured the credential. Exit 2.
 *  - **NEVER-REAL leg.** The second subject is not decoration — it is the
 *    control that lets a `not_shared` reading mean something. Without it,
 *    a build that answered `not_shared` to literally every id would pass.
 *  - **CLASSIFIER.** A synthetic body carrying neither marker must classify
 *    as OTHER. If the classifier cannot return anything but a verdict, its
 *    verdicts are not readings.
 *
 * ## Why the write probes are safe — and why that is not left as an argument
 *
 * `update_task` is sent with an id and no fields — the access assert runs, and
 * nothing is changed even in the world where it succeeds. `attach_file` sends
 * five bytes. `create_task` is sent with a `parentId` that is one of the two
 * subjects, and `createTask` runs `assertAccessibleExists(parentId)` BEFORE the
 * insert (`tasks.ts`), so neither subject can reach the write.
 *
 * Every sentence above is a claim about THIS tree's source. The probe runs
 * against PROD, whose build this tree cannot see — that is the entire premise
 * of the card. So the safety is also MEASURED, by the WRITE-SAFETY control: a
 * write probe that comes back as a non-error did not get refused, which means
 * it may have changed the world. That is reported first and voids the run,
 * because every other `INCONCLUSIVE` here says *"this run measured nothing"*
 * and only this one says *"this run DID something."* A safety argument that
 * cannot fail out loud is a comment.
 *
 * ## Exit codes
 *
 *   0  DISTINGUISHES   every probed tool tells the two subjects apart
 *   1  CONFLATES       at least one does not, and all controls held
 *   2  INCONCLUSIVE    a control failed, or the transport did not answer
 *
 * Run from packages/core:
 *   npx tsx scripts/not-shared-behaviour-probe.mts
 *   npx tsx scripts/not-shared-behaviour-probe.mts --json
 *
 * Override the subjects when these ids stop being the right kind of row:
 *   NOT_SHARED_TASK_ID=... NEVER_REAL_TASK_ID=... npm run not-shared-behaviour
 */
import { readEndpoint, AUTH_NEG_CTL_TOKEN } from './not-shared-deploy-marker.mts';

/**
 * A task that EXISTS and is not shared with the runner. Defaulted to the id
 * from `Tx5g85uLq96D`'s own 2026-09-03 report, so the card's motivating
 * measurement is the one that gets re-run. If this is ever shared with the
 * runner the SUBJECT control fires and the run exits 2 — it does not quietly
 * become a different measurement.
 */
export const NOT_SHARED_TASK_ID = process.env.NOT_SHARED_TASK_ID || 'TfmR7QJFqluo';

/** An id that was never a row. */
export const NEVER_REAL_TASK_ID = process.env.NEVER_REAL_TASK_ID || 'zzzNoSuch9XyZ';

/** An id that was never a NOTE row — the never-real leg for any deferred note probe. */
export const NEVER_REAL_NOTE_ID = process.env.NEVER_REAL_NOTE_ID || 'zzzNoNote9XyZ';

/** Search term for the `search_notes` probe — any substring; the SCOPE is what is under test. */
const NOTE_SEARCH_TERM = 'a';

/** Five bytes, so the attach probe carries a real size/sha pair. */
const PROBE_BYTES = 'probe';
const PROBE_B64 = 'cHJvYmU=';
const PROBE_SHA = 'ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095';

export type Klass = 'NOT_SHARED' | 'NOT_FOUND' | 'EMPTY_SUCCESS' | 'OTHER_OK' | 'OTHER_ERR';

/**
 * Classify one tool answer.
 *
 * Deliberately keyed on the WIRE text rather than on an exception type: the
 * question this card asks is what an agent READS, and an agent reads the
 * string. `EMPTY_SUCCESS` is called out separately from `OTHER_OK` because it
 * is the shape that does not announce itself as a failure.
 */
export function classify(isError: boolean, text: string): Klass {
  const t = text.trim();
  if (/\bnot_shared\b/.test(t)) return 'NOT_SHARED';
  if (/\bnot_found\b/.test(t) || /\bnot found\b/i.test(t)) return 'NOT_FOUND';
  if (isError) return 'OTHER_ERR';
  if (t === '[]' || t === '{}' || t === 'null' || t === '') return 'EMPTY_SUCCESS';
  return 'OTHER_OK';
}

/**
 * A title no real card would carry, used by the `create_task` probe. If a
 * build ever lets that probe through, the row it creates is greppable rather
 * than anonymous — a write you cannot find afterwards is worse than one you
 * can.
 */
export const PROBE_TASK_TITLE = 'NOT-SHARED PROBE — must never be created (not-shared-behaviour-probe)';

/**
 * One probed tool: a name plus how it names the subject in its own arguments.
 *
 * `write: true` marks a call that would MUTATE if it were not refused. Those
 * rows are the ones the WRITE-SAFETY control watches: for a read probe a
 * non-error answer is just an answer, but for a write probe it is a write.
 */
export type Probe = { tool: string; args: (id: string) => Record<string, unknown>; note: string; write?: boolean };

/**
 * The probed set. Each row is a tool an agent reaches for when it is about to
 * draw a conclusion about whether a task is there.
 */
export const PROBES: Probe[] = [
  { tool: 'get_task', args: (id) => ({ id, fields: ['title'] }), note: 'the one hand-written case' },
  { tool: 'list_comments', args: (id) => ({ taskId: id }), note: 'read' },
  { tool: 'list_prompts', args: (id) => ({ taskId: id }), note: 'read' },
  { tool: 'list_attachments', args: (id) => ({ taskId: id }), note: 'read' },
  { tool: 'update_task', args: (id) => ({ id }), note: 'write, no fields — a pure access assert', write: true },
  {
    tool: 'attach_file',
    args: (id) => ({
      taskId: id,
      filename: 'not-shared-probe.txt',
      mimeType: 'text/plain',
      dataBase64: PROBE_B64,
      sizeBytes: PROBE_BYTES.length,
      sha256: PROBE_SHA,
    }),
    note: "this card's motivating tool",
    write: true,
  },
  // The CREATE path, named in this card's own fix brief as
  // *"`create_task(parentId=…)` and friends"* and observed answering
  // `not_shared` by hand on 2026-09-14 20:5xZ before it was ever a row here.
  // It is the one probe where the do-not-recreate wording is load-bearing in
  // the literal sense: `not_found` on a create path is an INVITATION to
  // recreate a task that already exists.
  {
    tool: 'create_task',
    args: (id) => ({ title: PROBE_TASK_TITLE, parentId: id }),
    note: 'WRITE — the create path the card names; not_found here reads as "go ahead, make another"',
    write: true,
  },
  { tool: 'list_tasks', args: (id) => ({ parentId: id }), note: 'COLLECTION — [] is the success shape' },
  // The NOTE surface. `scopeTaskId` IS a task id, so these two take the same
  // subject pair as `list_tasks` — the rows are the right kind of row without
  // needing a note subject at all. Added 2026-09-14 20:4xZ because the card
  // asserted "same for list_notes / search_notes / get_note" from the CODE
  // PATH and nothing had ever called them.
  { tool: 'list_notes', args: (id) => ({ scopeTaskId: id }), note: 'COLLECTION — note surface, scoped by TASK id' },
  {
    tool: 'search_notes',
    args: (id) => ({ query: NOTE_SEARCH_TERM, scopeTaskId: id }),
    note: 'COLLECTION — share-scoped search',
  },
];

/**
 * Probed only when a subject exists for it — and PRINTED either way.
 *
 * `get_note(id)` takes a NOTE id. The task subjects above are not notes, so
 * calling it with them measures two never-real rows and prints a `CONFLATES`
 * that is an artifact of the subject, not a finding about the build. (It does:
 * both answer `null`. That reading was discarded, not published.)
 *
 * A share-scoped caller cannot DISCOVER a note it may not read — that is what
 * share-scoping means — so this box cannot mint the subject itself. The
 * deferral is dischargeable rather than permanent: set `NOT_SHARED_NOTE_ID` to
 * a note that exists and is not shared with the runner and the row is probed
 * like any other.
 */
export const DEFERRED: { tool: string; reason: string; envVar: string }[] = [
  {
    tool: 'get_note',
    reason: 'needs a NOT-SHARED *note* subject; a task id is not a note id, and a share-scoped caller cannot find one',
    envVar: 'NOT_SHARED_NOTE_ID',
  },
];

/**
 * A scope this caller CAN read, holding at least one note. Without it the two
 * `[]` readings from the note tools are a fact about the READER — a note
 * surface that answers `[]` to everything would print the same rows. Defaults
 * to the website-builder venture, which holds `_yV8UcWq4-0_`.
 */
export const READABLE_SCOPE_TASK_ID = process.env.READABLE_SCOPE_TASK_ID || '0kOf10V9thDz';

export type Row = {
  tool: string;
  note: string;
  notShared: Klass;
  neverReal: Klass;
  distinguishes: boolean;
  /** Mirrors `Probe.write` — this call would have mutated had it not been refused. */
  write?: boolean;
  /**
   * A write probe whose call came back as a NON-error, on either leg: it was
   * not refused, so it may have landed. Only meaningful with `write`.
   */
  landed?: boolean;
};

export type Verdict = {
  status: 'DISTINGUISHES' | 'CONFLATES' | 'INCONCLUSIVE';
  reason: string;
  conflating: string[];
  /** Write probes that were NOT refused. Non-empty means this run may have mutated prod. */
  landedWrites: string[];
};

/** Decide from the rows plus every control reading. Pure, so tests can drive it. */
export function decide(args: {
  rows: Row[];
  subjectControlOk: boolean;
  authControlSameAsReal: boolean;
  classifierControlOk: boolean;
  /**
   * Optional and defaulted to `true` so existing callers are unchanged: did a
   * scope this caller CAN read return at least one note? Only meaningful when
   * a note tool is in `rows`.
   */
  scopeReaderControlOk?: boolean;
}): Verdict {
  const conflating = args.rows.filter((r) => !r.distinguishes).map((r) => r.tool);
  const landedWrites = args.rows.filter((r) => r.write && r.landed).map((r) => r.tool);
  const base = { conflating, landedWrites };

  // WRITE-SAFETY first, and it is the only control ordered ahead of SUBJECT.
  // Every other INCONCLUSIVE below says "this run measured nothing". This one
  // says "this run DID something" — a write probe that was not refused reached
  // the mutation. Hiding that behind a reading control would report damage as
  // a methodology note. Derived from the rows rather than passed in, so a
  // caller cannot forget to supply it.
  if (landedWrites.length > 0) {
    return {
      status: 'INCONCLUSIVE',
      reason:
        `a WRITE probe was not refused — ${landedWrites.join(', ')} answered without an error, so this run may have ` +
        `MUTATED the target. Look for a task titled "${PROBE_TASK_TITLE}" and for attachments named ` +
        '"not-shared-probe.txt" before trusting anything else here',
      ...base,
    };
  }
  // Then most-diagnostic first. A wrong subject makes every row below it a
  // reading of the wrong kind of object, and "no tool distinguishes" would be
  // the alarming reading reachable from it.
  if (!args.subjectControlOk) {
    return {
      status: 'INCONCLUSIVE',
      reason:
        `the NOT_SHARED subject (${NOT_SHARED_TASK_ID}) did not read as not-shared — ` +
        'it may have been shared with this caller, or deleted; the rows below are about the wrong kind of row',
      ...base,
    };
  }
  if (args.authControlSameAsReal) {
    return {
      status: 'INCONCLUSIVE',
      reason:
        'the garbage-bearer control classified the same as the real call — this run measured the credential, not the build',
      ...base,
    };
  }
  if (!args.classifierControlOk) {
    return {
      status: 'INCONCLUSIVE',
      reason: 'the classifier control did not return OTHER — its verdicts are not readings',
      ...base,
    };
  }
  // Only asked when a note tool is actually in the set: a note row's `[]` is
  // evidence about share-scoping only if the same reader returns rows for a
  // scope this caller can see. A dead note surface prints identical rows.
  const probesNotes = args.rows.some((r) => r.tool === 'list_notes' || r.tool === 'search_notes');
  if (probesNotes && args.scopeReaderControlOk === false) {
    return {
      status: 'INCONCLUSIVE',
      reason:
        `the note reader returned nothing for ${READABLE_SCOPE_TASK_ID}, a scope this caller CAN read — ` +
        'the note rows below are a fact about the reader, not about share-scoping',
      ...base,
    };
  }
  if (args.rows.length === 0) {
    return { status: 'INCONCLUSIVE', reason: 'no tool was probed — no denominator', ...base };
  }
  return conflating.length === 0
    ? { status: 'DISTINGUISHES', reason: `all ${args.rows.length} probed tool(s) tell the two subjects apart`, ...base }
    : {
        status: 'CONFLATES',
        reason: `${conflating.length} of ${args.rows.length} probed tool(s) answer the same thing to both subjects`,
        ...base,
      };
}

/* ------------------------------------------------------------------ */
/* transport                                                           */
/* ------------------------------------------------------------------ */

export type Answer = { httpStatus: number; isError: boolean; text: string; klass: Klass };

/** One `tools/call`. Never throws on a non-200 — the status IS data. */
export async function callTool(
  url: string,
  auth: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Answer> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: auth,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  let isError = res.status !== 200;
  let text = raw;
  try {
    const body = raw.startsWith('event:')
      ? raw
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n')
      : raw;
    const parsed = JSON.parse(body) as {
      result?: { isError?: boolean; content?: { type: string; text?: string }[] };
      error?: { message?: string };
    };
    if (parsed.error) {
      isError = true;
      text = parsed.error.message ?? body;
    } else if (parsed.result) {
      isError = Boolean(parsed.result.isError);
      text = (parsed.result.content ?? [])
        .map((c) => c.text ?? '')
        .join('\n')
        .trim();
    }
  } catch {
    /* leave the raw text — an unparseable body is still a reading */
  }
  return { httpStatus: res.status, isError, text, klass: classify(isError, text) };
}

/**
 * How many rows a collection answer carries. `-1` means "not a readable list"
 * — an error, or a body that is not an array. Kept distinct from `0` on
 * purpose: a control that failed to execute and a control that executed and
 * found nothing are different facts, and only the second is about the world.
 */
export function countRows(a: Answer): number {
  if (a.isError) return -1;
  try {
    const parsed: unknown = JSON.parse(a.text);
    return Array.isArray(parsed) ? parsed.length : -1;
  } catch {
    return -1;
  }
}

/* ------------------------------------------------------------------ */
/* cli                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const asJson = process.argv.includes('--json');
  const { url, auth } = readEndpoint();

  // SUBJECT control first — before a single write probe is sent.
  const subject = await callTool(url, auth, 'get_task', { id: NOT_SHARED_TASK_ID, fields: ['title'] });
  const subjectControlOk = subject.klass === 'NOT_SHARED';

  // CLASSIFIER control: a body carrying neither marker must not classify as one.
  const classifierControlOk = classify(false, '{"id":"x","title":"a real row"}') === 'OTHER_OK';

  const rows: Row[] = [];
  let authControlSameAsReal = false;
  // SCOPE-READER control: a scope this caller CAN read must yield a note.
  let scopeReaderNotes = -1;
  let scopeReaderControlOk = true;

  if (subjectControlOk) {
    const readable = await callTool(url, auth, 'list_notes', { scopeTaskId: READABLE_SCOPE_TASK_ID });
    scopeReaderNotes = countRows(readable);
    scopeReaderControlOk = scopeReaderNotes > 0;

    for (const p of PROBES) {
      const notShared = await callTool(url, auth, p.tool, p.args(NOT_SHARED_TASK_ID));
      const neverReal = await callTool(url, auth, p.tool, p.args(NEVER_REAL_TASK_ID));
      rows.push({
        tool: p.tool,
        note: p.note,
        notShared: notShared.klass,
        neverReal: neverReal.klass,
        distinguishes: notShared.klass !== neverReal.klass,
        write: p.write,
        // Read off the transport, not off the classification: a refusal is an
        // error, so a write that comes back WITHOUT one reached the mutation.
        landed: p.write ? !notShared.isError || !neverReal.isError : undefined,
      });
    }
    // AUTH control on a tool that DID distinguish, if any — the garbage bearer
    // must not reproduce that reading.
    const witness = rows.find((r) => r.distinguishes) ?? rows[0];
    if (witness) {
      const probe = PROBES.find((p) => p.tool === witness.tool)!;
      const ctlShared = await callTool(url, AUTH_NEG_CTL_TOKEN, witness.tool, probe.args(NOT_SHARED_TASK_ID));
      const ctlReal = await callTool(url, AUTH_NEG_CTL_TOKEN, witness.tool, probe.args(NEVER_REAL_TASK_ID));
      authControlSameAsReal =
        ctlShared.klass === witness.notShared && ctlReal.klass === witness.neverReal;
    }

    // Deferred rows, probed only once their own subject is supplied.
    for (const d of DEFERRED) {
      const subjectId = process.env[d.envVar];
      if (!subjectId) continue;
      const notShared = await callTool(url, auth, d.tool, { id: subjectId });
      const neverReal = await callTool(url, auth, d.tool, { id: NEVER_REAL_NOTE_ID });
      rows.push({
        tool: d.tool,
        note: `subject from ${d.envVar}`,
        notShared: notShared.klass,
        neverReal: neverReal.klass,
        distinguishes: notShared.klass !== neverReal.klass,
      });
    }
  }

  const verdict = decide({ rows, subjectControlOk, authControlSameAsReal, classifierControlOk, scopeReaderControlOk });
  const code = verdict.status === 'DISTINGUISHES' ? 0 : verdict.status === 'CONFLATES' ? 1 : 2;

  const deferred = DEFERRED.filter((d) => !process.env[d.envVar]);

  if (asJson) {
    console.log(
      JSON.stringify(
        { url, NOT_SHARED_TASK_ID, NEVER_REAL_TASK_ID, READABLE_SCOPE_TASK_ID, scopeReaderNotes, rows, deferred, verdict },
        null,
        2,
      ),
    );
    return code;
  }

  const glyph = { DISTINGUISHES: '🟢', CONFLATES: '🔴', INCONCLUSIVE: '⛔' }[verdict.status];
  console.log(`# not_shared BEHAVIOUR probe — ${url}`);
  console.log(`  axis        what the tool ANSWERS. The deploy marker reads what it SAYS — run both.`);
  console.log(`  SUBJECT CTL ${NOT_SHARED_TASK_ID} → ${subject.klass}` + (subjectControlOk ? '   ✅ exists, not shared' : '   ⛔ wrong kind of row'));
  console.log(`  NEVER-REAL  ${NEVER_REAL_TASK_ID}`);
  console.log(
    `  AUTH  CTL   garbage bearer` +
      (subjectControlOk
        ? authControlSameAsReal
          ? '   ⛔ IDENTICAL to the real call'
          : '   ✅ distinguishable'
        : '   — not run (subject control failed first)'),
  );
  console.log(`  CLASS CTL   a body with neither marker → OTHER_OK` + (classifierControlOk ? '   ✅' : '   ⛔'));
  {
    // Printed at zero on purpose: a safety control only visible when it fires
    // is indistinguishable from one that was never run.
    const writes = rows.filter((r) => r.write);
    console.log(
      `  WRITE CTL   ${writes.length} write probe(s) — ${verdict.landedWrites.length} not refused` +
        (!subjectControlOk
          ? '   — not run (subject control failed first)'
          : verdict.landedWrites.length === 0
            ? '   ✅ every write was refused, so nothing was mutated'
            : `   ⛔ ${verdict.landedWrites.join(', ')} LANDED — this run may have changed the target`),
    );
  }
  console.log(
    `  SCOPE CTL   list_notes(${READABLE_SCOPE_TASK_ID}) → ${scopeReaderNotes < 0 ? 'not a readable list' : `${scopeReaderNotes} note(s)`}` +
      (subjectControlOk
        ? scopeReaderControlOk
          ? '   ✅ the note reader returns rows it CAN see'
          : '   ⛔ the note rows below are about the READER'
        : '   — not run (subject control failed first)'),
  );
  console.log('');
  if (rows.length) {
    console.log(`  tool               not-shared subject   never-real subject   verdict`);
    for (const r of rows) {
      console.log(
        `  ${r.tool.padEnd(18)} ${r.notShared.padEnd(20)} ${r.neverReal.padEnd(20)} ` +
          `${r.distinguishes ? '✅ distinguishes' : '🔴 CONFLATES'}   ${r.note}`,
      );
    }
    console.log('');
  }
  // Printed, never dropped: a row removed from the findings list silently
  // reads as a row that passed.
  if (deferred.length) {
    console.log(`  NOT PROBED — ${deferred.length} tool(s), each with the subject it is waiting for:`);
    for (const d of deferred) {
      console.log(`  ${d.tool.padEnd(18)} ${d.reason}`);
      console.log(`  ${''.padEnd(18)} discharge by setting ${d.envVar}=<id>`);
    }
    console.log('');
  }
  console.log(`  ${glyph} ${verdict.status} — ${verdict.reason}`);
  if (verdict.conflating.length) {
    console.log(`     conflating: ${verdict.conflating.join(', ')}`);
    console.log(
      `     note: a CONFLATES row that answers EMPTY_SUCCESS is the worse half — it does not report a failure at all.`,
    );
  }
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (c) => process.exit(c),
    (e: unknown) => {
      console.error(`⛔ INCONCLUSIVE — ${String(e)}`);
      process.exit(2);
    },
  );
}
