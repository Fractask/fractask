/**
 * `attach_file_from_url` — does PROD resolve the subject BEFORE it fetches?
 *
 * ## Why this is its own command and not a row in `not-shared-behaviour-probe`
 *
 * Every other row on that table is a function of ONE argument: vary the id,
 * read the verdict. This tool's verdict is a function of **two** — the id and
 * the url — and the two legs disagree. Measured against prod 2026-09-15 09:4xZ,
 * same identity, same minute:
 *
 * ```
 *   taskId=TfmR7QJFqluo  url=<unfetchable>   →  error: fetch failed      OTHER_ERR
 *   taskId=TfmR7QJFqluo  url=<fetchable>     →  not_shared: Task TfmR…   NOT_SHARED
 * ```
 *
 * One id, one identity, two answers, decided by an argument that has nothing to
 * do with access. That is this card's founding sentence one level in: the 2026-09-03
 * version was *the same id gives two answers depending on which TOOL you ask*.
 *
 * **So the probe's own second argument decides its verdict, and BOTH single-url
 * designs are wrong in opposite directions:**
 *
 * - fetchable url only  → the row scores `DISTINGUISHES`. Green, and the defect
 *   is invisible — the downstream `createAttachment` assert catches it once the
 *   fetch has already happened.
 * - unfetchable url only → the row scores `CONFLATES`, which is the right
 *   verdict for the wrong reason, and it trips precondition 12: a READABLE
 *   subject answers `fetch failed` too, so all three subjects are identical and
 *   *three identical rows is what turns "this tool conflates" into "this tool
 *   was never asked."* The reading would be unfalsifiable from the outcome.
 *
 * It takes both legs to say anything, which is why this is a command rather
 * than a row. Encoding it INTO the table means giving `Probe` a second
 * dimension; that is named as the next unit, not done here.
 *
 * ## What the two legs prove together
 *
 * The fetchable leg proves the call REACHES the handler (precondition 12): it
 * returns a handler-level verdict, and a DIFFERENT one per subject. The
 * unfetchable leg then shows that same handler answering a network outcome
 * instead of an access verdict for the same id. The only order that explains
 * both readings is fetch-then-assert — and the assert that finally refuses is
 * `createAttachment`'s, downstream, after the body is already buffered.
 *
 * This tree does NOT have that order: `addAttachmentFromUrl` hoists
 * `resolveAttachmentParent` above the fetch (`cac5680`, 2026-09-13 20:57:21Z),
 * with three tests at `tasks.test.ts:1919`. Prod's build predates it. So this
 * probe is a claim about the DEPLOY, and it exits 0 — loudly, telling you to
 * delete it — the moment prod catches up.
 *
 * ## Safety
 *
 * The fetchable url is paired ONLY with subjects that are refused downstream.
 * It is never sent with a readable subject, because that pairing is the one
 * combination that would actually create an attachment. `SAFE_PAIRINGS` is
 * pinned by a test so a later edit cannot quietly add the dangerous one.
 *
 * Both urls have a PRECONDITION read from THIS box before prod is asked, and
 * the run REFUSES rather than degrading when either fails (precondition 16 — a
 * probe whose power depends on a fixture's state must assert that state; and
 * the 09:4xZ hand pass printed `NO — REFUSING` and then carried on regardless,
 * which is the defect this gate exists to stop repeating).
 *
 * Exit: 0 PROD-HOISTED (defect gone — delete this file) · 1 ORDER-DEFECT LIVE ·
 *       2 INCONCLUSIVE (a precondition or control did not hold).
 */
import { readEndpoint } from './not-shared-deploy-marker.mts';
import {
  callTool,
  classify,
  NOT_SHARED_TASK_ID,
  NEVER_REAL_TASK_ID,
  NEVER_REAL_NOTE_ID,
  AFU_UNFETCHABLE_URL as UNFETCHABLE_URL,
  afuFetchableUrlFor as fetchableUrlFor,
  afuPairingIsSafe as pairingIsSafe,
  checkUrlPreconditions,
  type Answer,
  type Klass,
} from './not-shared-behaviour-probe.mts';

