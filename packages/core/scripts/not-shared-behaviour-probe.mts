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
  /**
   * `INCOMPLETE` is the status this card spent five hours unable to express:
   * every probed tool distinguishes AND at-risk tools were never asked. It maps
   * to exit 1, not 0 — coverage is a finding, and `🟢 DISTINGUISHES` over a
   * hand-picked twelfth of the surface is the comforting reading the card
   * exists to reject.
   */
  status: 'DISTINGUISHES' | 'CONFLATES' | 'INCOMPLETE' | 'INCONCLUSIVE';
  reason: string;
  conflating: string[];
  /** Write probes that were NOT refused. Non-empty means this run may have mutated prod. */
  landedWrites: string[];
  /** AT-RISK tools this run never asked. Present on every shape, so it is printable at zero. */
  unprobed: string[];
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
  /**
   * Optional and defaulted to absent so existing callers are unchanged: the
   * DERIVED population the probed set is a subset of. Supply it and the verdict
   * gains its second term; omit it and the verdict is exactly what it was —
   * which is also the honest shape, because a caller with no registry in hand
   * genuinely cannot state coverage.
   */
  frame?: Frame;
}): Verdict {
  const conflating = args.rows.filter((r) => !r.distinguishes).map((r) => r.tool);
  const landedWrites = args.rows.filter((r) => r.write && r.landed).map((r) => r.tool);
  const unprobed = args.frame?.unprobed ?? [];
  const base = { conflating, landedWrites, unprobed };

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

  if (conflating.length > 0) {
    return {
      status: 'CONFLATES',
      reason:
        `${conflating.length} of ${args.rows.length} probed tool(s) answer the same thing to both subjects` + coverage,
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
  }

  // The FRAME is derived from the registry, not from the run, so it is computed
  // even when the subject control voided every row — "what SHOULD be probed" is
  // a fact about this tree and does not depend on prod answering.
  const frame = frameCensus(TOOLS as unknown as RegisteredTool[], [
    ...PROBES.map((p) => p.tool),
    ...DEFERRED.map((d) => d.tool),
  ]);

  const verdict = decide({
    rows,
    subjectControlOk,
    authControlSameAsReal,
    classifierControlOk,
    scopeReaderControlOk,
    frame,
  });
  const code =
    verdict.status === 'DISTINGUISHES' ? 0 : verdict.status === 'CONFLATES' || verdict.status === 'INCOMPLETE' ? 1 : 2;

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

  const glyph = { DISTINGUISHES: '🟢', CONFLATES: '🔴', INCOMPLETE: '🟡', INCONCLUSIVE: '⛔' }[verdict.status];
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
      const why = gated
        ? reading && !reading.closed
          ? '   ⛔ ADMIN-GATE OPEN — was deferred as admin-only; this caller now reaches it. PROBE IT'
          : `   ⚪ ADMIN-GATED: ${gated.reason} — still at-risk, still counted, not probeable by this caller`
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
