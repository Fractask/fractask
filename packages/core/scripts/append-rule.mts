/**
 * Append a numbered precondition to a task's `rules` field, with the
 * capture → re-read → compare → write → read-back discipline the department
 * charter requires, and the drift guard that makes it safe.
 *
 * Usage: npx tsx scripts/append-rule.mts <taskId> <fileWithTheAppendedText>
 *
 * The appended text is read from a FILE, never passed as an argument — a 40 KB
 * field passed through a tool call is the shape that gets silently truncated.
 */
import fs from 'node:fs';
import { readEndpoint } from './not-shared-deploy-marker.mts';
import { callTool } from './not-shared-behaviour-probe.mts';
import crypto from 'node:crypto';

const [taskId, appendFile] = process.argv.slice(2);
if (!taskId || !appendFile) throw new Error('usage: append-rule.mts <taskId> <appendFile>');

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

const capture = await readRules();
console.log(`  capture       ${utf16(capture)} UTF-16 units  sha256[:16] ${sha(capture)}`);

const reread = await readRules();
console.log(
  `  RE-READ live  ${utf16(reread)}  sha256[:16] ${sha(reread)}  ` +
    (reread === capture ? '✅ identical — nothing moved in the gap, so nothing was clobbered' : '🔴 DRIFT — ABORT'),
);
if (reread !== capture) process.exit(2);

const append = fs.readFileSync(appendFile, 'utf8');
const intended = capture + append;
console.log(`  intended      ${utf16(intended)}  sha256[:16] ${sha(intended)}  delta +${utf16(append)}`);
if (utf16(intended) > 50_000) throw new Error(`REFUSING: ${utf16(intended)} UTF-16 units exceeds the 50,000 cap`);

const w = await callTool(url, auth, 'update_task', { id: taskId, rules: intended });
console.log(`  write         isError=${w.isError} ${w.text.slice(0, 160)}`);
if (w.isError) process.exit(1);

const after = await readRules();
console.log(
  `  live AFTER    ${utf16(after)}  sha256[:16] ${sha(after)}  ` +
    (after === intended ? '== intended ✅ byte-identical' : '🔴 NOT what was intended'),
);
console.log(`  pure APPEND   ${after.startsWith(capture) ? '✅' : '🔴 the old text did not survive'}`);
console.log(`  headroom      ${50_000 - utf16(after)} of the 50k cap`);

// POS/NEG controls on the house form — `N. ` at the start of a line.
for (const n of [19, 20, 21, 22, 23, 24]) {
  const re = new RegExp(`^${n}\\. `, 'm');
  console.log(`  POS-CTL  /^${n}\\. /m → ${re.test(after) ? 1 : 0}`);
}
for (const n of [25, 26]) {
  const re = new RegExp(`^${n}\\. `, 'm');
  console.log(`  NEG-CTL  /^${n}\\. /m → ${re.test(after) ? '🔴 1' : '0 ✅'}`);
}
console.log(`  NEG-CTL  zzzNoSuchMarker → ${after.includes('zzzNoSuchMarker') ? '🔴 1' : '0 ✅'}`);
