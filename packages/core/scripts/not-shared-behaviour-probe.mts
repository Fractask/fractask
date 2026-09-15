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
 * insert (`tasks.ts`), so neither subject can reach the write. `post_comment`
 * is the same shape one level down, and the one whose stray write would be
 * hardest to find: it adds no row to any tree and no file to any card, only a
 * paragraph in a thread — hence `PROBE_COMMENT_BODY`.
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
 * ## The FRAME — added 2026-09-15 01:4xZ, and it changes what exit 0 means
 *
 * `PROBES` is a hand-picked list. For five hours every receipt on this card
 * published `N of 12` — a numerator with no denominator — while nothing printed
 * the population those twelve are a subset of. The probe had reproduced the
 * shape it exists to kill. So the population is now DERIVED from the tool
 * registry on every run (`frameCensus`), and `probed / at-risk` is printed as a
 * fraction with the unprobed tools listed by name.
 *
 * That is why there is a fourth status. See `Referent` for why the census keys
 * on the KIND OF ROW an argument names rather than on the argument's name.
 *
 * ## Exit codes
 *
 *   0  DISTINGUISHES   every AT-RISK tool was probed, and every one tells the
 *                      two subjects apart
 *   1  CONFLATES       at least one probed tool does not, and all controls held
 *   1  INCOMPLETE      every PROBED tool distinguishes, and at-risk tools were
 *                      never asked. Exit 1, not 0: a green over a hand-picked
 *                      twelfth of the surface is the reading this card rejects
 *   2  INCONCLUSIVE    a control failed, the frame has no readable denominator,
 *                      or the transport did not answer
 *
 * Run from packages/core:
 *   npx tsx scripts/not-shared-behaviour-probe.mts
 *   npx tsx scripts/not-shared-behaviour-probe.mts --json
 *
 * Override the subjects when these ids stop being the right kind of row:
 *   NOT_SHARED_TASK_ID=... NEVER_REAL_TASK_ID=... npm run not-shared-behaviour
 */
import { readEndpoint, AUTH_NEG_CTL_TOKEN } from './not-shared-deploy-marker.mts';
// The registry, for the FRAME census. Imported rather than hand-listed for the
// same reason the deploy marker imports it: a typed-in population is a number
// with no clock, and this one has to go red the hour a new tool is registered.
import { TOOLS } from '../src/mcp-tools.ts';

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

/**
 * ## The move fixture — a subject this caller OWNS, so a destructive tool can be probed at all
 *
 * `move_task` is one of the four destructive at-risk tools the 2026-09-15 02:4xZ
 * receipt left as "needs a safe subject designed". It is the only one of the
 * four for which a safe design exists, and the design is forced by the order of
 * the asserts rather than chosen:
 *
 * ```
 *   moveTask(ctx, id, newParentId)          src/tasks.ts:792
 *     await assertAccessibleExists(ctx, id)          ← FIRST
 *     if (newParentId !== null)
 *       await assertAccessibleExists(ctx, newParentId)  ← SECOND: the leg under test
 * ```
 *
 * A never-real id in the `id` slot short-circuits on the first assert and the
 * second is never reached — both legs would answer `not_found` and the row
 * would read `CONFLATES` off an assert that has nothing to do with the
 * destination. So the `id` slot has to hold a row this caller can read, and the
 * two subjects go in `newParentId`.
 *
 * **That is what bounds the blast radius, and it is the whole reason this row
 * is probeable while `delete_task` is not.** In the world where the guard is
 * missing, the thing that moves is THIS row — a task this caller owns, whose
 * original parent is known, so the damage is both visible and reversible. On a
 * `delete_task` probe the destructive act lands on the not-shared subject
 * itself: a row this caller cannot read, cannot enumerate afterwards and cannot
 * restore. See `UNPROBEABLE`.
 *
 * Fixture: `RoG1lAE_B1xg`, a `backlog` child of `Tx5g85uLq96D` whose own
 * description records the expected parent, so the fixture is self-describing if
 * anyone finds it somewhere else.
 */
export const MOVE_FIXTURE_TASK_ID = process.env.MOVE_FIXTURE_TASK_ID || 'RoG1lAE_B1xg';

/** Where the fixture belongs. Both the precondition and the repair read this. */
export const MOVE_FIXTURE_PARENT_ID = process.env.MOVE_FIXTURE_PARENT_ID || 'Tx5g85uLq96D';

/**
 * The `scratchpad_file` probe's fixture — a scratch entry this caller OWNS.
 *
 * `fileScratchEntry(ctx, id, {taskId})` (`src/scratchpad.ts`) has `move_task`'s
 * assert order: `loadAccessible(ctx, id)` first, `assertAccessibleExists(ctx,
 * input.taskId)` second. So the `id` slot must hold a row this caller can read
 * and the two subjects go in `taskId`.
 *
 * ⚠️ **The assert order is only half the argument, and the half that does not
 * decide anything** (precondition 17 on `F3JVD_0PuXGY`, earned by this row's
 * predecessor). The other half is what the write LEAVES BEHIND in the world
 * where the guard is missing, and for this row it is measured rather than
 * argued: `npm run scratch-file-blast-radius`, 5 controls, all fired —
 *
 * ```
 *   the unrefused write (status=filed, filed_task_id → a hidden task)
 *     readable    get_scratch_entry(own entry)        → READABLE
 *     enumerable  list(status='filed')                → 1
 *     repairable  re-file to a readable task          → OK
 *                 scratchpad_dismiss(id)              → filed_task_id null
 *     ROW-CTL     row present, user_id still the caller
 *     CONTRAST-CTL the SAME write to a NOTE           → NULL (orphaned)
 * ```
 *
 * The mechanism is one line of the access rule: `scratch_entries.user_id` is an
 * **ownership root**, so `loadAccessible` returns the row on ownership alone and
 * never consults `filed_task_id`. `brain_notes` has no such root, which is why
 * `update_note` is `UNSAFE-SUBJECT` and this row is not. That asymmetry, not
 * the probe, is what the test pins.
 *
 * Fixture: `yWydSAPcmO6x`, whose own body records where it belongs, so it is
 * self-describing if anyone finds it filed somewhere else.
 */
export const SCRATCH_FIXTURE_ENTRY_ID = process.env.SCRATCH_FIXTURE_ENTRY_ID || 'yWydSAPcmO6x';

/** The readable task the fixture belongs filed under. The precondition and the repair both read this. */
export const SCRATCH_FIXTURE_TASK_ID = process.env.SCRATCH_FIXTURE_TASK_ID || 'Tx5g85uLq96D';

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
 *
 * ⚠️ **The marker is read in a POSITION, not anywhere in the body — earned
 * 2026-09-14 21:5xZ, by accident, against this card itself.** The first
 * version tested `/\bnot_shared\b/` over the whole text. An ordinary
 * `update_task` on `Tx5g85uLq96D` then classified as `NOT_SHARED`: the call
 * SUCCEEDED and echoed the task, whose description is 6 KB of prose about the
 * string `not_shared`. A substring census of a marker counts how often the
 * corpus TALKS about the marker.
 *
 * That is not cosmetic here, because the SUBJECT control is exactly this
 * predicate: had `NOT_SHARED_TASK_ID` ever been shared with the runner *and*
 * mentioned the token — which any card about this bug does — the control would
 * have read ✅ off a full, readable task body, and every row beneath it would
 * have been a measurement of the wrong kind of row. The two shapes prod
 * actually emits are an `"error": "not_shared"` field (get_task returns it as
 * DATA, http 200, isError false) and a `not_shared: …` error prefix. Both are
 * positions. Prose is not.
 */
