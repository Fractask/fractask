/**
 * The NOUN in `not_found`, measured at the ANSWER surface — card `24DfXc7As7I3`.
 *
 * `NotFoundError` (access.ts:6) hardcodes its noun:
 *
 *     constructor(id: string) { super(`Task ${id} not found`) }
 *
 * Every tool that throws it for a NOTE / PROMPT / COMMENT / ATTACHMENT id
 * therefore tells an agent that a **task** is missing. That is the same class
 * of harm this whole card is about — `Tx5g85uLq96D` is "not shared is not not
 * there"; this is "a note is not a task" — and it fails the same way: the
 * message sends the diagnosis somewhere the row never was.
 *
 * ## Why this probe CALLS prod instead of reading access.ts
 *
 * The card's standing correction: `not-shared-marker` reads what a tool SAYS,
 * `not-shared-behaviour` reads what it ANSWERS, and for 27 hours those two
 * disagreed. A source census of `throw new NotFoundError(...)` would be a
 * third thing again — a claim about THIS TREE, whose build prod may not be
 * running. So the subject here is the sentence an agent actually receives.
 *
 * ## The control that makes the reading mean something
 *
 * A row reading `Task <id> not found` is only a DEFECT if the message *could*
 * have carried the right noun. It can, and one tool already proves it:
 *
 *     scratchpad_file(id=<never-real>)  →  "Scratch entry <id> not found"
 *
 * That is the POS-CTL, and it is not synthetic — it is a live row of the same
 * census. Without it, `Task` everywhere is equally explained by "the platform
 * has one noun", and the finding would be about a limitation rather than
 * about five call sites.
 *
 * NEG-CTL: a tool whose id genuinely IS a task id must come back `Task`. If
 * that row ever reads anything else, the matcher is reading the wrong field.
 *
 * ## Both failure directions, because only one of them is loud
 *
 *   a false DEFECT   names a tool that is already correct. Someone re-checks
 *                    it and it costs an hour.
 *   a false OK       is the silent one: a tool answering with the wrong noun
 *                    reads as covered, and the next agent to meet it goes
 *                    looking for a task that was never a task.
 *
 * So an UNMEASURED row — one whose call failed schema validation, or returned
 * no error at all — is reported as UNMEASURED and counted AGAINST coverage.
 * It is never folded into OK.
 *
 * ## Exit codes
 *
 *   0  every probed tool names its referent correctly
 *   1  at least one tool names the wrong noun, and both controls held
 *   2  INCONCLUSIVE — a control failed, or the transport did not answer
 *
 * Run from packages/core:
 *   npx tsx scripts/notfound-noun-probe.mts
 *   npx tsx scripts/notfound-noun-probe.mts --json
 */
import { readEndpoint } from './not-shared-deploy-marker.mts';

/**
 * An id no row has. Deliberately NOT a "not shared" id: this probe is about
 * the noun on the plain not-found path, and a shared-but-hidden row takes the
 * `not_shared` branch instead, which has its own (correct) nouns.
 */
export const NEVER_REAL = 'zzNeverReal9x';

/** The bearer used for the auth control. Must not be a real token. */
export const AUTH_NEG_CTL_TOKEN = 'Bearer zzz-not-a-token';

export type Probe = {
  tool: string;
  /** Arguments to send. The never-real id is substituted by the caller. */
  args: Record<string, unknown>;
  /**
   * What the id in `args` actually refers to — the REFERENT, not the argument
   * name. `id` names a note on update_note, a prompt on cancel_prompt and a
   * task on delete_task; keying on the name would call all three the same row.
   */
  referent: 'task' | 'note' | 'prompt' | 'comment' | 'attachment' | 'scratch';
  /** The noun the message must carry for this referent. */
  expect: RegExp;
  /** Why this row is in the census, in one line. */
  note?: string;
};

/**
 * ⚠️ This list is HAND-BUILT and that is a known weakness, stated here rather
 * than in a receipt: a tool added tomorrow is not in it and the census will
 * not notice. The derived-population discipline `not-shared-behaviour` uses
 * cannot be copied wholesale, because a referent cannot be inferred from a
 * tool's schema — `id` is a string on all of them. What IS derived is the
 * denominator's honesty: every row below either MEASURES or reports
 * UNMEASURED, and `npm run not-shared-behaviour`'s at-risk registry remains
 * the place that knows how many tools exist.
 */
