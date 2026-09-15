/**
 * ONE-OFF hand probe — `ask_human` against prod, before it is encoded as a row.
 *
 * Precondition 18: measure the candidate BEFORE writing the row, and measure it
 * against prod rather than against this tree's source. `createPrompt`
 * (`prompts.ts:598`) asserts access on `taskId` FIRST, ahead of the agent deck
 * check (`:606`), the addressing check (`:616`) and the goal validation
 * (`:623`) — all four of which throw before the insert at `:632`. That ordering
 * is what makes the REACH leg safe, and it is exactly the claim prod may not
 * share, so it is measured here rather than argued.
 *
 * SAFE BY CONSTRUCTION, in EITHER assert order: the args carry no `deck` /
 * `recommendation` / `estSeconds` (so the agent packaging check throws) AND a
 * `goalTaskId` naming a kind="task" row (so the goal validation throws). Both
 * guards sit ahead of the insert, so the only way a prompt lands is a build
 * with neither — which WRITE-SAFETY below would see.
 */
import { readEndpoint } from './not-shared-deploy-marker.mts';
import { callTool } from './not-shared-behaviour-probe.mts';

const READABLE = 'Tx5g85uLq96D';
const NOT_SHARED = 'TfmR7QJFqluo';
const NEVER_REAL = 'zzzNoSuch9XyZ';
/** kind="task", readable — so the goal validation refuses it. */
const NON_GOAL = 'Tx5g85uLq96D';
const MARKER = 'zzz-ask-human-order-probe-do-not-answer';

const { url, auth } = readEndpoint();

const args = (subject: string) => ({
  taskId: subject,
  kind: 'text',
  prompt: MARKER,
  goalTaskId: NON_GOAL,
});

const stamp = () => new Date().toISOString();

console.log(`# ask_human hand probe — ${url}`);
console.log(`  started ${stamp()}`);

// WRITE-SAFETY, before
const before = await callTool(url, auth, 'list_prompts', { taskId: READABLE });
const beforeStatus = await callTool(url, auth, 'get_task', { id: READABLE, fields: ['status'] });
console.log(`\n  WRITE-SAFETY before  list_prompts(${READABLE}) ${before.text.length} B`);
console.log(`                       get_task.status ${beforeStatus.text.slice(0, 200)}`);

const legs: { label: string; subject: string }[] = [
  { label: 'not-shared', subject: NOT_SHARED },
  { label: 'never-real', subject: NEVER_REAL },
  { label: 'readable  ', subject: READABLE },
];

console.log('');
for (const leg of legs) {
  const a = await callTool(url, auth, 'ask_human', args(leg.subject));
  console.log(`  ${leg.label}  ${leg.subject.padEnd(14)} http ${a.httpStatus} isError=${a.isError} klass=${a.klass}`);
  console.log(`     ${a.text.replace(/\n/g, '\n     ').slice(0, 900)}`);
  console.log('');
}

// WRITE-SAFETY, after
const after = await callTool(url, auth, 'list_prompts', { taskId: READABLE });
const afterStatus = await callTool(url, auth, 'get_task', { id: READABLE, fields: ['status'] });
console.log(`  WRITE-SAFETY after   list_prompts(${READABLE}) ${after.text.length} B`);
console.log(`                       get_task.status ${afterStatus.text.slice(0, 200)}`);
console.log(
  `  IDENTICAL prompts ${before.text === after.text ? '✅' : '🔴 A PROMPT LANDED'} · status ${
    beforeStatus.text === afterStatus.text ? '✅' : '🔴 STATUS MOVED'
  }`,
);
console.log(`  MARKER in prompts after: ${after.text.includes(MARKER) ? '🔴 PRESENT' : '✅ absent'}`);
console.log(`  finished ${stamp()}`);