/** A task this caller can definitely read — precondition 12's third subject. */
export const READABLE_TASK_ID = process.env.READABLE_TASK_ID || 'Tx5g85uLq96D';

/**
 * The url dimension itself now lives in `not-shared-behaviour-probe.mts`, where
 * `attach_file_from_url` is a two-variant ROW as of 2026-09-15 11:5xZ. These
 * re-exports keep one definition of the safety table rather than two copies
 * that can drift — this file's suite and the table's suite pin the same object.
 *
 * This command is NOT superseded by that row and must not be deleted for it.
 * It carries three things the table cannot: the never-real NOTE leg, the
 * WRITE-SAFETY before/after read of a readable task's attachments, and a
 * `PROD-HOISTED` exit that tells you the defect is gone.
 */
export { AFU_SAFE_PAIRINGS as SAFE_PAIRINGS, type UrlPrecondition } from './not-shared-behaviour-probe.mts';
export { UNFETCHABLE_URL, fetchableUrlFor, pairingIsSafe, checkUrlPreconditions };

export type OrderReading = {
  notSharedUnfetchable: Klass;
  notSharedFetchable: Klass;
  neverRealFetchable: Klass;
  readableUnfetchable: Klass;
  noteFetchable: Klass;
  noteUnfetchable: Klass;
};

export type OrderVerdict = {
  status: 'PROD-HOISTED' | 'ORDER-DEFECT-LIVE' | 'INCONCLUSIVE';
  reason: string;
  /** Did the fetchable leg return DIFFERENT handler verdicts per subject? */
  reachOk: boolean;
  /** Does the note leg share the task leg's order? */
  noteLegSameOrder: boolean | null;
};

/**
 * Pure, so the tests can drive every world including the fixed one.
 *
 * ⚠️ Precondition 19 governs the shape of this function: asked *what does this
 * print if the defect has been fixed?* the answer must be a verdict about the
 * WORLD, not `INCONCLUSIVE` about the instrument. The fixed world is
 * `PROD-HOISTED`, exit 0, with an instruction to delete this file — a control
 * keyed on the defect would have alarmed there instead.
 */
export function decideOrder(r: OrderReading, preconditionsOk: boolean): OrderVerdict {
  if (!preconditionsOk) {
    return {
      status: 'INCONCLUSIVE',
      reason: 'a url precondition did not hold — this run measured nothing, and did not send the probe',
      reachOk: false,
      noteLegSameOrder: null,
    };
  }

  // REACH first (precondition 12): before reading any verdict, prove the call
  // got past the transport and the zod parse and into the handler. Two
  // DIFFERENT handler-level verdicts on the fetchable leg is that proof.
  const reachOk =
    r.notSharedFetchable === 'NOT_SHARED' &&
    r.neverRealFetchable === 'NOT_FOUND' &&
    r.notSharedFetchable !== r.neverRealFetchable;

  if (!reachOk) {
    return {
      status: 'INCONCLUSIVE',
      reason:
        `the fetchable leg did not return two distinct handler verdicts ` +
        `(not-shared → ${r.notSharedFetchable}, never-real → ${r.neverRealFetchable}), ` +
        'so nothing here is known to have reached the access layer at all',
      reachOk: false,
      noteLegSameOrder: null,
    };
  }

  const noteLegSameOrder = r.noteUnfetchable === 'OTHER_ERR' && r.noteFetchable === 'NOT_FOUND';

  // The ORDER reading itself. One id, one identity, two urls.
  if (r.notSharedUnfetchable === 'NOT_SHARED') {
    return {
      status: 'PROD-HOISTED',
      reason:
        'the not-shared subject answers not_shared even when the url cannot be fetched, so the access assert now ' +
        'runs FIRST. The defect this file measures is gone from prod — delete this probe and encode ' +
        'attach_file_from_url as an ordinary row in not-shared-behaviour-probe; do not just quote this green',
      reachOk,
      noteLegSameOrder,
    };
  }

  if (r.notSharedUnfetchable === 'OTHER_ERR' && r.readableUnfetchable === 'OTHER_ERR') {
    return {
      status: 'ORDER-DEFECT-LIVE',
      reason:
        'the SAME id answers not_shared with a fetchable url and a network error with an unfetchable one, so the ' +
        'access assert runs AFTER the fetch. An unauthorized caller makes this server perform a full outbound GET ' +
        'and buffer the body before anything asks whether they can see the target',
      reachOk,
      noteLegSameOrder,
    };
  }

  return {
    status: 'INCONCLUSIVE',
    reason:
      `the unfetchable leg is not a shape this probe can interpret ` +
      `(not-shared → ${r.notSharedUnfetchable}, readable → ${r.readableUnfetchable})`,
    reachOk,
    noteLegSameOrder,
  };
}