export const PROBES: Probe[] = [
  // Rows whose id IS a task — the NEG-CTL side. These must say "Task".
  { tool: 'list_comments', args: { taskId: NEVER_REAL }, referent: 'task', expect: /^Task /, note: 'NEG-CTL: a real task-id tool' },
  { tool: 'list_attachments', args: { taskId: NEVER_REAL }, referent: 'task', expect: /^Task / },
  { tool: 'list_prompts', args: { taskId: NEVER_REAL }, referent: 'task', expect: /^Task / },
  { tool: 'delete_task', args: { id: NEVER_REAL }, referent: 'task', expect: /^Task / },
  { tool: 'report_shipped', args: { taskId: NEVER_REAL, title: 'noun probe' }, referent: 'task', expect: /^Task / },

  // Rows whose id is NOT a task. These are the subject.
  { tool: 'update_note', args: { id: NEVER_REAL, title: 'noun probe' }, referent: 'note', expect: /^Note / },
  { tool: 'delete_note', args: { id: NEVER_REAL }, referent: 'note', expect: /^Note / },
  { tool: 'cancel_prompt', args: { id: NEVER_REAL }, referent: 'prompt', expect: /^Prompt / },
  { tool: 'delete_comment', args: { id: NEVER_REAL }, referent: 'comment', expect: /^Comment / },
  { tool: 'delete_attachment', args: { id: NEVER_REAL }, referent: 'attachment', expect: /^Attachment / },

  // POS-CTL: the one row that already carries its own noun. If this stops
  // reading "Scratch entry", the whole census is measuring the wrong field.
  {
    tool: 'scratchpad_file',
    args: { id: NEVER_REAL, taskId: NEVER_REAL },
    referent: 'scratch',
    expect: /^Scratch entry /,
    note: 'POS-CTL: proves the message CAN carry a non-task noun',
  },
];

export type Reading = {
  tool: string;
  referent: Probe['referent'];
  /** The error text as the agent receives it, or null if the call did not error. */
  message: string | null;
  verdict: 'OK' | 'WRONG-NOUN' | 'UNMEASURED';
  why: string;
};

/**
 * Classify one reading. Pure, so the tests can drive every branch without a
 * network.
 *
 * `UNMEASURED` exists because the two ways this probe fails to reach its
 * subject — a schema rejection (wrong argument name) and a call that succeeds
 * — both return something, and both would otherwise read as "no defect here".
 */