export function classify(isError: boolean, text: string): Klass {
  const t = text.trim();
  /** The marker as a VERDICT: an `"error": "<marker>"` field, or the error-message prefix. */
  const asVerdict = (marker: string): boolean =>
    new RegExp(`"error"\\s*:\\s*"${marker}"`).test(t) || new RegExp(`^${marker}\\b`).test(t);

  if (asVerdict('not_shared') || (isError && /\bnot_shared\b/.test(t))) return 'NOT_SHARED';
  if (asVerdict('not_found') || (isError && (/\bnot_found\b/.test(t) || /\bnot found\b/i.test(t)))) return 'NOT_FOUND';
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
 * The same idea for the `post_comment` probe. A stray comment is the quietest
 * of the write probes' failure modes — it leaves no new row in any tree and no
 * attachment on any card, just a paragraph in somebody else's thread — so the
 * marker is the only thing that would make it findable afterwards.
 */
export const PROBE_COMMENT_BODY = 'NOT-SHARED PROBE — must never be posted (not-shared-behaviour-probe)';

/**
 * And for the `create_note` probe. A stray NOTE is the hardest of the write
 * probes to find after the fact: it is not a row in the task tree, so no
 * `list_tasks` walk sees it, and the only enumerator is `list_notes` — which is
 * one of the three tools this card reports as CONFLATING, so on a scope the
 * caller cannot read it answers `[]` either way. The marker is therefore the
 * only handle, and it is why this row's cleanup path is named in the
 * WRITE-SAFETY reason rather than left to the reader to work out.
 */
export const PROBE_NOTE_TITLE = 'NOT-SHARED PROBE — must never be created (not-shared-behaviour-probe, note)';

/**
 * The `create_upload` probe's filename — and the one marker on this file that
 * would NOT help you find the damage, which is why it carries this note.
 *
 * `createUploadTicket` (`src/attachments.ts:299`) asserts access and then mints
 * a presigned PUT. It inserts **no row**: the attachment only exists once
 * `finalize_upload` is called. Measured 2026-09-15 02:4xZ against prod on a
 * READABLE subject — the call answered with an `attachmentId` and an upload
 * URL, and `list_attachments` on that same task then returned `[]`, with
 * `delete_attachment` on the returned id answering `not_found` identically to a
 * never-real id.
 *
 * So for this row the WRITE-SAFETY control's usual advice — *go and look for
 * the artifact* — does not apply, and saying it anyway would be worse than
 * saying nothing. What an unrefused `create_upload` leaks is not an object but
 * a **capability**: a signed write grant into someone else's storage prefix,
 * valid for `UPLOAD_TTL_SECONDS`, that no enumerator on this surface can see.
 * It is the quietest of the six write probes by some distance, and the source
 * comment at the access check says so in as many words.
 */
export const PROBE_UPLOAD_FILENAME = 'not-shared-probe-create-upload.txt';

/**
 * `finalize_upload`'s SECOND dimension, and the reason this row is the safest
 * write on the whole table.
 *
 * `finalizeUpload` (`src/attachments.ts:368`) derives its storage key from the
 * ACCESS CHECK's answer — `storageKeyFor(ownerId, storagePathSegment,
 * attachmentId, filename)` — and then `head()`s it. So an `attachmentId` that
 * was never PUT cannot resolve to an object under ANY prefix, for ANY subject,
 * in EITHER assert order. The insert is unreachable by construction rather than
 * by argument: there is nothing for the row to point at.
 *
 * That is a stronger guarantee than the six write probes above it have. Each of
 * those is safe because prod's assert fires first — which is the very thing
 * this file exists to measure, so their safety is downstream of the reading.
 * This one is safe even if prod has no access check at all.
 *
 * It is also what makes the reach leg legal here. Precondition 12 needs a third
 * subject the caller CAN read, and for every other write row the readable
 * pairing is exactly the combination that could land. Here it cannot, so the
 * variant is `reachSafe: true` and the row can tell "conflates" from "never
 * asked" on its own output.
 */
export const NEVER_PUT_ATTACHMENT_ID = process.env.NEVER_PUT_ATTACHMENT_ID || 'zzzNoUpload9XyZ';

/** The `finalize_upload` probe's filename — never attached, see above. */
export const PROBE_FINALIZE_FILENAME = 'not-shared-probe-finalize-upload.txt';

/**
 * The `ask_human` probe's prompt text — and the marker that would make a landed
 * ask findable, in the one place a landed ask would be.
 *
 * A stray PROMPT is the loudest of this table's write failures and the one
 * whose damage lands furthest from the caller: `createPrompt` bumps the task to
 * `status="review"` and files the row against the task's OWNER, so an unrefused
 * call does not leave a quiet artifact in a tree — it puts a card in a human's
 * "needs your input" queue with this text on it. The enumerator that finds it
 * (`list_prompts`) is a PROBED row that distinguishes, so unlike the note case
 * the marker has a reader that works.
 */
export const PROBE_ASK_PROMPT = 'NOT-SHARED PROBE — must never be asked (not-shared-behaviour-probe)';

/**
 * `ask_human`'s SECOND guard, and the reason its reach leg is safe.
 *
 * `createPrompt` (`src/prompts.ts:593`) runs four refusals ahead of its insert
 * at `:632`, in this order: the access assert on `taskId` (`:598`), the agent
 * packaging check (`:606`), the addressing check (`:616`), and the goal-link
 * validation (`:623`). The probe's arguments are built to trip TWO of them
 * independently — no `deck`/`recommendation`/`estSeconds`, **and** a
 * `goalTaskId` naming a row whose `kind` is not `"goal"`.
 *
 * That is what makes a readable subject safe here, on the `finalize_upload`
 * pattern rather than the `create_task` one: the insert is unreachable even in
 * a build where the access assert runs LAST, and even in a build where the
 * packaging rule is switched off at `/settings/rules` — which it can be, since
 * `isAgentRuleEnabled('prompt_requires_deck')` reads a workspace setting this
 * caller does not control. One guard would have made the reach leg's safety
 * depend on a toggle; two make it depend on neither.
 *
 * ⚠️ It must name a task that EXISTS and is READABLE and is not a goal. A
 * never-real id would make the goal leg throw `not_found`, which is one of the
 * two answers this row is trying to tell apart.
 */
export const ASK_NON_GOAL_TASK_ID = process.env.ASK_NON_GOAL_TASK_ID || 'Tx5g85uLq96D';

/**
 * One probed tool: a name plus how it names the subject in its own arguments.
 *
 * `write: true` marks a call that would MUTATE if it were not refused. Those
 * rows are the ones the WRITE-SAFETY control watches: for a read probe a
 * non-error answer is just an answer, but for a write probe it is a write.
 */
export type Probe = {
  tool: string;
  args: (id: string) => Record<string, unknown>;
  note: string;
  write?: boolean;
  /**
   * A SECOND dimension, for a tool whose verdict is a function of more than the
   * subject id. Absent on every single-argument row, and absent is the
   * degenerate one-variant case — see `variantsOf`.
   *
   * A thunk on the endpoint url, not a literal, because the first variant set
   * this file has needs the endpoint's own origin to build its fetchable url.
   */
  variants?: (endpointUrl: string) => ProbeVariant[];
};

/**
 * One setting of a probe's OTHER arguments.
 *
 * ## Why this exists (precondition 21, earned 2026-09-15 09:4xZ on `Tx5g85uLq96D`)
 *
 * Every row on this table used to vary ONE thing — the id — and read the
 * answer. That is silently correct only while the answer is a function of that
 * one thing. `attach_file_from_url` takes an id **and** a url, and the two
 * choices give OPPOSITE verdicts against the same prod build, same identity,
 * same minute:
 *
 * ```
 *   taskId=<not-shared> + url that cannot be fetched  →  error: fetch failed   OTHER_ERR
 *   taskId=<not-shared> + url that yields a body      →  not_shared: …         NOT_SHARED
 * ```
 *
 * A one-variant probe of that tool reports on the url it happened to pick, and
 * both picks are wrong in opposite directions: the fetchable one scores the row
 * 🟢 and hides the defect, the unfetchable one scores 🔴 for the wrong reason.
 * So the row is only sayable as a SET of variants, and its roll-up is the
 * conjunction — see `rollUpVariants`.
 *
 * `reachSafe` is NOT a style choice. It says this variant may also be sent with
 * a subject the caller CAN read, which is precondition 12's third leg: without
 * it, "both refused subjects answered the same thing" cannot be told apart from
 * "this call never reached the handler". It is `false` exactly where the
 * readable pairing is the one combination that could actually mutate.
 */
export type ProbeVariant = {
  /** Printed on the row, e.g. `url=fetchable`. */
  name: string;
  args: (id: string) => Record<string, unknown>;
  /** May this variant also be sent with a READABLE subject, as a reach leg? */
  reachSafe: boolean;
  /** One line on why this variant is here — printed, not just commented. */
  why: string;
};

/**
 * The variants a probe is actually run with. A row with no `variants` is one
 * variant named `default` carrying its own `args`, so every caller below can
 * treat the single- and multi-argument cases identically.
 *
 * ⚠️ The degenerate variant is `reachSafe: false` **deliberately**, and it is
 * the scope line of this unit. Turning it on would add a third subject to every
 * existing row and restate verdicts this card has published for days — in
 * particular the three CONFLATING collection tools, whose reach leg needs a
 * readable subject chosen per tool (a parent that HAS children, a scope that
 * HAS notes) rather than one shared id. `list_notes` already has that control
 * by hand as `SCOPE CTL`. Generalising it is the NEXT unit; doing it here would
 * mean shipping a silent re-reading of rows nobody asked me to re-read.
 */
export function variantsOf(p: Probe, endpointUrl: string): ProbeVariant[] {
  const vs = p.variants?.(endpointUrl);
  if (vs?.length) return vs;
  return [
    {
      name: 'default',
      args: p.args,
      reachSafe: false,
      why: 'single-argument row — the id is the only thing varied, and its reading is unchanged by this dimension',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* the url dimension — `attach_file_from_url`'s second argument        */
/* ------------------------------------------------------------------ */

/**
 * A url whose DNS cannot resolve. `.invalid` is reserved by RFC 2606 precisely
 * so it can never be delegated, so no body can come back whichever order prod
 * uses — the artifact is impossible by construction, not by argument.
 *
 * Lives here rather than in `attach-from-url-order-probe.mts` because that file
 * already imports from this one; the order probe re-exports it, so there is one
 * definition and its test keeps pinning the same object.
 */
export const AFU_UNFETCHABLE_URL = 'https://not-shared-probe.invalid/x.txt';

/**
 * A url that DOES yield a body, derived from the MCP endpoint's own origin
 * rather than hard-coded — so the outbound request this probe causes stays
 * inside the system under test. (An earlier hand pass pointed it at
 * `verikal.ai` and put a row in a fleet property's own 404 census.)
 */
export function afuFetchableUrlFor(endpointUrl: string): string {
  return `${new URL(endpointUrl).origin}/zzz-not-shared-order-ctl`;
}

/**
 * The subject/url pairings this tool may be sent, anywhere in this repo.
 *
 * `readable × fetchable` is ABSENT on purpose and its absence IS the safety
 * argument: it is the only pairing where an unrefused write has somewhere to
 * land. Pinned by a test in both probes' suites.
 */
export const AFU_SAFE_PAIRINGS: {
  subject: 'readable' | 'notShared' | 'neverReal' | 'neverRealNote';
  url: 'unfetchable' | 'fetchable';
}[] = [
  { subject: 'readable', url: 'unfetchable' },
  { subject: 'notShared', url: 'unfetchable' },
  { subject: 'neverReal', url: 'unfetchable' },
  { subject: 'neverRealNote', url: 'unfetchable' },
  { subject: 'notShared', url: 'fetchable' },
  { subject: 'neverReal', url: 'fetchable' },
  { subject: 'neverRealNote', url: 'fetchable' },
];

export function afuPairingIsSafe(subject: string, url: string): boolean {
  return AFU_SAFE_PAIRINGS.some((p) => p.subject === subject && p.url === url);
}

export type UrlPrecondition = { url: string; ok: boolean; detail: string };

/**
 * Read both urls from THIS box and decide whether the url dimension may run.
 *
 * `unfetchable` must genuinely fail to resolve. `fetchable` must genuinely
 * return a body — if it ever starts 404ing, the fetchable leg silently becomes
 * a second unfetchable leg and the whole dimension quietly loses its power,
 * which is precondition 16's failure mode exactly. A run whose preconditions
 * fail does NOT degrade to one variant: the row is skipped and goes back on the
 * to-do list, because a row measured on half its dimension is a row with no
 * reading behind it.
 */
export async function checkUrlPreconditions(fetchable: string): Promise<UrlPrecondition[]> {
  const out: UrlPrecondition[] = [];

  let unfetchableFailed = false;
  let unfetchableDetail = '';
  try {
    await fetch(AFU_UNFETCHABLE_URL, { signal: AbortSignal.timeout(15_000) });
    unfetchableDetail = 'RESOLVED — a reserved-TLD host answered; no artifact guarantee left';
  } catch (err) {
    unfetchableFailed = true;
    unfetchableDetail = `does not resolve (${(err as Error).message}) — no body can ever come back`;
  }
  out.push({ url: AFU_UNFETCHABLE_URL, ok: unfetchableFailed, detail: unfetchableDetail });

  try {
    const res = await fetch(fetchable, { signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    out.push({
      url: fetchable,
      ok: res.ok && body.length > 0,
      detail: `final status ${res.status} · ${body.length} B body · ${res.headers.get('content-type') ?? 'no content-type'}`,
    });
  } catch (err) {
    out.push({ url: fetchable, ok: false, detail: `unreachable (${(err as Error).message})` });
  }

  return out;
}

/**
 * The two variants of the `attach_file_from_url` row. Built from the endpoint
 * url, because the fetchable one is derived from it.
 *
 * Note which one carries `reachSafe`. The UNFETCHABLE variant does, and it must
 * — its three legs come back identical on prod today, and identical legs are
 * this file's own test for *"never asked"*, not for *"conflates"*. The
 * FETCHABLE variant does not, and cannot: `readable × fetchable` is the one
 * pairing that could create an attachment. It does not need one, because two
 * DIFFERENT handler verdicts across its refused legs already prove reach.
 */
export function afuVariants(endpointUrl: string): ProbeVariant[] {
  const fetchable = afuFetchableUrlFor(endpointUrl);
  return [
    {
      name: 'url=unfetchable',
      args: (id) => ({ taskId: id, url: AFU_UNFETCHABLE_URL }),
      reachSafe: true,
      why: 'DNS cannot resolve it, so no artifact is possible in EITHER assert order — the variant that is safe to point at a readable subject',
    },
    {
      name: 'url=fetchable',
      args: (id) => ({ taskId: id, url: fetchable }),
      reachSafe: false,
      why: 'yields a body, so it reaches the handler — never paired with a readable subject, which is the only pairing that could land',
    },
  ];
}

/**
 * `finalize_upload`'s variant set — one entry, and the single entry is the
 * point.
 *
 * A one-variant row is normally spelled by omitting `variants` entirely
 * (`variantsOf`'s degenerate case). This row spells it out because the
 * degenerate variant is `reachSafe: false` by design, and here the reach leg is
 * both safe and load-bearing: without it the two refused subjects answering
 * differently would still be a reading, but the row could not say that the
 * handler was REACHED — and "reached" is precisely what separates
 * `finalize_upload` from `attach_file_from_url[url=unfetchable]`, whose three
 * identical rows mean nobody ever asked.
 *
 * The name says what is being held fixed, so the row reads as a claim about an
 * argument set rather than about the tool (precondition 21).
 */
export function finalizeVariants(): ProbeVariant[] {
  return [
    {
      name: 'object=absent',
      args: (id) => ({
        attachmentId: NEVER_PUT_ATTACHMENT_ID,
        taskId: id,
        filename: PROBE_FINALIZE_FILENAME,
        mimeType: 'text/plain',
        sizeBytes: 21,
      }),
      reachSafe: true,
      why: 'the attachmentId was never PUT, so head() misses under every prefix — the insert is unreachable in EITHER assert order, which is what makes a readable subject safe here',
    },
  ];
}

/**
 * `ask_human`'s variant set. One entry, spelled out for the same reason
 * `finalizeVariants` is: the reach leg is safe AND load-bearing, and the
 * degenerate variant would be `reachSafe: false`.
 *
 * The name says what is being held fixed — the two guards that make the insert
 * unreachable — so the row reads as a claim about an argument set rather than
 * about the tool (precondition 21). Sent with a packaged deck it would be a
 * different call with a different safety argument, and that call is not made
 * here.
 */
export function askHumanVariants(): ProbeVariant[] {
  return [
    {
      name: 'unpackaged+non-goal',
      args: (id) => ({
        taskId: id,
        kind: 'text',
        prompt: PROBE_ASK_PROMPT,
        goalTaskId: ASK_NON_GOAL_TASK_ID,
      }),
      reachSafe: true,
      why:
        'no deck AND a goalTaskId that is not a goal — two independent pre-insert refusals, so the prompt is ' +
        'unreachable in EITHER assert order and with the workspace deck rule either on or off',
    },
  ];
}

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
  // `post_comment` — the LAST of the four tools this card's fix brief names by
  // hand, and the only one whose harm the repo had already recorded in its own
  // suite. The card's §"it also bites inside the repo's own suite" is exactly
  // this call: `focus.test.ts:404` failing with `NotFoundError: Task … not
  // found` where the real cause was *a bot commenting on a task it has no
  // share for*. The error text sent that diagnosis in the wrong direction, and
  // the tool that produced it was still unprobed on 2026-09-14 22:4xZ.
  // Measured by hand against prod first, then encoded: NOT_SHARED / NOT_FOUND,
  // both legs refused.
  {
    tool: 'post_comment',
    args: (id) => ({ taskId: id, body: PROBE_COMMENT_BODY }),
    note: "WRITE — the in-repo harm's own call path (focus.test.ts:404)",
    write: true,
  },
  // `create_note(scopeTaskId=…)` — the NOTE surface's write path, and the one
  // row on this table whose subject argument the three CONFLATING tools also
  // take. Measured by hand against prod on 2026-09-14 23:4xZ before it was
  // encoded here (`LbTfUj_liBQd`'s mechanism: take the reading, THEN write it
  // down): NOT_SHARED / NOT_FOUND, both legs refused, nothing created.
  //
  // It is worth a row of its own rather than being assumed from `create_task`
  // because the two creates assert on DIFFERENT arguments — `parentId` is a
  // parent task, `scopeTaskId` is a scope — and this card's whole history is
  // call sites that were believed covered by a sibling's guarantee. The note
  // surface is exactly where that belief has already failed once: the card
  // asserted "same for list_notes / search_notes / get_note" from the code
  // path, and when someone finally CALLED them two of the three were broken.
  {
    tool: 'create_note',
    args: (id) => ({ title: PROBE_NOTE_TITLE, contentText: PROBE_NOTE_TITLE, scopeTaskId: id }),
    note: 'WRITE — the note surface\'s create path; its scope arg is the same kind of id the 3 CONFLATING tools take',
    write: true,
  },
  // `create_upload(taskId=…)` — the FIRST row drawn from the frame's own
  // to-do list rather than from the fix brief or from a sibling's surface.
  // Measured by hand against prod on 2026-09-15 02:4xZ before it was encoded:
  // NOT_SHARED / NOT_FOUND, both legs refused.
  //
  // It is worth a row rather than being assumed from `attach_file` — already
  // green two rows up, on the same attachment surface — for the reason this
  // card keeps re-learning: the two reach the access assert by different
  // paths. `attach_file` gets there through `resolveAttachmentParent` from
  // `addAttachment`; `create_upload` calls `createUploadTicket`, which is the
  // only one of the pair that hands the caller a credential.
  //
  // And it is the row where a MISS would be least visible. The other five
  // write probes leave a greppable artifact; this one leaves a signed PUT URL
  // into another owner's prefix and nothing in any tree — see
  // `PROBE_UPLOAD_FILENAME`.
  {
    tool: 'create_upload',
    args: (id) => ({ taskId: id, filename: PROBE_UPLOAD_FILENAME, mimeType: 'text/plain', sizeBytes: 21 }),
    note: 'WRITE — mints a signed write grant; an unrefused answer leaves no artifact to find',
    write: true,
  },
  // `move_task(id=<fixture>, newParentId=<subject>)` — the first DESTRUCTIVE
  // tool on this table, and the only one of the four that a safe subject can be
  // designed for. Measured by hand against prod on 2026-09-15 03:4xZ before it
  // was encoded: the REACH leg (a no-op move of the fixture to its own current
  // parent) succeeded, then NOT_SHARED / NOT_FOUND, both legs refused, and the
  // fixture's `parentId` re-read identical afterwards.
  //
  // Two things make this row different from the six write probes above it.
  // The subject argument is NOT the id being varied — see `MOVE_FIXTURE_TASK_ID`
  // for why the assert order forces that. And its safety control has a second
  // leg: `landed` reads the ANSWER, and for a move the answer and the world can
  // disagree, so the fixture's parent is read before and after and compared.
  // A control that counts the event cannot see the state.
  {
    tool: 'move_task',
    args: (id) => ({ id: MOVE_FIXTURE_TASK_ID, newParentId: id }),
    note: 'WRITE, DESTRUCTIVE — subject in newParentId; the id slot holds a row this caller owns',
    write: true,
  },
  // `scratchpad_file(id=<fixture entry>, taskId=<subject>)` — the SECOND row
  // whose subject argument is not the id being varied, and the first one drawn
  // from a surface this card had never touched. Measured by hand against prod
  // on 2026-09-15 06:2xZ before it was encoded: the REACH leg (filing the
  // fixture to a task the caller CAN read) succeeded, then
  // `not_shared: Task TfmR7QJFqluo not shared — …do not recreate it…` /
  // `not_found: Task zzzNoSuch9XyZ not found`, both legs refused, and the
  // fixture's `filedTaskId` re-read identical afterwards.
  //
  // Its safety is the one thing NOT taken from the assert order — see
  // `SCRATCH_FIXTURE_ENTRY_ID` and `npm run scratch-file-blast-radius`.
  {
    tool: 'scratchpad_file',
    args: (id) => ({ id: SCRATCH_FIXTURE_ENTRY_ID, taskId: id }),
    note: 'WRITE — subject in taskId; the id slot holds a scratch entry this caller owns',
    write: true,
  },
  // `attach_file_from_url(taskId=…)` — the FIRST multi-variant row on this
  // table, and the reason the `variants` dimension exists at all.
  //
  // It was measured by hand against prod on 2026-09-15 08:5xZ and read
  // CONFLATES; re-measured with a third subject at 09:4xZ that reading turned
  // out to be unfalsifiable from its own output, and the real finding is one
  // level in: **the verdict is decided by the probe's own SECOND argument.**
  // Same id, same identity, same minute — `url` unfetchable answers a network
  // error, `url` fetchable answers `not_shared`. Only fetch-then-assert
  // explains both, and the assert that finally refuses is `createAttachment`'s,
  // downstream, after the body is already buffered.
  //
  // So this row is deliberately NOT expressible as one verdict. Its roll-up is
  // the conjunction over both variants (`rollUpVariants`), which is what makes
  // the table refuse to print the comforting half of a disagreement.
  //
  // `npm run afu-order` remains the dedicated command and is NOT superseded: it
  // carries the note leg, the WRITE-SAFETY before/after read on a readable
  // task, and a `PROD-HOISTED` exit that tells you to delete it. This row
  // carries the same tool into the COVERAGE frame, which the command cannot do.
  {
    tool: 'attach_file_from_url',
    args: (id) => ({ taskId: id, url: AFU_UNFETCHABLE_URL }),
    variants: afuVariants,
    note: 'WRITE, TWO-DIMENSIONAL — the url decides the verdict, so one url is never a reading of this tool',
    write: true,
  },
  // `finalize_upload(taskId=…)` — the SECOND half of the two-call upload path,
  // whose first half (`create_upload`) has been green here since 02:4xZ. It is
  // a row of its own for the reason this card keeps re-earning: the two calls
  // reach the access assert by the same helper but at different times, and only
  // this one is the call that INSERTS. A `create_upload` that is correctly
  // refused proves nothing about the call that would create the row.
  //
  // Measured by hand against prod on 2026-09-15 12:4xZ before it was encoded
  // (`tmp-finalize-upload-hand-probe.mts`, deleted in the same commit — the
  // reading is the artifact, the throwaway script is not):
  //
  // ```
  //   readable   Tx5g85uLq96D   OTHER_ERR   No uploaded object found for attachmentId zzzNoUpload9XyZ…
  //   not-shared TfmR7QJFqluo   NOT_SHARED  not_shared: …do not recreate it…
  //   never-real zzzNoSuch9XyZ  NOT_FOUND   not_found: Task zzzNoSuch9XyZ not found
  // ```
  //
  // THREE distinct answers, which is the strongest shape precondition 12 admits:
  // the row distinguishes AND the handler is demonstrably reached, off the same
  // three calls. Prod asserts access before it looks at storage.
  //
  // Its variant is named rather than `default` because the second argument is
  // load-bearing in the safety argument, not just in the reading — see
  // `NEVER_PUT_ATTACHMENT_ID`. An `attachmentId` that was never PUT makes the
  // insert unreachable by construction, which is why this is the only write row
  // on the table that may be pointed at a readable subject.
  {
    tool: 'finalize_upload',
    args: (id) => ({
      attachmentId: NEVER_PUT_ATTACHMENT_ID,
      taskId: id,
      filename: PROBE_FINALIZE_FILENAME,
      mimeType: 'text/plain',
      sizeBytes: 21,
    }),
    variants: finalizeVariants,
    note: 'WRITE — the call that actually INSERTS; safe by construction rather than by assert order, so it carries a REACH leg',
    write: true,
  },
  // `ask_human` — the first row taken off the unprobed list that carried NO
  // annotation at all, i.e. one nobody had yet found a reason to exclude.
  //
  // Measured by hand against prod on 2026-09-15 13:41Z before it was encoded
  // (precondition 18), three subjects, and the answer is the THREE-DISTINCT
  // shape rather than two:
  //
  //   not-shared  TfmR7QJFqluo   NOT_SHARED   "…do not recreate it…"
  //   never-real  zzzNoSuch9XyZ  NOT_FOUND    "Task zzzNoSuch9XyZ not found"
  //   readable    Tx5g85uLq96D   OTHER_ERR    "ask_human requires deck + recommendation + estSeconds…"
  //
  // So prod's `createPrompt` asserts ACCESS before it checks PACKAGING, and the
  // readable leg proves the handler was reached without creating anything —
  // `list_prompts` on that task was byte-identical before and after, and its
  // `status` did not move to `review`.
  //
  // It is worth its own row rather than being assumed from the other writes for
  // the reason this card keeps re-learning: `ask_human` is the only tool here
  // whose unrefused call is delivered to a HUMAN rather than left in a tree, so
  // `report_shipped`'s THIRD-PARTY-ARTIFACT question had to be asked of it too.
  // The answer differs — a landed prompt IS enumerable and cancellable by this
  // caller — but that is a measurement, not an inheritance.
  {
    tool: 'ask_human',
    args: (id) => ({
      taskId: id,
      kind: 'text',
      prompt: PROBE_ASK_PROMPT,
      goalTaskId: ASK_NON_GOAL_TASK_ID,
    }),
    variants: askHumanVariants,
    note: "WRITE — the only row whose unrefused call lands in a HUMAN's review queue; two pre-insert guards make its REACH leg safe",
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
 * ## The other three of "the destructive four" — and they are THREE DIFFERENT REASONS
 *
 * The 2026-09-15 02:4xZ receipt closed with a single bucket: *"what is left is
 * dominated by destructive paths (`delete_task`, `delete_note`, `move_task`,
 * `move_note`) where the not-shared leg damages a card this caller cannot read
 * … the next commit has to design a safe subject for the destructive four."*
 *
 * Designing it split the bucket. One of the four turned out to be probeable
 * (`move_task`, above), and the other three are blocked for reasons that have
 * nothing to do with each other — only ONE of which is about destructiveness:
 *
 * ```
 *   move_task    ✅ PROBED   a caller-owned row fits the id slot; subject goes in newParentId
 *   delete_task  ⛔ UNSAFE   the destructive act lands ON the not-shared subject; no second slot
 *   delete_note  ⛔ NOTE     every id it takes is a NOTE id — and it is also destructive
 *   move_note    ⛔ NOTE     every id it takes is a NOTE id (id + newParentNoteId)
 * ```
 *
 * **Why `delete_task` has no safe design, stated as a property and not as a
 * preference.** `deleteTask(ctx, id)` takes one id and that id is the subject.
 * There is no slot to put a caller-owned row in, so the only probe that reaches
 * the access assert is a real delete aimed at a task this caller cannot see.
 * The WRITE-SAFETY control cannot cover it either, and the reason is worth
 * writing down because that control is what makes the other six write probes
 * defensible: it is a **detector**, not a preventer — it reports a landed write
 * after the fact so a human can go and undo it. For a delete on an unreadable
 * subject there is nothing to detect it with (no enumerator of this caller's
 * reaches the row) and nothing to restore it from. A safety control whose
 * remedy is "go and look for the artifact" is worth nothing where the artifact
 * is the thing that was removed.
 *
 * **Why the two note rows are NOT a destructiveness problem.** `delete_note(id)`
 * and `move_note(id, newParentNoteId)` take note ids in every slot, so they need
 * the same subject `get_note` is deferred on — a note that exists and is not
 * shared with the runner, which a share-scoped caller cannot mint. They are
 * blocked one step earlier than `delete_task` is, and they are not in `DEFERRED`
 * only because that loop probes `{ id: subjectId }` directly: handing
 * `delete_note` a not-shared note id is the `delete_task` problem again. If
 * `NOT_SHARED_NOTE_ID` ever arrives, `move_note` discharges the same way
 * `move_task` did — a caller-owned note in the `id` slot, the subject in
 * `newParentNoteId` — and `delete_note` still does not.
 *
 * **Why `update_note` joins them, and it is a THIRD reason.** It was named the
 * cheapest next row because its assert order is the `move_task` order — a
 * caller-owned note in the `id` slot gets past `assertAccessibleNoteExists`,
 * and the subject goes in `scopeTaskId`, which `ensureScopeTaskValid` asserts
 * second. All true, and all about whether the call REACHES the assert. What it
 * never asked is what an unrefused write would LEAVE BEHIND, which is the only
 * world a probe exists for.
 *
 * A task survives it. `accessibleTasksCte` (`access.ts:142`) makes
 * `user_id = <caller>` a **root** of the accessible set regardless of parent, so
 * `move_task`'s fixture stays readable under a hidden parent and the caller can
 * move it back — that is what bounded that row's blast radius.
 * `brain_notes` has **no such root**: a note is accessible iff
 * `(scope_task_id IS NULL AND user_id = caller) OR scope_task_id IN accessible`
 * (`access.ts:343`). Set a non-null scope the caller cannot read and the owner
 * leg does not apply, so the note leaves its own owner's reach — and the repair
 * call, `update_note(id, {scopeTaskId: null})`, opens with
 * `assertAccessibleNoteExists(ctx, id)`, which now refuses.
 *
 * Measured rather than argued from the code path — `npm run
 * note-scope-blast-radius`, 5 controls, all fired:
 *
 * ```
 *   get_note(own note)      NULL   ← identical to a never-real id: this surface
 *                                    has no not_found shape at all
 *   list_notes(no filter)   0      every enumerator the caller has
 *   search_notes(marker)    0
 *   update_note(→ null)     REFUSED (NotSharedNoteError)   the repair path
 *   ROW-CTL                 the brain_notes row is still there, user_id unchanged
 *                                  — orphaned, not deleted
 *   CONTRAST-CTL            the same move done to a TASK → still READABLE,
 *                                  still in the caller's tree, update_task SUCCEEDED
 * ```
 *
 * So it is the `delete_task` conclusion reached from the opposite direction:
 * there, WRITE-SAFETY cannot detect the damage because the artifact is gone;
 * here the artifact is intact and every gauge that could see it has been
 * switched off by the same write. A detector whose subject has been made
 * invisible is not a weaker detector, it is none.
 *
 * ⚠️ **All four stay AT-RISK, stay in the unprobed count and stay in the
 * verdict's named set,** with the reason printed inline on their own to-do row.
 * RULE 36, and this is the third hour running that it applies: a bucket named
 * for the reason a row was excluded reads as disposal, and nobody re-asks the
 * other questions of a row already explained.
 *
 * ✅ **Its replacement, `scratchpad_file`, is now a PROBED row** (2026-09-15
 * 06:2xZ) — see `SCRATCH_FIXTURE_ENTRY_ID`. It has the same assert order, and
 * the clause that decided it is the one `update_note` failed: the write leaves
 * an artifact that is still readable, still enumerable and still repairable by
 * this caller, because `scratch_entries.user_id` is an ownership root.
 *
 * ⚠️ **And that clause was measured, not inherited.** The receipt that named
 * `scratchpad_file` also asserted *"whose filed state stays enumerable by
 * `scratchpad_list(status='filed')`"* — true, as it turns out, but written from
 * the code path, which is the move this card has been wrong about four times.
 * `npm run scratch-file-blast-radius` asks it as three separate questions
 * (readable / enumerable / repairable) against a throwaway DB. A named next row
 * hands the following runner a conclusion and a reason; only the reason is
 * transferable, and it still has to be run.
 *
 * 🔴 **`report_shipped(taskId=…)` was that candidate, it was measured, and the
 * answer is no** (2026-09-15 07:4xZ, `npm run report-shipped-blast-radius`, 5
 * controls, all fired). The open question the candidate carried was the right
 * one, and the answer is a THIRD shape rather than a repeat of the other two:
 *
 * ```
 * delete_task     the artifact is GONE       → WRITE-SAFETY has nothing to detect with
 * update_note     the artifact is ORPHANED   → invisible to everyone, including the human
 * report_shipped  the artifact is DELIVERED  → invisible to the CALLER, visible to the HUMAN
 * ```
 *
 * `reportShipped` writes `userId: task.userId` (`focus.ts:230`) while all three
 * readers key on `ctx.userId` (`focus.ts:78`, `:102`, `:262`). A not-shared
 * subject is owned by somebody else by definition, so the row it mints is owned
 * by somebody else too: it lands in that human's *"shipped because of past
 * answers"* feed — asserting that something went public — and the caller can
 * neither read it, enumerate it nor delete it. THIRD-PARTY-CTL is the leg that
 * distinguishes this from orphaning: read as the OWNER the row is right there,
 * with the prober's title on it.
 *
 * 🎯 **The next candidate is `attach_file_from_url(taskId=…)`,** named as a
 * CANDIDATE with its open question attached (precondition 18). Its assert order
 * is not yet read, and that is the cheap half. The open question is a blast
 * radius with a leg none of the four before it had: the write is preceded by a
 * SERVER-SIDE FETCH of a caller-supplied URL, so an unrefused call has an
 * effect off this box before it has one in the database, and "is the artifact
 * repairable?" does not cover it. Measure that — and note that its sibling
 * `attach_file` is already a PROBED row, which is exactly the "it has the same
 * shape" argument precondition 18 retires.
 */
export const UNPROBEABLE: {
  tool: string;
  kind: 'UNSAFE-SUBJECT' | 'NOTE-SUBJECT' | 'THIRD-PARTY-ARTIFACT' | 'COMPLEMENTARY-SUBJECT';
  reason: string;
  discharge: string;
}[] = [
  {
    tool: 'delete_task',
    kind: 'UNSAFE-SUBJECT',
    reason:
      'takes ONE id and it is the subject — the only probe that reaches the access assert is a real delete of a task ' +
      'this caller cannot read, cannot enumerate afterwards and cannot restore. WRITE-SAFETY detects, it does not prevent',
    discharge: 'a build whose access assert can be read directly, or a disposable not-shared subject its owner supplies',
  },
  {
    tool: 'delete_note',
    kind: 'NOTE-SUBJECT',
    reason:
      'every id it takes is a NOTE id, so it needs the subject get_note is deferred on — and it is ALSO the delete_task ' +
      'shape, so NOT_SHARED_NOTE_ID alone does not discharge it',
    discharge: 'NOT_SHARED_NOTE_ID plus a safe design; a delete aimed at the subject has neither slot nor undo',
  },
  {
    tool: 'move_note',
    kind: 'NOTE-SUBJECT',
    reason:
      'id and newParentNoteId are both NOTE ids, so it needs the subject get_note is deferred on — not a destructiveness ' +
      'problem: with a not-shared note it discharges exactly the way move_task just did',
    discharge: 'NOT_SHARED_NOTE_ID plus a caller-owned note for the id slot',
  },
  // `update_note` — the row the 2026-09-15 04:3xZ receipt named as "the cheapest
  // next row", on an argument that was right about the assert order and never
  // asked what the write would LEAVE BEHIND. See UPDATE_NOTE_BLAST_RADIUS.
  {
    tool: 'update_note',
    kind: 'UNSAFE-SUBJECT',
    reason:
      'has the move_task SHAPE but not its blast radius: an unrefused write moves the CALLER\'S OWN note into a scope ' +
      'the caller cannot read, which orphans it from every enumerator AND from the repair call — measured, ' +
      '`npm run note-scope-blast-radius`',
    discharge:
      'an ownership root for notes (brain_notes has none when scope_task_id is set), or a build whose access assert can be read directly',
  },
  // `report_shipped` — the row the 2026-09-15 06:2xZ receipt named as the next
  // CANDIDATE, with the open question attached rather than a conclusion. The
  // question was answered by measurement and the answer is no — the probe and
  // its five controls are in `scripts/report-shipped-blast-radius-probe.mts`.
  {
    tool: 'report_shipped',
    kind: 'THIRD-PARTY-ARTIFACT',
    reason:
      'an unrefused call is not lost, it is DELIVERED: reportShipped writes `userId: task.userId` while every reader ' +
      'keys on `ctx.userId`, so the row lands in the TASK OWNER\'S shipped feed claiming something went public, and ' +
      'the caller can neither read, enumerate nor delete it — measured, `npm run report-shipped-blast-radius`',
    discharge:
      'a focus-event reader scoped to the CALLER (the MCP surface has none at all today), or a build whose access assert can be read directly',
  },
  // `scratchpad_dismiss` — the last row on the to-do list carrying NO reason at
  // all. The 13:3xZ hand-off named the question to ask first and guessed it was
  // the `delete_note` shape (a missing enumerator). It is not: the enumerator
  // EXISTS. Measured in `scripts/scratch-subject-reachability-probe.mts`
  // (`npm run scratch-subject-reachability`), 6 legs + 4 controls, all fired.
  {
    tool: 'scratchpad_dismiss',
    kind: 'COMPLEMENTARY-SUBJECT',
    reason:
      'the id and the error live in COMPLEMENTARY populations, both gated on the SAME predicate: a non-admin can be ' +
      'refused (scratchpad.ts:95) but enumerates 0 foreign entries, an admin enumerates all of them (:150) but is ' +
      'returned the row before the refusal is reached (:94). And the damage is a FOURTH shape — nothing is created, a ' +
      'human\'s existing idea row is flipped new→dismissed with the prober as filedBy, so a marker-shaped WRITE-SAFETY ' +
      'control cannot see it and the prober cannot undo it — measured, `npm run scratch-subject-reachability`',
    discharge:
      'NOT_SHARED_SCRATCH_ID (which discharges the subject half ONLY) plus a detector for a mutation the prober cannot enumerate',
  },
];

/**
 * ## ADMIN-GATED — at-risk, unprobed, and unprobeable *by this caller*
 *
 * Three of the frame's at-risk tools declare `adminOnly` and `await
 * assertAdmin(ctx)` as the FIRST statement of their handler, ahead of the zod
 * parse and therefore ahead of any access assert on the subject id. For a
 * non-admin caller they answer `This action requires a workspace admin.` to
 * every subject alike — so a probe here would score `CONFLATES` off the
 * **authorization** layer while saying nothing at all about the **access**
 * layer, which is the only thing this card measures.
 *
 * That is RULE 37 in its exact form: a control can be perfectly aimed and still
 * be answered before it reaches the subject. The reading is real — measured
 * 2026-09-15 02:4xZ, `office_venture` on all three of a readable id, the
 * not-shared id and a never-real id → byte-identical admin refusals — but it is
 * a reading of the wrong layer, and publishing it as a 4th conflating tool
 * would have been a fabricated defect more alarming than anything here.
 *
 * ⚠️ **These rows do NOT leave the unprobed count.** They are still at-risk:
 * an admin caller reaches the same access assert every other row does, and
 * nothing here has measured it. Naming the reason shrinks the FINDINGS text,
 * never the gate — a bucket named for *why* a row was excluded reads as
 * disposal, and nobody re-asks the other questions of a row already explained.
 * So the frame keeps counting them and the to-do list prints the reason inline.
 *
 * **The deferral has an expiring precondition, so it carries its own control.**
 * "This caller is not an admin" is true today and is one grant away from being
 * false; `3m8XbdCFyPKu` added admin scope to this very workspace. `ADMIN CTL`
 * therefore re-asks it every run against a subject this caller CAN read: if the
 * admin gate stops answering, the deferral is void and the row must be probed.
 * A limit that cannot notice its own precondition lapsing is a limit that
 * silently becomes a lie.
 */
export const ADMIN_GATED: { tool: string; reason: string }[] = [
  { tool: 'office_venture', reason: 'adminOnly — assertAdmin() answers before the subject assert' },
  { tool: 'share_task', reason: 'adminOnly — assertAdmin() answers before the subject assert' },
  { tool: 'provision_agent', reason: 'adminOnly — assertAdmin() answers before the subject assert' },
];

/** The refusal `assertAdmin` emits. Matched as a prefix-free substring, not as a marker position. */
export const ADMIN_REFUSAL = 'requires a workspace admin';

/**
 * Did the admin gate answer, on a subject this caller can read?
 *
 * `true` = still gated, the deferral holds. `false` = the gate did NOT fire on
 * a readable subject, so this caller now reaches the handler body and the row
 * is probeable — the deferral is stale and must be discharged.
 */
export function adminGateStillClosed(a: { isError: boolean; text: string }): boolean {
  return a.isError && a.text.includes(ADMIN_REFUSAL);
}

/**
 * The ADMIN-CTL call's arguments: the subject id under the name that tool uses
 * for it, and **deliberately nothing else**.
 *
 * Two of these three are the most destructive tools in the registry —
 * `share_task` grants another identity access, `provision_agent` mints a user
 * and a token — so a control that pokes them has to be safe in the world where
 * it *fires*, not only in the world where it is refused. It is: `assertAdmin`
 * runs first, and if it ever stops answering, the zod parse is next and these
 * argument objects cannot satisfy it (`share_task` requires one of
 * `userId`/`email`, `provision_agent` requires `name`). So the gate opening
 * turns this control into a validation error, never into a grant.
 *
 * That ordering is the control's real precondition, and it is why the subject
 * id is the only thing supplied. Adding the missing fields to "make the probe
 * more realistic" would turn a safe reading into a live share.
 */
export function adminGateProbeArgs(tool: string, subjectId: string): Record<string, unknown> {
  const prop =
    tool === 'office_venture' ? 'entityId' : tool === 'provision_agent' ? 'shareTaskId' : 'taskId';
  return { [prop]: subjectId };
}

/**
 * The fixture's `parentId` as read back off a `get_task` answer.
 *
 * `null` means *"this answer does not carry a parent"* — an error, an
 * unparseable body, or a row the caller cannot read. Kept distinct from a real
 * parent string on purpose: "I could not read it" and "I read it and it is
 * somewhere else" are different facts, and only the second is a landed write.
 */
export function parentIdOf(a: { isError: boolean; text: string }): string | null {
  if (a.isError) return null;
  try {
    const p: unknown = JSON.parse(a.text);
    const v = (p as { parentId?: unknown })?.parentId;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Is the move fixture usable as the `id` slot of the `move_task` probe?
 *
 * Both legs are required and they answer different questions. `readable` says
 * the call reached the handler at all (RULE 37 — a probe answered by an earlier
 * gate is not a reading of the access layer). `parentId === expected` says the
 * fixture is where the repair path assumes it is; a fixture already sitting
 * somewhere else means a PREVIOUS run landed a write nobody repaired, and
 * publishing this run's row over it would quietly ratify that.
 *
 * When this returns `false` the `move_task` row is not probed and `move_task`
 * stays in the unprobed to-do list. It does not become a green row for want of
 * a subject.
 */
export function moveFixtureUsable(f: { reachOk: boolean; parentId: string | null }): boolean {
  return f.reachOk && f.parentId === MOVE_FIXTURE_PARENT_ID;
}

/**
 * Where `scratchpad_list` says the fixture entry is filed, or null.
 *
 * ⚠️ Reads the entry OUT OF A LIST by id rather than taking row 0. There is no
 * scalar getter for a scratch entry on the MCP surface, so the enumerator is
 * the only reader — and an enumerator's first row is whatever sorted first,
 * which on `scratchpad_list` is the newest entry and not necessarily ours.
 */
export function filedTaskIdOf(a: { isError: boolean; text: string }, entryId: string): string | null {
  if (a.isError) return null;
  try {
    const parsed: unknown = JSON.parse(a.text);
    if (!Array.isArray(parsed)) return null;
    const row = (parsed as { id?: unknown; filedTaskId?: unknown }[]).find((r) => r.id === entryId);
    return typeof row?.filedTaskId === 'string' ? row.filedTaskId : null;
  } catch {
    return null;
  }
}

/**
 * Is the scratch entry usable as the `id` slot of the `scratchpad_file` probe?
 *
 * Same two-leg shape as `moveFixtureUsable`, and for the same reason. `reachOk`
 * says the call got past `loadAccessible` into the handler body, so a later
 * `CONFLATES` on this row is a reading of the access layer. The `filedTaskId`
 * leg says the fixture is where it belongs — if a previous run left it filed
 * somewhere else, this run must not quietly measure against a subject an
 * earlier probe already moved.
 */
export function scratchFixtureUsable(f: { reachOk: boolean; filedTaskId: string | null }): boolean {
  return f.reachOk && f.filedTaskId === SCRATCH_FIXTURE_TASK_ID;
}

/**
 * Which probe rows must be SKIPPED this run, given each fixture's precondition.
 *
 * Pure and exported for one reason, and it is a rule this file earned the hard
 * way: the first version of the skip decision lived inline in `main()`, and an
 * ablation that removed it came back GREEN — not because the control was dead
 * but because no test could reach the branch (precondition 13 on
 * `F3JVD_0PuXGY`). `probedNamesFor` was extracted then. This is the same
 * extraction for the other half of the decision, done BEFORE a second fixture
 * row made the inline version a two-case conditional.
 */
export function probesToSkip(f: {
  moveFixtureOk: boolean;
  scratchFixtureOk: boolean;
  /**
   * Optional and defaulted to `true` so existing callers are unchanged: did
   * BOTH urls of the `attach_file_from_url` dimension read as declared, from
   * this box, before prod was asked?
   *
   * A failed precondition skips the row rather than degrading it to one
   * variant. Degrading would be the worst available outcome here: with only
   * the fetchable url the row scores 🟢 and the defect disappears; with only
   * the unfetchable one it scores 🔴 for a reason its own output cannot
   * support. A row measured on half its dimension belongs on the to-do list.
   */
  afuUrlsOk?: boolean;
}): string[] {
  const skip: string[] = [];
  if (!f.moveFixtureOk) skip.push('move_task');
  if (!f.scratchFixtureOk) skip.push('scratchpad_file');
  if (f.afuUrlsOk === false) skip.push('attach_file_from_url');
  return skip;
}

/**
 * A task this caller can definitely read — precondition 12's third subject, and
 * the one a `reachSafe` variant is paired with.
 *
 * Its job is to tell *"both refused subjects answered the same thing"* apart
 * from *"this call never reached the handler"*. Three identical rows is the
 * second, and on 2026-09-15 08:5xZ a hand pass published the first from exactly
 * that output, because it had no third subject.
 */
export const READABLE_REACH_TASK_ID = process.env.READABLE_REACH_TASK_ID || 'Tx5g85uLq96D';

/**
 * A scope this caller CAN read, holding at least one note. Without it the two
 * `[]` readings from the note tools are a fact about the READER — a note
 * surface that answers `[]` to everything would print the same rows. Defaults
 * to the website-builder venture, which holds `_yV8UcWq4-0_`.
 */
export const READABLE_SCOPE_TASK_ID = process.env.READABLE_SCOPE_TASK_ID || '0kOf10V9thDz';

/* ------------------------------------------------------------------ */
/* the FRAME — what population is `PROBES` a subset OF?                */
/* ------------------------------------------------------------------ */

/**
 * ## Why the frame exists
 *
 * For five hours `PROBES` grew by whatever the last runner happened to notice
 * — 6 → 7 → 9 → 10 → 11 → 12 — and every receipt published `N of 12`. Twelve
 * is a numerator. Nothing ever printed **the set those twelve are a subset
 * of**, so the probe reproduced the exact shape it was built to kill: a
 * hand-written list that reads as complete because nothing prints what it
 * omits. This card's own fix brief says *"add a test per tool, not one shared
 * test: the current single-site guarantee is exactly what made this look
 * covered"* — and the probe was the single-site guarantee one level up.
 *
 * So the denominator is DERIVED from the tool registry on every run. It is not
 * a number anybody types: a remembered denominator rots exactly the way the
 * marker's `2 of 32` target did.
 *
 * ## Why the referent, not the argument name
 *
 * An earlier hand pass keyed on the ARGUMENT NAME and swept in `get_user(id)`
 * — a *user* id, which is not a shareable row and cannot produce this bug.
 * That is keying on FORM. What makes a tool at-risk is the KIND OF ROW its id
 * names, so each id-shaped argument is resolved to a referent. `id` is
 * resolved PER TOOL, because the same name means a task on `get_task`, a note
 * on `get_note`, a prompt on `cancel_prompt` and a user on `get_user`.
 *
 * ## Why an unknown argument is AT-RISK rather than safe
 *
 * If a new tool ships an id-shaped argument this map has never seen, the
 * honest reading is *"nobody has classified this"*, and the frame goes
 * INCONCLUSIVE. Landing it in the safe bucket would be RULE 30 exactly — an
 * aggregate that counts the defect value reads an unread row as healthy. The
 * whole purpose of this census is to make a NEW unprobed tool loud, so it must
 * not be able to arrive quietly on the reassuring side.
 */
export type Referent = 'task' | 'note' | 'scratch' | 'user' | 'prompt' | 'comment' | 'attachment' | 'UNCLASSIFIED';

/**
 * The three row kinds that are SHARE-SCOPED, i.e. the ones that can exist and
 * be invisible to the caller. Only a tool naming one of these can conflate
 * "not shared" with "not there" in the first place.
 */
export const SHAREABLE_REFERENTS: Referent[] = ['task', 'note', 'scratch'];

/** Unambiguous id-argument names: the name alone fixes the referent. */
export const ID_ARG_REFERENT: Record<string, Referent> = {
  taskId: 'task',
  parentId: 'task',
  newParentId: 'task',
  goalId: 'task',
  goalTaskId: 'task',
  milestoneId: 'task',
  scopeTaskId: 'task',
  shareTaskId: 'task',
  entityId: 'task',
  noteId: 'note',
  parentNoteId: 'note',
  newParentNoteId: 'note',
  assigneeId: 'user',
  reviewerId: 'user',
  userId: 'user',
  agentId: 'user',
  attachmentId: 'attachment',
};

/**
 * Ambiguous names, resolved per tool. Keyed `<tool>.<arg>`. Every entry here is
 * a bare `id`, and the spread of referents across it is the reason the
 * name-only map above cannot cover it: `id` names four different kinds of row
 * depending on which tool you are holding.
 */
export const TOOL_ID_ARG_REFERENT: Record<string, Referent> = {
  'get_task.id': 'task',
  'update_task.id': 'task',
  'delete_task.id': 'task',
  'move_task.id': 'task',
  'get_note.id': 'note',
  'update_note.id': 'note',
  'delete_note.id': 'note',
  'move_note.id': 'note',
  'scratchpad_file.id': 'scratch',
  'scratchpad_dismiss.id': 'scratch',
  'cancel_prompt.id': 'prompt',
  'delete_comment.id': 'comment',
  'delete_attachment.id': 'attachment',
  'get_user.id': 'user',
};

/** Is a property name id-SHAPED, i.e. a candidate that must then be classified? */
export function isIdShaped(prop: string): boolean {
  return /^id$|Id$/.test(prop);
}

/** Resolve one argument to the kind of row it names. Per-tool first. */
export function referentOf(tool: string, prop: string): Referent {
  return TOOL_ID_ARG_REFERENT[`${tool}.${prop}`] ?? ID_ARG_REFERENT[prop] ?? 'UNCLASSIFIED';
}

/** The shape the frame census needs from a registered tool. Structural, so tests can pass literals. */
export type RegisteredTool = { name: string; inputSchemaJson?: { properties?: Record<string, unknown> } };

export type FrameRow = {
  tool: string;
  /** Every id-shaped argument, with the kind of row it names. */
  idArgs: { prop: string; referent: Referent }[];
  /** Names at least one shareable row — so this tool CAN commit the bug. */
  atRisk: boolean;
  /** Carries an id-shaped argument nobody has classified. Forces at-risk AND voids the frame. */
  unclassified: boolean;
  probed: boolean;
};

export type Frame = {
  rows: FrameRow[];
  total: number;
  atRisk: string[];
  probed: string[];
  /** AT-RISK and never probed — the term every receipt on this card was missing. */
  unprobed: string[];
  /** Tools with no id-shaped argument at all: they have no subject to conflate. */
  noIdArg: string[];
  /** At-risk only because an argument is unclassified. Non-empty ⇒ the frame is not a reading. */
  unclassifiedArgs: { tool: string; prop: string }[];
  /**
   * Properties whose NAME is not id-shaped but whose DESCRIPTION mentions an
   * id. The catch-net for `isIdShaped` missing a candidate. Non-empty is NOT a
   * failure — it is a list to eyeball, and it is printed so that a real miss
   * cannot hide in a silent section.
   */
  catchNet: { tool: string; prop: string }[];
  controls: {
    /** Every PROBED tool must itself read as at-risk. If one does not, the classifier is deflating the denominator. */
    probedAreAtRisk: { ok: boolean; total: number; atRisk: number };
    /** A tool taking only a USER id must NOT read as at-risk — the reading the hand pass got wrong. */
    userIdNegCtl: { tool: string; ok: boolean };
    /** A tool with no id argument at all must NOT read as at-risk. */
    noIdNegCtl: { tool: string; ok: boolean };
    /** A non-empty registry. A frame over zero tools has no denominator. */
    population: { ok: boolean; total: number };
  };
};

/** The NEG-CTL tools, named so a test can pin them and a reader can see what was controlled. */
export const FRAME_USER_ID_NEG_CTL = 'get_user';
export const FRAME_NO_ID_NEG_CTL = 'search_users';

/**
 * The names the frame may count as PROBED, given the tools this run skipped.
 *
 * Extracted from `main()` on 2026-09-15 03:5xZ because an ablation of the skip
 * path came back GREEN — the exclusion lived inline in the CLI, where no test
 * could reach it, so a future edit could have deleted it silently and the
 * suite would not have moved. `PROBES` is a list of INTENTIONS; a row whose
 * subject was unusable was never asked, and a tool that was never asked belongs
 * on the to-do list, not in the covered count.
 */
export function probedNamesFor(skipped: string[]): string[] {
  const skip = new Set(skipped);
  return [...PROBES.map((p) => p.tool).filter((t) => !skip.has(t)), ...DEFERRED.map((d) => d.tool)];
}

/**
 * Census the registry against the probed set. Pure — the registry is passed in,
 * so a test drives it with literals and the CLI drives it with `TOOLS`.
 */
export function frameCensus(tools: RegisteredTool[], probedNames: string[]): Frame {
  const probedSet = new Set(probedNames);
  const rows: FrameRow[] = tools.map((t) => {
    const props = Object.keys(t.inputSchemaJson?.properties ?? {});
    const idArgs = props.filter(isIdShaped).map((prop) => ({ prop, referent: referentOf(t.name, prop) }));
    const unclassified = idArgs.some((a) => a.referent === 'UNCLASSIFIED');
    return {
      tool: t.name,
      idArgs,
      // An unclassified argument counts AT-RISK: the unread row must not land
      // in the healthy bucket (RULE 30).
      atRisk: unclassified || idArgs.some((a) => SHAREABLE_REFERENTS.includes(a.referent)),
      unclassified,
      probed: probedSet.has(t.name),
    };
  });

  const catchNet: { tool: string; prop: string }[] = [];
  for (const t of tools) {
    for (const [prop, schema] of Object.entries(t.inputSchemaJson?.properties ?? {})) {
      if (isIdShaped(prop)) continue;
      const desc = String((schema as { description?: unknown })?.description ?? '');
      if (/\bid\b/i.test(desc)) catchNet.push({ tool: t.name, prop });
    }
  }

  const atRiskRows = rows.filter((r) => r.atRisk);
  const probedRows = rows.filter((r) => r.probed);
  return {
    rows,
    total: rows.length,
    atRisk: atRiskRows.map((r) => r.tool),
    probed: probedRows.map((r) => r.tool),
    unprobed: atRiskRows.filter((r) => !r.probed).map((r) => r.tool),
    noIdArg: rows.filter((r) => r.idArgs.length === 0).map((r) => r.tool),
    unclassifiedArgs: rows.flatMap((r) =>
      r.idArgs.filter((a) => a.referent === 'UNCLASSIFIED').map((a) => ({ tool: r.tool, prop: a.prop })),
    ),
    catchNet,
    controls: {
      probedAreAtRisk: {
        ok: probedRows.length > 0 && probedRows.every((r) => r.atRisk),
        total: probedRows.length,
        atRisk: probedRows.filter((r) => r.atRisk).length,
      },
      userIdNegCtl: {
        tool: FRAME_USER_ID_NEG_CTL,
        ok: rows.some((r) => r.tool === FRAME_USER_ID_NEG_CTL && !r.atRisk),
      },
      noIdNegCtl: {
        tool: FRAME_NO_ID_NEG_CTL,
        ok: rows.some((r) => r.tool === FRAME_NO_ID_NEG_CTL && !r.atRisk),
      },
      population: { ok: rows.length > 0, total: rows.length },
    },
  };
}

/** Did every frame control fire? A frame whose controls failed is not a denominator. */
export function frameControlsOk(f: Frame): boolean {
  return (
    f.unclassifiedArgs.length === 0 &&
    f.controls.probedAreAtRisk.ok &&
    f.controls.userIdNegCtl.ok &&
    f.controls.noIdNegCtl.ok &&
    f.controls.population.ok
  );
}

/**
 * One variant's reading. `UNREACHED` is the status this table could not
 * express before 2026-09-15: two identical refused legs are *"conflates"* only
 * if you also know the call got into the handler, and the only thing that knows
 * that is a third subject the caller CAN read (precondition 12).
 */
export type VariantStatus = 'DISTINGUISHES' | 'CONFLATES' | 'UNREACHED';

export type VariantRow = {
  name: string;
  why: string;
  notShared: Klass;
  neverReal: Klass;
  /** The reach leg, or `null` when this variant may not be paired with a readable subject. */
  readable: Klass | null;
  status: VariantStatus;
};

/**
 * ⚠️ The `readable === null` branch falls to `CONFLATES`, NOT to a third
 * "indeterminate" status, and that is a deliberate choice about what this
 * change may restate.
 *
 * Every single-variant row on this table has no reach leg, so routing them to a
 * new status would silently re-verdict `list_tasks` / `list_notes` /
 * `search_notes` — three rows this card has published as CONFLATING for two
 * days — on the strength of a leg that was never run. Their reading is
 * unchanged and its limit is named where it belongs: in `variantsOf`, as the
 * next unit. A reach leg that did NOT run cannot make a row greener OR redder.
 */
export function variantStatus(v: { notShared: Klass; neverReal: Klass; readable: Klass | null }): VariantStatus {
  if (v.notShared !== v.neverReal) return 'DISTINGUISHES';
  if (v.readable !== null && v.readable === v.notShared) return 'UNREACHED';
  return 'CONFLATES';
}

/**
 * Roll a row's variants into the fields the rest of the file already reads.
 *
 * The conjunction is the whole point: a two-dimensional tool that answers
 * cleanly on one argument set and not on another is NOT a clean row, and the
 * reading that says so must be the one that survives. Both single-url designs
 * for `attach_file_from_url` were wrong in opposite directions; only the pair
 * says anything.
 */
/**
 * Did this variant's calls MUTATE anything?
 *
 * Read off the transport, not off the classification: a refusal is an error, so
 * a write that comes back WITHOUT one reached the mutation.
 *
 * ⚠️ **The reach leg is a leg of this rule, and until 2026-09-15 12:5xZ it was
 * not read.** The run loop's own comment said *"the reach leg counts too: on a
 * readable subject it is the one call here whose success would be a real
 * attachment"* — and the condition beside it named only the two refused
 * subjects, because `readable` was narrowed to a `Klass` at the call site and
 * its `isError` was discarded on the way. The gauge was correct anyway, for a
 * reason that has nothing to do with the gauge: the only `reachSafe` variant in
 * existence was `attach_file_from_url[url=unfetchable]`, which cannot succeed
 * at all. `finalize_upload[object=absent]` is the second, and it is a write.
 *
 * **A control whose prose describes a leg its code does not read is already
 * failing — it just cannot say so, because nothing has exercised the leg.** The
 * same shape as precondition 12 one level up: an untested branch and a passing
 * branch print the same green.
 *
 * Extracted rather than left inline for precondition 22: the rule was a
 * condition inside `main()`, so no test could import it, and the test that
 * "covered" it would have had to re-type it as a local lambda — agreeing with a
 * copy instead of with the code, and staying green through exactly this edit.
 */
export function variantLanded(a: {
  notShared: { isError: boolean };
  neverReal: { isError: boolean };
  /** `null` when the variant is not `reachSafe` — no reach leg was sent. */
  readable: { isError: boolean } | null;
}): boolean {
  return !a.notShared.isError || !a.neverReal.isError || a.readable?.isError === false;
}

export function rollUpVariants(vs: VariantRow[]): {
  distinguishes: boolean;
  varies: boolean;
  unreachedVariants: string[];
  conflatingVariants: string[];
} {
  return {
    distinguishes: vs.length > 0 && vs.every((v) => v.status === 'DISTINGUISHES'),
    varies: new Set(vs.map((v) => v.status)).size > 1,
    unreachedVariants: vs.filter((v) => v.status === 'UNREACHED').map((v) => v.name),
    conflatingVariants: vs.filter((v) => v.status === 'CONFLATES').map((v) => v.name),
  };
}

export type Row = {
  tool: string;
  note: string;
  notShared: Klass;
  neverReal: Klass;
  distinguishes: boolean;
  /** Present on every row: one entry for a single-argument tool, several for a multi-argument one. */
  variants?: VariantRow[];
  /** The variants disagreed. The finding precondition 21 names, and it is invisible in `distinguishes`. */
  varies?: boolean;
  /** Variants whose three legs came back identical — never asked, not answered. */
  unreachedVariants?: string[];
  /** Mirrors `Probe.write` — this call would have mutated had it not been refused. */
  write?: boolean;
  /**
   * A write probe whose call came back as a NON-error, on either leg: it was
   * not refused, so it may have landed. Only meaningful with `write`.
   */
  landed?: boolean;
};

export type Verdict = {
  /**
   * `INCOMPLETE` is the status this card spent five hours unable to express:
   * every probed tool distinguishes AND at-risk tools were never asked. It maps
   * to exit 1, not 0 — coverage is a finding, and `🟢 DISTINGUISHES` over a
   * hand-picked twelfth of the surface is the comforting reading the card
   * exists to reject.
   */
  status: 'DISTINGUISHES' | 'CONFLATES' | 'VARIES' | 'INCOMPLETE' | 'INCONCLUSIVE';
  reason: string;
  conflating: string[];
  /**
   * Tools whose variants DISAGREED — the verdict is a function of an argument
   * that has nothing to do with access. Present on every shape, so it is
   * printable at zero: a finding only visible when it fires is indistinguishable
   * from one that was never looked for.
   */
  varying: string[];
  /** `tool[variant]` pairs whose three legs came back identical — never asked. */
  unreached: string[];
  /** Write probes that were NOT refused. Non-empty means this run may have mutated prod. */
  landedWrites: string[];
  /** AT-RISK tools this run never asked. Present on every shape, so it is printable at zero. */
  unprobed: string[];
};

/**
 * The exit contract, exported so a test pins THIS function rather than a copy
 * of it. It lived inline in `main()` until 2026-09-15 11:5xZ, where no test
 * could reach it — and a status landing in the `0` bucket makes the whole
 * reading decorative, which is the one failure a suite of pure `decide` tests
 * cannot see.
 *
 * `0` covered-and-clean · `1` CONFLATES / VARIES / INCOMPLETE · `2` INCONCLUSIVE.
 */
export function exitCodeFor(verdict: Verdict): number {
  if (verdict.status === 'DISTINGUISHES') return 0;
  if (verdict.status === 'CONFLATES' || verdict.status === 'VARIES' || verdict.status === 'INCOMPLETE') return 1;
  return 2;
}

/**
 * The clause that names a multi-argument disagreement, appended to whichever
 * verdict wins. Returns `''` when nothing varies, so it costs a clean run
 * nothing — but a VARYING row must never be readable only from the status line,
 * because `CONFLATES` can outrank it and would then swallow it whole.
 */
export function varyingClause(varying: string[], unreached: string[]): string {
  if (varying.length === 0) return '';
  return (
    `. ⚠️ ${varying.join(', ')} gave different verdicts on different argument sets` +
    (unreached.length ? ` — ${unreached.join(', ')} never reached the handler at all` : '')
  );
}

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
  /**
   * Optional and defaulted to `false` so existing callers are unchanged: did
   * the move fixture's `parentId` differ AFTER the run from what it was before?
   *
   * This is the STATE leg of the move probe's safety, and it is deliberately
   * separate from `landed`. `landed` reads the ANSWER — it fires when a write
   * probe came back without an error. For a move those two can disagree in
   * either direction: a build could move the row and still answer with an
   * error, or answer cleanly having changed nothing. A control that counts the
   * event cannot see the state, so both are read and either one voids the run.
   */
  moveFixtureMoved?: boolean;
  /**
   * Optional and defaulted to `false` so existing callers are unchanged: is the
   * scratch fixture filed somewhere other than where it started?
   *
   * The STATE leg of the `scratchpad_file` probe, and separate from `landed`
   * for exactly the reason the move one is: `landed` reads the ANSWER, this
   * reads the WORLD, and a build can get those two out of step in either
   * direction. Ordered with the move leg, ahead of WRITE-SAFETY.
   */
  scratchFixtureMoved?: boolean;
  /**
   * Optional and defaulted to absent so existing callers are unchanged: the
   * DERIVED population the probed set is a subset of. Supply it and the verdict
   * gains its second term; omit it and the verdict is exactly what it was —
   * which is also the honest shape, because a caller with no registry in hand
   * genuinely cannot state coverage.
   */
  frame?: Frame;
}): Verdict {
  // A row CONFLATES when some variant answered the two refused subjects
  // identically AND that variant is known to have reached the handler. For a
  // single-variant row (no reach leg) this is exactly `!distinguishes`, so
  // every reading this table has already published is unchanged.
  const conflating = args.rows
    .filter((r) => (r.variants ? r.variants.some((v) => v.status === 'CONFLATES') : !r.distinguishes))
    .map((r) => r.tool);
  const varying = args.rows.filter((r) => r.varies).map((r) => r.tool);
  const unreached = args.rows.flatMap((r) => (r.unreachedVariants ?? []).map((n) => `${r.tool}[${n}]`));
  // A row with NO variant that reached the handler is not a reading at all.
  const neverAsked = args.rows
    .filter((r) => r.variants && r.variants.length > 0 && r.variants.every((v) => v.status === 'UNREACHED'))
    .map((r) => r.tool);
  const landedWrites = args.rows.filter((r) => r.write && r.landed).map((r) => r.tool);
  const unprobed = args.frame?.unprobed ?? [];
  const base = { conflating, varying, unreached, landedWrites, unprobed };

  // The STATE leg is ordered ahead of even the WRITE-SAFETY answer leg, because
  // it is the one reading that is about the world rather than about a reply.
  // A build that moved the fixture and then answered with an error would be
  // reported by nothing else here.
  if (args.moveFixtureMoved) {
    return {
      status: 'INCONCLUSIVE',
      reason:
        `the move fixture (${MOVE_FIXTURE_TASK_ID}) is NOT where it was before this run — a move_task probe LANDED. ` +
        `It belongs under ${MOVE_FIXTURE_PARENT_ID}; this run attempts the repair and reports whether it took. ` +
        'Treat every row above as measured against a target this run changed',
      ...base,
    };
  }

  if (args.scratchFixtureMoved) {
    return {
      status: 'INCONCLUSIVE',
      reason:
        `the scratch fixture (${SCRATCH_FIXTURE_ENTRY_ID}) is NOT filed where it was before this run — a ` +
        `scratchpad_file probe LANDED. It belongs under ${SCRATCH_FIXTURE_TASK_ID}; this run attempts the repair ` +
        'and reports whether it took. Treat every row above as measured against a target this run changed',
      ...base,
    };
  }
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
        `MUTATED the target. Look for a task titled "${PROBE_TASK_TITLE}", for a comment body starting ` +
        `"${PROBE_COMMENT_BODY}", for a NOTE titled "${PROBE_NOTE_TITLE}" (enumerable only via ` +
        'list_notes(scopeTaskId=…), which CONFLATES — so check get_note on the id the call returned), ' +
        'and for attachments named ' +
        '"not-shared-probe.txt" before trusting anything else here. ' +
        `⚠️ ask_human is the one whose damage is already DELIVERED: a prompt reading "${PROBE_ASK_PROMPT}" ` +
        'has bumped its task to status="review" and is sitting in that task owner\'s queue — find it with ' +
        'list_prompts(taskId=…) (a row that distinguishes, so the enumerator works) and retract it with ' +
        'cancel_prompt, then put the task back where it was. ' +
        `⚠️ create_upload is the exception: it leaves NO artifact to look for — a "${PROBE_UPLOAD_FILENAME}" ` +
        'grant is a signed PUT URL into another owner\'s storage prefix, visible to no enumerator ' +
        'and expiring on its own, so if that row is in the list above, treat the credential as leaked',
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

  // The coverage clause, appended to the headline rather than replacing it: a
  // conflating tool is a defect and an unprobed tool is a gap, and fusing the
  // two into one number would make each unreadable.
  const coverage = args.frame
    ? `, and ${unprobed.length} of ${args.frame.atRisk.length} AT-RISK tool(s) were never asked` +
      (unprobed.length ? ` (${unprobed.join(', ')})` : '')
    : '';

  // Ordered AHEAD of CONFLATES, for the same reason WRITE-SAFETY is ordered
  // ahead of SUBJECT: every clause below says something about the build, and
  // this one says the run did not ask. A row whose every variant came back
  // identical on all three subjects — including one this caller CAN read — did
  // not reach the handler, and publishing either verdict from that output is
  // what happened by hand on 2026-09-15 08:5xZ.
  if (neverAsked.length > 0) {
    return {
      status: 'INCONCLUSIVE',
      reason:
        `${neverAsked.join(', ')} answered identically to the not-shared subject, the never-real one AND a subject ` +
        'this caller can read, on every variant — three identical rows is "this tool was never asked", not ' +
        '"this tool conflates". Nothing about the build is known from those rows',
      ...base,
    };
  }

  if (conflating.length > 0) {
    return {
      status: 'CONFLATES',
      reason:
        `${conflating.length} of ${args.rows.length} probed tool(s) answer the same thing to both subjects` +
        coverage +
        varyingClause(varying, unreached),
      ...base,
    };
  }

  // VARIES — no row conflates on a reached variant, but at least one row gave
  // DIFFERENT verdicts on different argument sets. Its own status rather than a
  // footnote on DISTINGUISHES, because the comforting half of a disagreement is
  // exactly what a one-variant probe would have printed on its own.
  if (varying.length > 0) {
    return {
      status: 'VARIES',
      reason:
        `${varying.length} of ${args.rows.length} probed tool(s) give DIFFERENT verdicts on different argument ` +
        'sets, so no single reading of them is a reading of the tool' +
        coverage +
        varyingClause(varying, unreached),
      ...base,
    };
  }

  // Only reachable once nothing conflates. A frame whose own controls failed
  // cannot state coverage, and "every probed tool passes" published without a
  // denominator is the sentence this clause exists to prevent.
  if (args.frame && !frameControlsOk(args.frame)) {
    return {
      status: 'INCONCLUSIVE',
      reason:
        'every probed tool distinguishes, but the FRAME controls did not hold — ' +
        (args.frame.unclassifiedArgs.length
          ? `${args.frame.unclassifiedArgs.length} id-shaped argument(s) are unclassified (` +
            `${args.frame.unclassifiedArgs.map((a) => `${a.tool}.${a.prop}`).join(', ')})`
          : 'a frame control failed') +
        ' — so the probed set has no readable denominator and the pass cannot be scoped',
      ...base,
    };
  }

  if (unprobed.length > 0) {
    return {
      status: 'INCOMPLETE',
      reason:
        `all ${args.rows.length} probed tool(s) tell the two subjects apart` +
        coverage +
        ' — a pass over a hand-picked subset is not a pass over the surface',
      ...base,
    };
  }

  return {
    status: 'DISTINGUISHES',
    reason: `all ${args.rows.length} probed tool(s) tell the two subjects apart` + coverage,
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
  const adminGateReadings: { tool: string; closed: boolean; klass: Klass }[] = [];
  let authControlSameAsReal = false;
  // SCOPE-READER control: a scope this caller CAN read must yield a note.
  let scopeReaderNotes = -1;
  let scopeReaderControlOk = true;
  // MOVE-FIXTURE control state, all of it printed every run.
  let moveFixtureParentBefore: string | null = null;
  let moveFixtureParentAfter: string | null = null;
  let moveFixtureReachOk = false;
  let moveFixtureOk = false;
  let moveFixtureRepaired: boolean | null = null;
  // SCRATCH-FIXTURE control state, all of it printed every run.
  let scratchFiledBefore: string | null = null;
  let scratchFiledAfter: string | null = null;
  let scratchReachOk = false;
  let scratchFixtureOk = false;
  let scratchFixtureRepaired: boolean | null = null;
  // URL-DIMENSION preconditions, read from THIS box before prod is asked.
  let urlPreconditions: UrlPrecondition[] = [];
  let afuUrlsOk = false;
  // Every `tool[variant]` whose write probe came back WITHOUT an error.
  const landedByVariant: string[] = [];
  const skippedProbes: string[] = [];

  if (subjectControlOk) {
    const readable = await callTool(url, auth, 'list_notes', { scopeTaskId: READABLE_SCOPE_TASK_ID });
    scopeReaderNotes = countRows(readable);
    scopeReaderControlOk = scopeReaderNotes > 0;

    // MOVE-FIXTURE control, both legs, BEFORE the move probe is allowed to run.
    // REACH: a no-op move of the fixture to its own current parent must
    // succeed, which proves this caller reaches move_task's handler body — so a
    // CONFLATES on that row later is a reading of the access layer and not of
    // some gate that answered first. It is a real write and it is deliberately
    // the most boring one available: same parent, no position argument, so
    // `nextPosition` appends and no sibling is shifted.
    const fixturePre = await callTool(url, auth, 'get_task', {
      id: MOVE_FIXTURE_TASK_ID,
      fields: ['title', 'parentId'],
    });
    moveFixtureParentBefore = parentIdOf(fixturePre);
    const reach = await callTool(url, auth, 'move_task', {
      id: MOVE_FIXTURE_TASK_ID,
      newParentId: MOVE_FIXTURE_PARENT_ID,
    });
    moveFixtureReachOk = !reach.isError;
    moveFixtureOk = moveFixtureUsable({ reachOk: moveFixtureReachOk, parentId: moveFixtureParentBefore });

    // SCRATCH-FIXTURE control, both legs, BEFORE the scratchpad_file probe is
    // allowed to run. Same two questions as the move fixture: does the call
    // reach the handler body (REACH — re-file the fixture to the readable task
    // it already sits under, the most boring write available), and is the
    // fixture where it belongs to begin with.
    const scratchPre = await callTool(url, auth, 'scratchpad_list', { status: 'all', scope: 'mine', limit: 200 });
    scratchFiledBefore = filedTaskIdOf(scratchPre, SCRATCH_FIXTURE_ENTRY_ID);
    const scratchReach = await callTool(url, auth, 'scratchpad_file', {
      id: SCRATCH_FIXTURE_ENTRY_ID,
      taskId: SCRATCH_FIXTURE_TASK_ID,
    });
    scratchReachOk = !scratchReach.isError;
    scratchFixtureOk = scratchFixtureUsable({ reachOk: scratchReachOk, filedTaskId: scratchFiledBefore });

    // URL-DIMENSION precondition, read from THIS box and BEFORE prod is asked,
    // for the same reason the two fixtures are: a probe whose power depends on
    // a fixture's state must assert that state (precondition 16). If either url
    // is not what it is declared to be, the row is skipped rather than degraded
    // to whichever single url still works.
    urlPreconditions = await checkUrlPreconditions(afuFetchableUrlFor(url));
    afuUrlsOk = urlPreconditions.every((p) => p.ok);

    // A row whose fixture precondition failed is NOT probed, and therefore not
    // in the probed set the frame is built from — it goes back on the to-do
    // list rather than becoming a row with no reading behind it.
    skippedProbes.push(...probesToSkip({ moveFixtureOk, scratchFixtureOk, afuUrlsOk }));

    for (const p of PROBES) {
      if (skippedProbes.includes(p.tool)) continue;
      const variants: VariantRow[] = [];
      for (const v of variantsOf(p, url)) {
        const notShared = await callTool(url, auth, p.tool, v.args(NOT_SHARED_TASK_ID));
        const neverReal = await callTool(url, auth, p.tool, v.args(NEVER_REAL_TASK_ID));
        // The reach leg, and it is opt-in per VARIANT rather than per tool:
        // for `attach_file_from_url` the same tool is safe to point at a
        // readable subject with one url and would create an attachment with
        // the other.
        const readableAnswer = v.reachSafe ? await callTool(url, auth, p.tool, v.args(READABLE_REACH_TASK_ID)) : null;
        const readable = readableAnswer?.klass ?? null;
        variants.push({
          name: v.name,
          why: v.why,
          notShared: notShared.klass,
          neverReal: neverReal.klass,
          readable,
          status: variantStatus({ notShared: notShared.klass, neverReal: neverReal.klass, readable }),
        });
        // Read off the transport, not off the classification: a refusal is an
        // error, so a write that comes back WITHOUT one reached the mutation.
        // Accumulated across variants — a write that landed on ANY argument set
        // landed.
        //
        // The reach leg is read here too — see `variantLanded`, which is where
        // the rule lives so a test can reach it.
        if (p.write && variantLanded({ notShared, neverReal, readable: readableAnswer })) {
          landedByVariant.push(`${p.tool}[${v.name}]`);
        }
      }
      const rolled = rollUpVariants(variants);
      rows.push({
        tool: p.tool,
        note: p.note,
        // The headline pair stays the FIRST variant's, so a single-argument row
        // prints exactly what it always printed and a multi-argument one is
        // never summarised into one column it does not have.
        notShared: variants[0].notShared,
        neverReal: variants[0].neverReal,
        distinguishes: rolled.distinguishes,
        variants,
        varies: rolled.varies,
        unreachedVariants: rolled.unreachedVariants,
        write: p.write,
        landed: p.write ? landedByVariant.some((l) => l.startsWith(`${p.tool}[`)) : undefined,
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

    // ADMIN-GATE control. Asked against a subject this caller CAN read, so a
    // closed gate is a fact about the credential and not about the subject —
    // the whole point of the deferral is that these tools answer the same
    // thing to every id, readable or not.
    for (const g of ADMIN_GATED) {
      const a = await callTool(url, auth, g.tool, adminGateProbeArgs(g.tool, READABLE_SCOPE_TASK_ID));
      adminGateReadings.push({ tool: g.tool, closed: adminGateStillClosed(a), klass: a.klass });
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

    // STATE leg, last: where is the fixture NOW? Read even when the move row
    // was skipped — the REACH leg is itself a move, so the question is live
    // either way.
    const fixturePost = await callTool(url, auth, 'get_task', {
      id: MOVE_FIXTURE_TASK_ID,
      fields: ['title', 'parentId'],
    });
    moveFixtureParentAfter = parentIdOf(fixturePost);
    if (moveFixtureParentBefore !== null && moveFixtureParentAfter !== moveFixtureParentBefore) {
      // Repair, then re-read. The repair's own answer is not the evidence —
      // this file's whole subject is tools whose answer and whose effect are
      // two different claims.
      await callTool(url, auth, 'move_task', {
        id: MOVE_FIXTURE_TASK_ID,
        newParentId: moveFixtureParentBefore,
      });
      const recheck = await callTool(url, auth, 'get_task', {
        id: MOVE_FIXTURE_TASK_ID,
        fields: ['title', 'parentId'],
      });
      moveFixtureRepaired = parentIdOf(recheck) === moveFixtureParentBefore;
    }

    // The same STATE leg for the scratch fixture. Read even when the row was
    // skipped — the REACH leg is itself a file, so the question is live either
    // way.
    const scratchPost = await callTool(url, auth, 'scratchpad_list', { status: 'all', scope: 'mine', limit: 200 });
    scratchFiledAfter = filedTaskIdOf(scratchPost, SCRATCH_FIXTURE_ENTRY_ID);
    if (scratchFiledBefore !== null && scratchFiledAfter !== scratchFiledBefore) {
      await callTool(url, auth, 'scratchpad_file', {
        id: SCRATCH_FIXTURE_ENTRY_ID,
        taskId: scratchFiledBefore,
      });
      const recheck = await callTool(url, auth, 'scratchpad_list', { status: 'all', scope: 'mine', limit: 200 });
      scratchFixtureRepaired = filedTaskIdOf(recheck, SCRATCH_FIXTURE_ENTRY_ID) === scratchFiledBefore;
    }
  }

  // The FRAME is derived from the registry, not from the run, so it is computed
  // even when the subject control voided every row — "what SHOULD be probed" is
  // a fact about this tree and does not depend on prod answering.
  //
  // A probe that was SKIPPED for want of a usable subject is not a probe: it is
  // excluded here so the row returns to the to-do list rather than counting as
  // covered on the strength of being listed.
  const frame = frameCensus(TOOLS as unknown as RegisteredTool[], probedNamesFor(skippedProbes));

  const verdict = decide({
    rows,
    subjectControlOk,
    authControlSameAsReal,
    classifierControlOk,
    scopeReaderControlOk,
    moveFixtureMoved:
      moveFixtureParentBefore !== null && moveFixtureParentAfter !== moveFixtureParentBefore,
    scratchFixtureMoved: scratchFiledBefore !== null && scratchFiledAfter !== scratchFiledBefore,
    frame,
  });
  const code = exitCodeFor(verdict);

  const deferred = DEFERRED.filter((d) => !process.env[d.envVar]);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          url,
          NOT_SHARED_TASK_ID,
          NEVER_REAL_TASK_ID,
          READABLE_SCOPE_TASK_ID,
          scopeReaderNotes,
          rows,
          deferred,
          frame,
          verdict,
        },
        null,
        2,
      ),
    );
    return code;
  }

  const glyph = { DISTINGUISHES: '🟢', CONFLATES: '🔴', VARIES: '🟠', INCOMPLETE: '🟡', INCONCLUSIVE: '⛔' }[verdict.status];
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
  {
    // Both legs on one line, printed every run including the boring one. The
    // ANSWER leg is `WRITE CTL` above; this is the STATE leg, and the two are
    // separate because for a move they can disagree.
    const moved = moveFixtureParentBefore !== null && moveFixtureParentAfter !== moveFixtureParentBefore;
    console.log(
      `  MOVE  CTL   fixture ${MOVE_FIXTURE_TASK_ID} parent ${moveFixtureParentBefore ?? 'unreadable'} → ` +
        `${moveFixtureParentAfter ?? 'unreadable'}` +
        (!subjectControlOk
          ? '   — not run (subject control failed first)'
          : moved
            ? `   ⛔ MOVED — a move_task probe landed; repair ${moveFixtureRepaired ? 'took ✅' : 'FAILED ⛔ — move it back by hand'}`
            : moveFixtureOk
              ? `   ✅ unchanged; REACH leg ${moveFixtureReachOk ? 'reached the handler' : 'did NOT'}`
              : '   ⚪ unusable — move_task NOT probed this run, and is back on the to-do list'),
    );
  }
  {
    // The scratch fixture's STATE leg, same shape and same reason as MOVE CTL.
    const moved = scratchFiledBefore !== null && scratchFiledAfter !== scratchFiledBefore;
    console.log(
      `  SCRAT CTL   fixture ${SCRATCH_FIXTURE_ENTRY_ID} filed ${scratchFiledBefore ?? 'unreadable'} → ` +
        `${scratchFiledAfter ?? 'unreadable'}` +
        (!subjectControlOk
          ? '   — not run (subject control failed first)'
          : moved
            ? `   ⛔ REFILED — a scratchpad_file probe landed; repair ${scratchFixtureRepaired ? 'took ✅' : 'FAILED ⛔ — re-file it by hand'}`
            : scratchFixtureOk
              ? `   ✅ unchanged; REACH leg ${scratchReachOk ? 'reached the handler' : 'did NOT'}`
              : '   ⚪ unusable — scratchpad_file NOT probed this run, and is back on the to-do list'),
    );
  }
  {
    // Printed at zero and at full, every run. This control's job is to notice
    // its own precondition lapsing, so a run where it is silent is exactly the
    // run where it would be useless.
    const open = adminGateReadings.filter((r) => !r.closed);
    console.log(
      `  ADMIN CTL   ${adminGateReadings.length} admin-gated tool(s) re-asked on a READABLE subject — ${open.length} now reachable` +
        (!subjectControlOk
          ? '   — not run (subject control failed first)'
          : adminGateReadings.length === 0
            ? '   — none declared'
            : open.length === 0
              ? '   ✅ still gated, so the deferral holds and the rows stay unprobed'
              : `   ⛔ ${open.map((r) => r.tool).join(', ')} — the deferral is STALE, probe these now`),
    );
  }
  {
    // Printed every run, at both values, because this control's whole job is
    // to notice its own fixture lapsing. If the fetchable url ever starts
    // 404ing it silently becomes a SECOND unfetchable url and the url dimension
    // loses all its power while still printing two rows.
    const bad = urlPreconditions.filter((p) => !p.ok);
    console.log(
      `  URL   CTL   ${urlPreconditions.length} url(s) in the attach_file_from_url dimension — ${bad.length} not as declared` +
        (!subjectControlOk
          ? '   — not run (subject control failed first)'
          : urlPreconditions.length === 0
            ? '   — not run'
            : bad.length === 0
              ? '   ✅ one resolves to a body, one cannot resolve at all'
              : `   ⚪ ${bad.map((p) => p.url).join(', ')} — attach_file_from_url NOT probed, and is back on the to-do list`),
    );
    for (const p of urlPreconditions) console.log(`              ${p.ok ? '✅' : '🔴'} ${p.url} — ${p.detail}`);
  }
  console.log('');
  if (rows.length) {
    console.log(`  tool                    not-shared subject   never-real subject   verdict`);
    for (const r of rows) {
      const multi = (r.variants?.length ?? 1) > 1;
      console.log(
        `  ${r.tool.padEnd(23)} ${(multi ? '—' : r.notShared).padEnd(20)} ${(multi ? '—' : r.neverReal).padEnd(20)} ` +
          `${r.distinguishes ? '✅ distinguishes' : r.varies ? '🟠 VARIES BY ARGUMENT' : '🔴 CONFLATES'}   ${r.note}`,
      );
      // A multi-argument row prints EVERY variant, never a summary. The summary
      // is the thing precondition 21 says cannot exist: one of these lines is
      // what a single-url probe would have published on its own.
      // A SINGLE-variant row whose reach leg was actually sent prints it too.
      // Without this the third subject is asked and its answer never appears
      // anywhere: `finalize_upload` reads `NOT_SHARED / NOT_FOUND` — the same
      // two columns as a row nobody could tell apart from "never asked" — while
      // the leg that rules that out is invisible. **An unprinted control is not
      // a control the reader has.**
      if (!multi && r.variants?.length === 1 && r.variants[0].readable !== null) {
        const v = r.variants[0];
        console.log(
          `     ✅ ${v.name.padEnd(18)} REACH leg: readable subject → ${v.readable} ` +
            `(≠ both refused answers, so the handler was reached)`,
        );
        console.log(`        ${v.why}`);
      }
      if (multi) {
        for (const v of r.variants!) {
          const glyphs = { DISTINGUISHES: '✅', CONFLATES: '🔴', UNREACHED: '⚪' } as const;
          console.log(
            `     ${glyphs[v.status]} ${v.name.padEnd(18)} not-shared ${v.notShared.padEnd(13)} never-real ${v.neverReal.padEnd(13)} ` +
              `readable ${(v.readable ?? 'NOT SENT — unsafe pairing').padEnd(26)} ${v.status}`,
          );
          console.log(`        ${v.why}`);
        }
      }
    }
    console.log('');
  }
  // The FRAME, printed on EVERY run including a clean one. This block is the
  // denominator every receipt on this card was missing for five hours, and a
  // denominator that only appears when it is bad is one nobody calibrates.
  {
    const f = frame;
    console.log(`  FRAME — the population the probed set is a subset OF, derived from the registry this run`);
    console.log(`  ${String(f.total).padStart(4)}  tool(s) registered in this tree`);
    console.log(
      `  ${String(f.atRisk.length).padStart(4)}  AT-RISK — take an id naming a SHAREABLE row (${SHAREABLE_REFERENTS.join('/')})`,
    );
    console.log(`  ${String(f.probed.length).padStart(4)}  probed by this script (incl. DEFERRED, which is named below)`);
    console.log(
      `  ${String(f.unprobed.length).padStart(4)}  ${f.unprobed.length ? '🔴' : '✅'} AT-RISK but NEVER PROBED` +
        (f.unprobed.length ? '  — full list, no cap: this is a to-do list' : '  — the frame is covered'),
    );
    for (const t of f.unprobed) {
      const row = f.rows.find((r) => r.tool === t)!;
      // The reason is printed INLINE, on the row, inside the to-do list — not
      // lifted out into a bucket of its own. An explained row that moves
      // somewhere else stops being counted by the reader even when the number
      // above still counts it.
      const gated = ADMIN_GATED.find((g) => g.tool === t);
      const reading = adminGateReadings.find((r) => r.tool === t);
      const unsafe = UNPROBEABLE.find((u) => u.tool === t);
      const skipped = skippedProbes.includes(t);
      const why = gated
        ? reading && !reading.closed
          ? '   ⛔ ADMIN-GATE OPEN — was deferred as admin-only; this caller now reaches it. PROBE IT'
          : `   ⚪ ADMIN-GATED: ${gated.reason} — still at-risk, still counted, not probeable by this caller`
        : unsafe
          ? `   ⚪ ${unsafe.kind}: ${unsafe.reason} — discharge: ${unsafe.discharge}`
          : skipped
            ? '   ⛔ SKIPPED this run — its subject was unusable, so there is no reading behind it'
            : '';
      console.log(`        ${t.padEnd(22)} ${row.idArgs.map((a) => `${a.prop}:${a.referent}`).join(' ')}${why}`);
    }
    console.log(
      `  ${String(f.noIdArg.length).padStart(4)}  take no id at all — no subject to conflate (${f.noIdArg.join(', ')})`,
    );
    console.log(
      `  ${String(f.total - f.atRisk.length - f.noIdArg.length).padStart(4)}  take an id of a NON-shareable row — ` +
        f.rows
          .filter((r) => !r.atRisk && r.idArgs.length > 0)
          .map((r) => `${r.tool}(${r.idArgs.map((a) => a.referent).join('/')})`)
          .join(', '),
    );
    // Every control printed at its value, pass or fail: a control you only see
    // when it fires is indistinguishable from one that never ran.
    const c = f.controls;
    console.log(
      `  CTL  probed⊆at-risk  ${c.probedAreAtRisk.atRisk}/${c.probedAreAtRisk.total}` +
        (c.probedAreAtRisk.ok ? '   ✅ the classifier is not deflating the denominator' : '   ⛔ a PROBED tool reads as not-at-risk'),
    );
    console.log(
      `  CTL  user-id NEG    ${c.userIdNegCtl.tool}` +
        (c.userIdNegCtl.ok ? '   ✅ correctly NOT at-risk — a user id is not a shareable row' : '   ⛔ fires — keyed on form, not referent'),
    );
    console.log(
      `  CTL  no-id   NEG    ${c.noIdNegCtl.tool}` +
        (c.noIdNegCtl.ok ? '   ✅ correctly NOT at-risk' : '   ⛔ fires'),
    );
    console.log(
      `  CTL  unclassified   ${f.unclassifiedArgs.length}` +
        (f.unclassifiedArgs.length === 0
          ? '   ✅ every id-shaped argument resolves to a referent'
          : `   ⛔ ${f.unclassifiedArgs.map((a) => `${a.tool}.${a.prop}`).join(', ')} — counted AT-RISK, frame voided`),
    );
    console.log(
      `  CTL  catch-net      ${f.catchNet.length} non-id-shaped propert(y/ies) whose DESCRIPTION mentions an id` +
        (f.catchNet.length ? `   — eyeball: ${f.catchNet.map((a) => `${a.tool}.${a.prop}`).join(', ')}` : '   ✅ none'),
    );
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