export function exitCodeFor(v: OrderVerdict): number {
  if (v.status === 'PROD-HOISTED') return 0;
  if (v.status === 'ORDER-DEFECT-LIVE') return 1;
  return 2;
}

/* ------------------------------------------------------------------ */
/* cli                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const { url, auth } = readEndpoint();
  const fetchable = fetchableUrlFor(url);
  const stamp = new Date().toISOString();

  console.log(`# attach_file_from_url — assert/fetch ORDER against prod — ${stamp}`);
  console.log(`endpoint ${url}`);
  console.log(
    `subjects readable=${READABLE_TASK_ID} · not-shared=${NOT_SHARED_TASK_ID} · never-real=${NEVER_REAL_TASK_ID} · never-real-note=${NEVER_REAL_NOTE_ID}\n`,
  );

  console.log('## url preconditions — read from THIS box, BEFORE prod is asked');
  const pre = await checkUrlPreconditions(fetchable);
  for (const p of pre) console.log(`  ${p.ok ? '✅' : '🔴'} ${p.url}\n       ${p.detail}`);
  const preconditionsOk = pre.every((p) => p.ok);
  if (!preconditionsOk) {
    console.log('\n⛔ PRECONDITION NOT MET — probe NOT sent. This run measured nothing.');
    const v = decideOrder({} as OrderReading, false);
    console.log(`\n## verdict\n  ${v.status}  ${v.reason}`);
    return exitCodeFor(v);
  }

  // WRITE-SAFETY, read BEFORE the run (precondition 19a: read a control's
  // subject before the step that could change it).
  const before = await callTool(url, auth, 'list_attachments', { taskId: READABLE_TASK_ID });
  console.log(`\n## WRITE-SAFETY — attachments on ${READABLE_TASK_ID} BEFORE: ${before.text.slice(0, 80)}`);

  const ask = async (label: string, subject: string, urlKind: 'unfetchable' | 'fetchable', args: Record<string, unknown>): Promise<Answer> => {
    if (!pairingIsSafe(subject, urlKind)) throw new Error(`refusing unsafe pairing ${subject} × ${urlKind}`);
    const a = await callTool(url, auth, 'attach_file_from_url', args);
    console.log(`  ${label.padEnd(38)} ${a.klass.padEnd(11)} ${a.text.slice(0, 96).replace(/\n/g, ' ')}`);
    return a;
  };

  console.log('\n## leg A — url CANNOT be fetched (no artifact is possible, either order)');
  const readableUnfetchable = await ask('REACH-CTL readable task', 'readable', 'unfetchable', {
    taskId: READABLE_TASK_ID,
    url: UNFETCHABLE_URL,
  });
  const notSharedUnfetchable = await ask('not-shared task', 'notShared', 'unfetchable', {
    taskId: NOT_SHARED_TASK_ID,
    url: UNFETCHABLE_URL,
  });
  await ask('never-real task', 'neverReal', 'unfetchable', { taskId: NEVER_REAL_TASK_ID, url: UNFETCHABLE_URL });
  const noteUnfetchable = await ask('never-real NOTE', 'neverRealNote', 'unfetchable', {
    noteId: NEVER_REAL_NOTE_ID,
    url: UNFETCHABLE_URL,
  });

  console.log('\n## leg B — url DOES yield a body (refused subjects only — never the readable one)');
  const notSharedFetchable = await ask('not-shared task', 'notShared', 'fetchable', {
    taskId: NOT_SHARED_TASK_ID,
    url: fetchable,
  });
  const neverRealFetchable = await ask('never-real task', 'neverReal', 'fetchable', {
    taskId: NEVER_REAL_TASK_ID,
    url: fetchable,
  });
  const noteFetchable = await ask('never-real NOTE', 'neverRealNote', 'fetchable', {
    noteId: NEVER_REAL_NOTE_ID,
    url: fetchable,
  });

  // SUBJECT control — the not-shared id IS resolvable to a refusal by this
  // server, same identity, same minute. Without it, `fetch failed` on that leg
  // could be a fact about the id rather than about the order.
  const subject = await callTool(url, auth, 'get_task', { id: NOT_SHARED_TASK_ID, fields: ['title'] });
  console.log(`\n## SUBJECT CTL  get_task(${NOT_SHARED_TASK_ID}) → ${subject.klass}`);
  const subjectOk = subject.klass === 'NOT_SHARED';
  if (!subjectOk) console.log('  🔴 the not-shared subject is no longer not-shared — every row above is about the wrong kind of id');

  const after = await callTool(url, auth, 'list_attachments', { taskId: READABLE_TASK_ID });
  const moved = before.text.trim() !== after.text.trim();
  console.log(`\n## WRITE-SAFETY — AFTER: ${after.text.slice(0, 80)}`);
  console.log(`  ${moved ? '🔴 CHANGED — a probe LANDED' : '✅ unchanged — 0 artifacts from all 7 calls'}`);

  const reading: OrderReading = {
    notSharedUnfetchable: notSharedUnfetchable.klass,
    notSharedFetchable: notSharedFetchable.klass,
    neverRealFetchable: neverRealFetchable.klass,
    readableUnfetchable: readableUnfetchable.klass,
    noteFetchable: noteFetchable.klass,
    noteUnfetchable: noteUnfetchable.klass,
  };
  const verdict = decideOrder(reading, preconditionsOk && subjectOk && !moved);

  console.log('\n## the note leg — does it share the task leg\'s order?');
  console.log(
    verdict.noteLegSameOrder === null
      ? '  not decided — the run did not get far enough'
      : verdict.noteLegSameOrder
        ? `  YES — never-real NOTE answers ${reading.noteUnfetchable} unfetchable / ${reading.noteFetchable} fetchable, the same swing as the task leg.\n` +
          '  Expected from the tree: resolveAttachmentParent handles taskId and brainNoteId in ONE function, so the\n' +
          '  hoist covers both legs together — this is the prod half of that, which the tree could not answer.\n' +
          `  ⚠️ the CONFLATION verdict for the note leg is still DEFERRED: it needs a not-shared NOTE id, which a\n` +
          '  share-scoped caller cannot mint (same subject gap as get_note). ORDER and CONFLATION are two questions;\n' +
          '  only the first one is answerable without that subject.'
        : `  NO — never-real NOTE answers ${reading.noteUnfetchable} unfetchable / ${reading.noteFetchable} fetchable.\n` +
          '  The note surface has already given the opposite verdict on the same shape once (update_note); do not\n' +
          '  inherit the task leg\'s conclusion here.',
  );

  console.log(`\n## verdict\n  ${verdict.status}\n  ${verdict.reason}`);
  return exitCodeFor(verdict);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`INCONCLUSIVE — the probe threw: ${(err as Error).message}`);
      process.exit(2);
    });
}