export function classify(p: Probe, message: string | null): Reading {
  const base = { tool: p.tool, referent: p.referent };
  if (message === null) {
    return { ...base, message, verdict: 'UNMEASURED', why: 'the call did not error — this row has no not-found path to read' };
  }
  // A schema rejection never reached the row, so it says nothing about nouns.
  if (/^error: \[/.test(message) || /invalid_type|invalid_union|invalid_enum/.test(message)) {
    return { ...base, message, verdict: 'UNMEASURED', why: 'the arguments were rejected before the lookup — the probe never reached the row' };
  }
  const body = message.replace(/^(?:not_found|error|forbidden):\s*/, '');
  if (p.expect.test(body)) {
    return { ...base, message: body, verdict: 'OK', why: `names its referent (${p.referent})` };
  }
  return {
    ...base,
    message: body,
    verdict: 'WRONG-NOUN',
    why: `the id is a ${p.referent} and the message calls it a task — an agent reading this goes looking for a task that never existed`,
  };
}

export type Verdict = { status: 'CLEAN' | 'WRONG-NOUN' | 'INCONCLUSIVE'; reason: string };

/**
 * Decide over the whole census. Controls are tested BEFORE the finding, for
 * the reason this repo keeps re-learning: a control answered by the transport
 * produces the alarming reading for free.
 */
export function decide(readings: Reading[], authControlSameAsReal: boolean): Verdict {
  if (authControlSameAsReal) {
    return {
      status: 'INCONCLUSIVE',
      reason: 'the garbage-bearer control returned the SAME response as the real call — this run measured the credential, not the nouns',
    };
  }
  if (readings.length === 0) return { status: 'INCONCLUSIVE', reason: 'no rows probed — no denominator' };

  const pos = readings.find((r) => r.referent === 'scratch');
  if (!pos || pos.verdict !== 'OK') {
    return {
      status: 'INCONCLUSIVE',
      reason:
        'the POS-CTL (scratchpad_file → "Scratch entry …") did not carry its own noun — ' +
        'without it, "Task" everywhere is equally explained by the platform having one noun, and no row below is a defect',
    };
  }
  const negs = readings.filter((r) => r.referent === 'task');
  if (!negs.length || negs.some((r) => r.verdict !== 'OK')) {
    return {
      status: 'INCONCLUSIVE',
      reason: 'a tool whose id genuinely IS a task did not read "Task" — the matcher is reading the wrong field',
    };
  }
  const wrong = readings.filter((r) => r.verdict === 'WRONG-NOUN');
  return wrong.length
    ? { status: 'WRONG-NOUN', reason: `${wrong.length} tool(s) name the wrong noun: ${wrong.map((r) => r.tool).join(', ')}` }
    : { status: 'CLEAN', reason: 'every probed tool names its referent' };
}

/* ------------------------------------------------------------------ */
/* transport                                                           */
/* ------------------------------------------------------------------ */

/** One `tools/call`. Never throws — the error text IS the measurement. */
export async function callTool(
  url: string,
  auth: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; message: string | null; raw: string }> {
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
  const body = raw.startsWith('event:')
    ? raw
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n')
    : raw;
  let message: string | null = null;
  try {
    const parsed = JSON.parse(body) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
    const text = parsed.result?.content?.[0]?.text ?? parsed.error?.message ?? '';
    // A successful call returns data, not a sentence. Only an error shape is a
    // reading; anything else is UNMEASURED and says so.
    if (/^(?:not_found|not_shared|error|forbidden):/.test(text)) message = text;
  } catch {
    message = null;
  }
  return { status: res.status, message, raw };
}

/* ------------------------------------------------------------------ */
/* cli                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const asJson = process.argv.includes('--json');
  const { url, auth } = readEndpoint();

  // AUTH control first — a 403 makes every row read UNMEASURED, which is a
  // true sentence pointing at prod when the cause is the credential.
  const realCtl = await callTool(url, auth, 'list_comments', { taskId: NEVER_REAL });
  const garbCtl = await callTool(url, AUTH_NEG_CTL_TOKEN, 'list_comments', { taskId: NEVER_REAL });
  const authControlSameAsReal = realCtl.status === garbCtl.status && realCtl.raw === garbCtl.raw;

  const readings: Reading[] = [];
  for (const p of PROBES) {
    const r = await callTool(url, auth, p.tool, p.args);
    readings.push(classify(p, r.message));
  }

  const verdict = decide(readings, authControlSameAsReal);
  const code = verdict.status === 'CLEAN' ? 0 : verdict.status === 'WRONG-NOUN' ? 1 : 2;

  if (asJson) {
    console.log(JSON.stringify({ url, readings, verdict }, null, 2));
    return code;
  }

  const glyph = { CLEAN: '🟢', 'WRONG-NOUN': '🔴', INCONCLUSIVE: '⛔' }[verdict.status];
  console.log(`# the NOUN in not_found — ${url}`);
  console.log(`  SUBJECT     a never-real id (${NEVER_REAL}) — the PLAIN not-found path, not not_shared`);
  console.log(
    `  AUTH  CTL   garbage bearer → http ${garbCtl.status}` +
      (authControlSameAsReal ? '   ⛔ IDENTICAL to the real call' : '   ✅ distinguishable'),
  );
  console.log('');
  for (const r of readings) {
    const g = r.verdict === 'OK' ? '✅' : r.verdict === 'WRONG-NOUN' ? '🔴' : '⚪';
    const tag = r.referent === 'scratch' ? ' (POS-CTL)' : r.referent === 'task' ? ' (NEG-CTL)' : '';
    console.log(`  ${g} ${r.tool.padEnd(20)} id is a ${r.referent.padEnd(11)}${tag}`);
    console.log(`       ${r.message ?? '(no error path)'}`);
    if (r.verdict !== 'OK') console.log(`       ${r.why}`);
  }
  const n = (v: Reading['verdict']) => readings.filter((r) => r.verdict === v).length;
  console.log('');
  console.log(`  ${n('OK')} OK · ${n('WRONG-NOUN')} WRONG-NOUN · ${n('UNMEASURED')} UNMEASURED  of ${readings.length} probed`);
  console.log('  UNMEASURED is counted AGAINST coverage, never folded into OK — a row the probe');
  console.log('  could not reach is not a row that came back clean.');
  console.log('');
  console.log(`${glyph} ${verdict.status} — ${verdict.reason}`);
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`⛔ INCONCLUSIVE — ${(err as Error).message}`);
      process.exit(2);
    },
  );
}
