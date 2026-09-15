/**
 * Amend a task's `rules` field: apply exact-match REPLACEMENTS in place, then
 * append, under the same capture → re-read → compare → write → read-back
 * discipline `append-rule.mts` uses, plus the drift guard.
 *
 * `append-rule.mts` can only add. That is the right default for a ledger, and
 * it is the wrong tool when a numbered precondition contains a WRONG worked
 * example: a correction filed 3,000 characters below the rule it corrects is
 * not read by anybody who reads the rule. So this one edits in place — and
 * because an in-place edit is the dangerous shape, every replacement must match
 * EXACTLY ONCE or the whole run refuses before it writes anything.
 *
 * Usage: npx tsx scripts/amend-rule.mts <taskId> <editsJsonFile>
 *   edits: { replace?: [{ from: string, to: string }], append?: string }
 *
 * Both the edits and the appended text are read from a FILE, never passed as an
 * argument — a 40 KB field through a tool call is the shape that gets silently
 * truncated.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { readEndpoint } from './not-shared-deploy-marker.mts';
import { callTool } from './not-shared-behaviour-probe.mts';

const [taskId, editsFile] = process.argv.slice(2);
if (!taskId || !editsFile) throw new Error('usage: amend-rule.mts <taskId> <editsJsonFile>');

const { url, auth } = readEndpoint();
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const utf16 = (s: string) => s.length;

/** Read `rules` with a call that is NOT the write's own echo. */
async function readRules(): Promise<string> {
  const a = await callTool(url, auth, 'list_tasks', {
    parentId: null,
    deep: true,
    assigneeId: 'qFej-PIgK5FM',
    fields: ['rules'],
  });
  if (a.isError) throw new Error(`read failed: ${a.text.slice(0, 200)}`);
  const rows = JSON.parse(a.text) as { id: string; rules?: string | null }[];
  const row = rows.find((r) => r.id === taskId);
  // TRANSPORT CTL — the row must carry this card's id. A 403 parses to zero
  // rows, and zero rows would read as "the field is empty".
  if (!row) throw new Error(`TRANSPORT CTL failed: ${rows.length} row(s) read, none is ${taskId}`);
  return row.rules ?? '';
}

const edits = JSON.parse(fs.readFileSync(editsFile, 'utf8')) as {
  replace?: { from: string; to: string }[];
  append?: string;
};

const capture = await readRules();
console.log(`  capture       ${utf16(capture)} UTF-16 units  sha256[:16] ${sha(capture)}`);

const reread = await readRules();
console.log(
  `  RE-READ live  ${utf16(reread)}  sha256[:16] ${sha(reread)}  ` +
    (reread === capture ? '✅ identical — nothing moved in the gap, so nothing was clobbered' : '🔴 DRIFT — ABORT'),
);
if (reread !== capture) process.exit(2);

// ── MATCH CTL — ordered ahead of the first character of output ──────────────
// Every `from` must occur exactly once. Zero means the text moved and the edit
// would silently do nothing; more than one means the edit lands somewhere it
// was not aimed. Both refuse, and they refuse BEFORE any replacement runs, so a
// partial amendment is not a reachable state.
let text = capture;
for (const r of edits.replace ?? []) {
  const n = text.split(r.from).length - 1;
  console.log(`  MATCH-CTL     ${n} occurrence(s) of ${JSON.stringify(r.from.slice(0, 60))}…  ${n === 1 ? '✅' : '🔴'}`);
  if (n !== 1) {
    console.error(`⛔ REFUSING: expected exactly 1 occurrence, found ${n}. Nothing was written.`);
    process.exit(2);
  }
}
for (const r of edits.replace ?? []) text = text.split(r.from).join(r.to);
if (edits.append) text += edits.append;

console.log(
  `  intended      ${utf16(text)}  sha256[:16] ${sha(text)}  delta ${utf16(text) - utf16(capture) >= 0 ? '+' : ''}${utf16(text) - utf16(capture)}`,
);
if (utf16(text) > 50_000) throw new Error(`REFUSING: ${utf16(text)} UTF-16 units exceeds the 50,000 cap`);

const w = await callTool(url, auth, 'update_task', { id: taskId, rules: text });
console.log(`  write         isError=${w.isError} ${w.text.slice(0, 160)}`);
if (w.isError) process.exit(1);

const after = await readRules();
console.log(
  `  live AFTER    ${utf16(after)}  sha256[:16] ${sha(after)}  ` +
    (after === text ? '== intended ✅ byte-identical' : '🔴 NOT what was intended'),
);

// ── READ-BACK CTL — the replacement is verified on the LIVE field, both
// directions. The `to` must be present and the `from` must be gone; asserting
// only the first would pass on a field where both spellings now exist.
for (const r of edits.replace ?? []) {
  const gone = !after.includes(r.from);
  const landed = after.includes(r.to);
  console.log(`  READ-BACK     old text gone ${gone ? '✅' : '🔴'} · new text present ${landed ? '✅' : '🔴'}`);
}
console.log(`  headroom      ${50_000 - utf16(after)} of the 50k cap`);

// POS-CTL on the house form — `N. ` at the start of a line.
for (const n of [22, 23, 24, 25]) {
  const re = new RegExp(`^${n}\\. `, 'm');
  console.log(`  POS-CTL  /^${n}\\. /m → ${re.test(after) ? 1 : 0}`);
}
