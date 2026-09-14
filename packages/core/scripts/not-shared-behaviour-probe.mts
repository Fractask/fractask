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
 * ## Why the write probes are safe
 *
 * `update_task` is sent with an id and no fields — the access assert runs, and
 * nothing is changed even in the world where it succeeds. `attach_file` sends
 * five bytes. Both subjects are refused by construction, and the SUBJECT
 * control aborts the run before either is sent if that stops being true.
 * Nothing here can write to a task this caller can reach.
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

/** One probed tool: a name plus how it names the subject in its own arguments. */
export type Probe = { tool: string; args: (id: string) => Record<string, unknown>; note: string };

/**
 * The probed set. Each row is a tool an agent reaches for when it is about to
 * draw a conclusion about whether a task is there.
 */
export const PROBES: Probe[] = [
  { tool: 'get_task', args: (id) => ({ id, fields: ['title'] }), note: 'the one hand-written case' },
  { tool: 'list_comments', args: (id) => ({ taskId: id }), note: 'read' },
  { tool: 'list_prompts', args: (id) => ({ taskId: id }), note: 'read' },
  { tool: 'list_attachments', args: (id) => ({ taskId: id }), note: 'read' },
  { tool: 'update_task', args: (id) => ({ id }), note: 'write, no fields — a pure access assert' },
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
  },
  { tool: 'list_tasks', args: (id) => ({ parentId: id }), note: 'COLLECTION — [] is the success shape' },
];

export type Row = { tool: string; note: string; notShared: Klass; neverReal: Klass; distinguishes: boolean };

export type Verdict = {
  status: 'DISTINGUISHES' | 'CONFLATES' | 'INCONCLUSIVE';
  reason: string;
  conflating: string[];
};

/** Decide from the rows plus every control reading. Pure, so tests can drive it. */
export function decide(args: {
  rows: Row[];
  subjectControlOk: boolean;
  authControlSameAsReal: boolean;
  classifierControlOk: boolean;
}): Verdict {
  const conflating = args.rows.filter((r) => !r.distinguishes).map((r) => r.tool);
  const base = { conflating };

  // Ordered most-diagnostic first. A wrong subject makes every row below it a
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

  if (subjectControlOk) {
    for (const p of PROBES) {
      const notShared = await callTool(url, auth, p.tool, p.args(NOT_SHARED_TASK_ID));
      const neverReal = await callTool(url, auth, p.tool, p.args(NEVER_REAL_TASK_ID));
      rows.push({
        tool: p.tool,
        note: p.note,
        notShared: notShared.klass,
        neverReal: neverReal.klass,
        distinguishes: notShared.klass !== neverReal.klass,
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
  }

  const verdict = decide({ rows, subjectControlOk, authControlSameAsReal, classifierControlOk });
  const code = verdict.status === 'DISTINGUISHES' ? 0 : verdict.status === 'CONFLATES' ? 1 : 2;

  if (asJson) {
    console.log(JSON.stringify({ url, NOT_SHARED_TASK_ID, NEVER_REAL_TASK_ID, rows, verdict }, null, 2));
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
