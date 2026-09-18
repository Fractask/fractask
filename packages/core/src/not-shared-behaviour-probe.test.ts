/**
 * Tests for the `not_shared` BEHAVIOUR probe.
 *
 * Same discipline as the deploy-marker suite: the happy path is the cheap
 * half. What makes a `CONFLATES` reading believable is that the controls can
 * take it away, so most of these are ABLATIONS — knock out one control and the
 * verdict must degrade to `INCONCLUSIVE` rather than stay a finding.
 *
 * The one case this suite exists for above all others is `EMPTY_SUCCESS`. The
 * defect this card is about is not an error with the wrong wording; it is a
 * SUCCESS with the wrong meaning. A classifier that folded `[]` into "some
 * other answer" would let `list_tasks` pass, and `list_tasks` is the only tool
 * currently failing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideCaller } from '../scripts/not-shared-note-subject.mts';
import {
  classify,
  countRows,
  decide,
  DEFERRED,
  PROBES,
  PROBE_TASK_TITLE,
  PROBE_COMMENT_BODY,
  PROBE_NOTE_TITLE,
  NOT_SHARED_TASK_ID,
  NEVER_REAL_TASK_ID,
  frameCensus,
  resolveDeferredSubject,
  frameControlsOk,
  referentOf,
  isIdShaped,
  SHAREABLE_REFERENTS,
  FRAME_USER_ID_NEG_CTL,
  FRAME_NO_ID_NEG_CTL,
  ADMIN_GATED,
  ADMIN_REFUSAL,
  adminGateStillClosed,
  adminGateProbeArgs,
  PROBE_UPLOAD_FILENAME,
  UNPROBEABLE,
  partitionUnprobed,
  MOVE_FIXTURE_TASK_ID,
  MOVE_FIXTURE_PARENT_ID,
  moveFixtureUsable,
  SCRATCH_FIXTURE_ENTRY_ID,
  SCRATCH_FIXTURE_TASK_ID,
  scratchFixtureUsable,
  filedTaskIdOf,
  probesToSkip,
  probedNamesFor,
  deferredProbedNames,
  deferredArgs,
  deferredNeverRealArgs,
  noteParentOf,
  noteFixtureCleanupEligible,
  NOTE_FIXTURE_TITLE,
  NEVER_REAL_NOTE_ID,
  parentIdOf,
  variantsOf,
  variantStatus,
  rollUpVariants,
  varyingClause,
  exitCodeFor,
  afuVariants,
  afuPairingIsSafe,
  AFU_SAFE_PAIRINGS,
  AFU_UNFETCHABLE_URL,
  afuFetchableUrlFor,
  READABLE_REACH_TASK_ID,
  NEVER_PUT_ATTACHMENT_ID,
  PROBE_FINALIZE_FILENAME,
  finalizeVariants,
  PROBE_ASK_PROMPT,
  ASK_NON_GOAL_TASK_ID,
  askHumanVariants,
  variantLanded,
  gradeGuidance,
  longestCommonSubstring,
  GUIDANCE_NEEDLE,
  GUIDANCE_NEEDLE_OK,
  type Row,
  type VariantRow,
  type RegisteredTool,
} from '../scripts/not-shared-behaviour-probe.mts';
import { TOOLS } from './mcp-tools.ts';
import { NOT_SHARED_MESSAGE, NOT_SHARED_SCRATCH_MESSAGE } from './access.ts';

const row = (tool: string, notShared: Row['notShared'], neverReal: Row['neverReal']): Row => ({
  tool,
  note: '',
  // The message axis is not what these fixtures are about; stated rather than
  // defaulted, because `guidance` is REQUIRED on Row on purpose — a real row
  // construction site that forgets it must not compile.
  guidance: 'N/A',
  notShared,
  neverReal,
  distinguishes: notShared !== neverReal,
});

/** A write probe row. `landed` = the call was NOT refused, i.e. it reached the mutation. */
const writeRow = (tool: string, landed: boolean): Row => ({
  ...row(tool, 'NOT_SHARED', 'NOT_FOUND'),
  write: true,
  landed,
});

/** Prod as measured 2026-09-14 18:4xZ: scalar tools live, the collection tool not. */
function prodToday() {
  return {
    rows: [
      row('get_task', 'NOT_SHARED', 'EMPTY_SUCCESS'),
      row('list_comments', 'NOT_SHARED', 'NOT_FOUND'),
      row('attach_file', 'NOT_SHARED', 'NOT_FOUND'),
      row('list_tasks', 'EMPTY_SUCCESS', 'EMPTY_SUCCESS'),
    ],
    subjectControlOk: true,
    authControlSameAsReal: false,
    classifierControlOk: true,
  };
}

/**
 * Prod as measured 2026-09-14 20:4xZ, with the note surface probed for the
 * first time: three collection tools conflate, not one. Before this run the
 * note half was an inference from `access.ts` written into the card's text.
 */
function prodNotesToday() {
  return {
    ...prodToday(),
    rows: [
      ...prodToday().rows,
      row('list_notes', 'EMPTY_SUCCESS', 'EMPTY_SUCCESS'),
      row('search_notes', 'EMPTY_SUCCESS', 'EMPTY_SUCCESS'),
    ],
  };
}

describe('classify — what an agent actually READS', () => {
  it('reads the not_shared marker out of an error string', () => {
    assert.equal(classify(true, 'not_shared: Task X not shared — This task exists but is not shared with you.'), 'NOT_SHARED');
  });

  it('reads the not_shared marker out of a SUCCESS body — get_task returns it as data, not as an error', () => {
    assert.equal(classify(false, '{"id":"X","error":"not_shared","message":"…"}'), 'NOT_SHARED');
  });

  it('separates not_found from not_shared — the whole point of the card', () => {
    assert.equal(classify(true, 'not_found: Task X not found'), 'NOT_FOUND');
  });

  it('classifies an empty collection as EMPTY_SUCCESS, not as "some other answer"', () => {
    // `[]` is the shape that does not announce itself as a failure. If this
    // folded into OTHER_OK, list_tasks would read as distinguishing whenever
    // the never-real leg errored, and the one real defect would vanish.
    assert.equal(classify(false, '[]'), 'EMPTY_SUCCESS');
    assert.equal(classify(false, 'null'), 'EMPTY_SUCCESS');
    assert.equal(classify(false, ''), 'EMPTY_SUCCESS');
  });

  it('does not classify an ordinary success as a verdict — the classifier control', () => {
    assert.equal(classify(false, '{"id":"x","title":"a real row"}'), 'OTHER_OK');
  });

  it('keeps an unrecognised error distinct from both verdicts', () => {
    assert.equal(classify(true, 'rate_limited: slow down'), 'OTHER_ERR');
  });

  it('is not fooled by the word "shared" on its own', () => {
    assert.equal(classify(false, '{"note":"this task is shared with three people"}'), 'OTHER_OK');
  });

  it('is not fooled by a SUCCESS body that merely TALKS about not_shared — the real reading that earned this', () => {
    // Observed 2026-09-14 21:5xZ: update_task on THIS card succeeded, echoed
    // the task, and the echo classified NOT_SHARED — because the description
    // is 6 KB of prose about the token. A substring census of a marker counts
    // how often the corpus mentions the marker.
    const echo = JSON.stringify({
      id: 'Tx5g85uLq96D',
      title: 'Report not_shared as not_shared across all MCP tools, not just get_task',
      description: 'list_tasks(parentId=X) answers [] where it should answer not_shared, and not_found is worse still',
    });
    assert.equal(classify(false, echo), 'OTHER_OK');
  });

  it('still reads the two shapes prod ACTUALLY emits — verbatim wire text, not a paraphrase', () => {
    // If the tightening above also silenced these, the probe would report a
    // green world. Captured off the live endpoint the same run.
    assert.equal(
      classify(
        false,
        '{\n  "id": "TfmR7QJFqluo",\n  "error": "not_shared",\n  "message": "This task exists but is not shared with you. It is not missing — do not recreate it."\n}',
      ),
      'NOT_SHARED',
    );
    assert.equal(
      classify(true, 'not_shared: Task TfmR7QJFqluo not shared — This task exists but is not shared with you.'),
      'NOT_SHARED',
    );
    assert.equal(classify(true, 'not_found: Task zzzNoSuch9XyZ not found'), 'NOT_FOUND');
  });

  it('does not let a mid-sentence marker in an ERROR body go unread — an error IS a verdict', () => {
    // The position rule tightens the SUCCESS side only. An error body is
    // already a refusal, so the marker anywhere in it is the refusal's reason.
    assert.equal(classify(true, 'failed to load parent: not_shared'), 'NOT_SHARED');
  });
});

describe('decide — the reading', () => {
  it('reports CONFLATES and names the tool, on prod as measured today', () => {
    const v = decide(prodToday());
    assert.equal(v.status, 'CONFLATES');
    assert.deepEqual(v.conflating, ['list_tasks']);
    assert.match(v.reason, /1 of 4/);
  });

  it('reports DISTINGUISHES only when every probed tool tells the subjects apart', () => {
    const base = prodToday();
    const v = decide({ ...base, rows: base.rows.filter((r) => r.tool !== 'list_tasks') });
    assert.equal(v.status, 'DISTINGUISHES');
    assert.deepEqual(v.conflating, []);
  });

  it('a tool answering not_shared to BOTH subjects conflates too — the never-real leg is load-bearing', () => {
    // Without the second subject, a build that answered `not_shared` to every
    // id would read as a perfect pass.
    const v = decide({ ...prodToday(), rows: [row('get_task', 'NOT_SHARED', 'NOT_SHARED')] });
    assert.equal(v.status, 'CONFLATES');
    assert.deepEqual(v.conflating, ['get_task']);
  });
});

describe('decide — ablations: each control can take the finding away', () => {
  it('a subject that is not actually not-shared voids the run', () => {
    const v = decide({ ...prodToday(), subjectControlOk: false });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /did not read as not-shared/);
  });

  it('the subject control is reported FIRST — it is the one that names the cause', () => {
    // Both controls down: the reader must be sent to the subject, not to the
    // credential, because a wrong subject makes every row the wrong object.
    const v = decide({ ...prodToday(), subjectControlOk: false, authControlSameAsReal: true });
    assert.match(v.reason, /NOT_SHARED subject/);
  });

  it('a garbage bearer that reproduces the real reading voids the run', () => {
    const v = decide({ ...prodToday(), authControlSameAsReal: true });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /credential/);
  });

  it('a classifier that cannot return OTHER voids the run', () => {
    const v = decide({ ...prodToday(), classifierControlOk: false });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /classifier/);
  });

  it('no probed tool is no denominator, not a clean bill of health', () => {
    const v = decide({ ...prodToday(), rows: [] });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /no denominator/);
  });

  it('a note reader that returns nothing for a scope this caller CAN see voids the note rows', () => {
    // The whole finding on the note surface is two `[]`s. A note reader that
    // answers `[]` to everything prints exactly those two rows, so the zero
    // needs a control that fires.
    const v = decide({ ...prodNotesToday(), scopeReaderControlOk: false });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /a fact about the reader/);
  });

  it('the subject control still outranks the scope control', () => {
    const v = decide({ ...prodNotesToday(), subjectControlOk: false, scopeReaderControlOk: false });
    assert.match(v.reason, /NOT_SHARED subject/);
  });
});

describe('WRITE-SAFETY — the one control that reports what the run DID, not what it read', () => {
  it('a write probe that was not refused voids the run and names the tool', () => {
    // A refusal is an error. A write probe answering WITHOUT one got past the
    // access assert, which means the mutation happened.
    const v = decide({ ...prodToday(), rows: [...prodToday().rows, writeRow('create_task', true)] });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.deepEqual(v.landedWrites, ['create_task']);
    assert.match(v.reason, /may have\s+MUTATED|MUTATED/);
  });

  it('tells the reader what to go and look for, so the damage is findable', () => {
    const v = decide({ ...prodToday(), rows: [writeRow('create_task', true)] });
    assert.ok(v.reason.includes(PROBE_TASK_TITLE), 'the reason must carry the greppable probe title');
  });

  it('names the COMMENT marker too — a stray comment is the write nothing else would surface', () => {
    // A stray create leaves a row in a tree and a stray attach leaves a file
    // on a card. A stray comment leaves neither: it is a paragraph in someone
    // else's thread, and the body text is the only handle on it.
    const v = decide({ ...prodToday(), rows: [writeRow('post_comment', true)] });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.deepEqual(v.landedWrites, ['post_comment']);
    assert.ok(v.reason.includes(PROBE_COMMENT_BODY), 'the reason must carry the greppable comment body');
  });

  it('names the NOTE marker too, and says how to enumerate a stray note', () => {
    // The stray note is the worst case of the four: the only enumerator is
    // list_notes(scopeTaskId=…), and that is one of the three tools this card
    // reports as CONFLATING — so on a scope the caller cannot read it answers
    // [] whether the note is there or not. A reason that named the marker but
    // not that trap would send the reader to a gauge that cannot see the row.
    const v = decide({ ...prodToday(), rows: [writeRow('create_note', true)] });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.ok(v.reason.includes(PROBE_NOTE_TITLE), 'the reason must carry the greppable note title');
    assert.ok(v.reason.includes('get_note'), 'and must point at the enumerator that actually works');
  });

  it('outranks the SUBJECT control — "this run did something" beats "this run measured nothing"', () => {
    // Both down. Every other INCONCLUSIVE is a methodology note; this one is
    // an alarm, and burying it under one would report damage as a caveat.
    const v = decide({
      ...prodToday(),
      subjectControlOk: false,
      rows: [...prodToday().rows, writeRow('attach_file', true)],
    });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /WRITE probe was not refused/);
  });

  it('does NOT fire when every write probe was refused — the ordinary world', () => {
    const v = decide({
      ...prodToday(),
      rows: [...prodToday().rows, writeRow('update_task', false), writeRow('create_task', false)],
    });
    assert.equal(v.status, 'CONFLATES');
    assert.deepEqual(v.landedWrites, []);
    assert.deepEqual(v.conflating, ['list_tasks']);
  });

  it('is scoped to WRITE rows — a read row cannot trip it', () => {
    // Otherwise a read tool returning a body (which is its whole job) would
    // void every run. A control that voids unrelated rows deletes findings.
    const readLanded: Row = { ...row('list_comments', 'NOT_SHARED', 'NOT_FOUND'), landed: true };
    const v = decide({ ...prodToday(), rows: [...prodToday().rows, readLanded] });
    assert.equal(v.status, 'CONFLATES');
    assert.deepEqual(v.landedWrites, []);
  });

  it('reports landedWrites on every verdict shape, so it is printable at zero', () => {
    // A safety control only visible when it fires cannot be told apart from
    // one that was never run.
    for (const v of [decide(prodToday()), decide({ ...prodToday(), subjectControlOk: false })]) {
      assert.deepEqual(v.landedWrites, []);
    }
  });
});

describe('the scope control is valid per INVOCATION, not per command', () => {
  it('does not void a run that probed no note tool — the control is not about those rows', () => {
    // prodToday() has no note row. A dead note reader says nothing about
    // list_tasks, and voiding the run on it would let an unrelated control
    // delete a real finding.
    const v = decide({ ...prodToday(), scopeReaderControlOk: false });
    assert.equal(v.status, 'CONFLATES');
    assert.deepEqual(v.conflating, ['list_tasks']);
  });

  it('is not required at all when the caller does not pass it — older callers are unchanged', () => {
    const v = decide(prodNotesToday());
    assert.equal(v.status, 'CONFLATES');
    assert.deepEqual(v.conflating, ['list_tasks', 'list_notes', 'search_notes']);
  });
});

describe('countRows — a control that could not execute is not a control that found nothing', () => {
  const answer = (isError: boolean, text: string) => ({ httpStatus: 200, isError, text, klass: classify(isError, text) });

  it('counts the rows of a real list', () => {
    assert.equal(countRows(answer(false, '[{"id":"a"},{"id":"b"}]')), 2);
  });

  it('separates an executed-and-empty list (0) from a call that never landed (-1)', () => {
    assert.equal(countRows(answer(false, '[]')), 0);
    assert.equal(countRows(answer(true, 'not_found: no such scope')), -1);
  });

  it('refuses to read a non-list body as a row count', () => {
    assert.equal(countRows(answer(false, 'null')), -1);
    assert.equal(countRows(answer(false, 'not json at all')), -1);
  });
});

describe('the probed set', () => {
  it('covers the collection half — the defect is invisible to a scalar-only probe', () => {
    assert.ok(PROBES.some((p) => p.tool === 'list_tasks'));
  });

  it("covers this card's motivating tool", () => {
    assert.ok(PROBES.some((p) => p.tool === 'attach_file'));
  });

  it('sends update_task with an id and nothing else, so the probe cannot write', () => {
    const p = PROBES.find((x) => x.tool === 'update_task')!;
    assert.deepEqual(Object.keys(p.args('abc')), ['id']);
  });

  it('names its two subjects distinctly', () => {
    assert.notEqual(NOT_SHARED_TASK_ID, NEVER_REAL_TASK_ID);
  });

  it('covers the CREATE path the card\'s own fix brief names', () => {
    // "return the not_shared shape from attach_file, post_comment,
    // update_task, create_task(parentId=…) and friends" — create_task was the
    // one named tool that had never been a row here.
    const p = PROBES.find((x) => x.tool === 'create_task');
    assert.ok(p, 'create_task must be probed');
    assert.equal(p.args(NOT_SHARED_TASK_ID).parentId, NOT_SHARED_TASK_ID, 'the subject must be the PARENT id');
  });

  it('gives the create probe a greppable title — an anonymous stray write cannot be found', () => {
    const p = PROBES.find((x) => x.tool === 'create_task')!;
    assert.equal(p.args(NEVER_REAL_TASK_ID).title, PROBE_TASK_TITLE);
    assert.match(PROBE_TASK_TITLE, /never be created/i);
  });

  it('flags every mutating probe as a write, and no read probe as one', () => {
    // The WRITE-SAFETY control is only as wide as this flag: a write probe
    // added without it is watched by nothing.
    const writes = PROBES.filter((p) => p.write).map((p) => p.tool).sort();
    assert.deepEqual(writes, [
      // Added 2026-09-15 13:4xZ. The pin fired on this addition too — and this
      // is the row where an unflagged write probe would have cost the most:
      // every other stray artifact on this table sits in a tree until someone
      // greps for it, and this one is DELIVERED — it bumps its task to
      // status="review" and lands in a human's queue.
      'ask_human',
      'attach_file',
      // Added 2026-09-15 11:5xZ with the `variants` dimension. The pin fired on
      // this addition too — and it matters more here than on any previous row,
      // because this tool's fetchable variant is the only call on the table
      // that makes prod perform an outbound GET and buffer a body before the
      // access assert. An unflagged write probe is watched by nothing.
      'attach_file_from_url',
      'create_note',
      'create_task',
      'create_upload',
      // Added 2026-09-15 12:5xZ. The pin fired on this addition too. It is the
      // one row here whose safety does NOT come from the assert order, so the
      // flag is doing something slightly different: not "watch this, it might
      // land", but "this is the call that inserts, and the day someone gives it
      // a real attachmentId the control must already be watching."
      'finalize_upload',
      // Added 2026-09-15 03:4xZ. This pin FIRED on the addition, which is what
      // it is for: a write probe that arrives without the flag is watched by
      // nothing, and move_task is the one row on this table whose miss is a
      // DESTRUCTIVE write rather than a stray row.
      'move_task',
      'post_comment',
      // Added 2026-09-15 06:2xZ. The pin fired on this addition too.
      'scratchpad_file',
      'update_task',
    ]);
    for (const readOnly of ['get_task', 'list_comments', 'list_prompts', 'list_attachments', 'list_tasks', 'list_notes', 'search_notes']) {
      assert.ok(!PROBES.find((p) => p.tool === readOnly)!.write, `${readOnly} is a read and must not be flagged`);
    }
  });

  it("covers post_comment — the LAST tool the fix brief names, and the one the repo's own suite was already bitten by", () => {
    // The card records `focus.test.ts:404` failing with `NotFoundError: Task
    // … not found` where the cause was a bot commenting on a task it had no
    // share for. That harm is a post_comment harm, and post_comment was the
    // one named tool still unprobed a day after create_task landed.
    const p = PROBES.find((x) => x.tool === 'post_comment');
    assert.ok(p, 'post_comment must be probed');
    assert.equal(p.args(NOT_SHARED_TASK_ID).taskId, NOT_SHARED_TASK_ID, 'the subject must be the taskId');
    assert.equal(p.args(NEVER_REAL_TASK_ID).body, PROBE_COMMENT_BODY, 'and the body must be the greppable marker');
    assert.match(PROBE_COMMENT_BODY, /never be posted/i);
  });

  it('covers every tool the fix brief names by hand — the list is the card\'s, not mine', () => {
    // "return the not_shared shape … from attach_file, post_comment,
    // update_task, create_task(parentId=…) and friends." Pinned as a SET so a
    // future edit cannot quietly drop one: a named tool leaving the probe is
    // the failure this card is about, one level up.
    for (const named of ['attach_file', 'post_comment', 'update_task', 'create_task']) {
      assert.ok(PROBES.some((p) => p.tool === named), `${named} is named in the fix brief and must be probed`);
    }
  });

  it('covers the NOTE surface — the card asserted it from the code path and nothing had called it', () => {
    assert.ok(PROBES.some((p) => p.tool === 'list_notes'));
    assert.ok(PROBES.some((p) => p.tool === 'search_notes'));
  });

  it('scopes the note probes by a TASK id, which is what makes the subject pair the right kind of row', () => {
    for (const tool of ['list_notes', 'search_notes']) {
      const p = PROBES.find((x) => x.tool === tool)!;
      assert.equal(p.args(NOT_SHARED_TASK_ID).scopeTaskId, NOT_SHARED_TASK_ID);
    }
  });

  it("covers create_note — the note surface's WRITE path, which no sibling row's guarantee covers", () => {
    // `create_task` asserts on `parentId`; `create_note` asserts on
    // `scopeTaskId`. Two different arguments, two different call sites, and
    // this card exists because a single hand-written guarantee was read as
    // covering the others. Measured against prod by hand on 2026-09-14 23:4xZ
    // before this row was written: NOT_SHARED / NOT_FOUND, both refused.
    const p = PROBES.find((x) => x.tool === 'create_note');
    assert.ok(p, 'create_note must be probed');
    assert.equal(p.args(NOT_SHARED_TASK_ID).scopeTaskId, NOT_SHARED_TASK_ID, 'the subject is the SCOPE arg');
    assert.equal(p.args(NEVER_REAL_TASK_ID).title, PROBE_NOTE_TITLE, 'and the title must be the greppable marker');
    assert.ok(p.write, 'it mutates if it is not refused, so WRITE-SAFETY must watch it');
  });

  it('gives the note probe its OWN marker, distinct from the task one', () => {
    // A shared marker would make a stray note and a stray task grep alike,
    // and they live in different places with different enumerators.
    assert.notEqual(PROBE_NOTE_TITLE, PROBE_TASK_TITLE);
    assert.match(PROBE_NOTE_TITLE, /never be created/i);
  });

  it('keeps get_note OUT of the probed set — a task id is not a note id', () => {
    // Probed with the task subjects it answers `null` to both and prints a
    // CONFLATES that is an artifact of the subject. Deferred, and PRINTED.
    assert.ok(!PROBES.some((p) => p.tool === 'get_note'));
    const d = DEFERRED.find((x) => x.tool === 'get_note');
    assert.ok(d, 'get_note must be declared deferred, not silently absent');
    assert.match(d.reason, /note/);
  });

  it('gives every deferred tool a named way to discharge it', () => {
    for (const d of DEFERRED) {
      assert.ok(d.envVar.length > 0, `${d.tool} must name the env var that supplies its subject`);
    }
  });
});

/**
 * The FRAME — the population `PROBES` is a subset of.
 *
 * Added 2026-09-15 01:4xZ. For five hours this card published `N of 12` with no
 * denominator, and the probed set grew by whatever the last runner noticed. The
 * tests below are mostly about the CENSUS being a reading rather than an
 * assertion: the key must select on the KIND OF ROW an argument names (not on
 * the argument's name), an unclassified argument must land on the ALARMING
 * side, and every control must be able to take the coverage figure away.
 */
describe('the frame — what population is the probed set a subset OF', () => {
  /** A tiny registry, so the census is driven by literals and not by the real tree. */
  const fakeTools: RegisteredTool[] = [
    { name: 'get_task', inputSchemaJson: { properties: { id: {}, fields: {} } } },
    { name: 'get_user', inputSchemaJson: { properties: { id: {}, name: {} } } },
    { name: 'search_users', inputSchemaJson: { properties: { query: {} } } },
    { name: 'report_shipped', inputSchemaJson: { properties: { taskId: {}, title: {} } } },
  ];

  it('derives the denominator from the registry, not from a typed-in number', () => {
    const f = frameCensus(fakeTools, ['get_task']);
    assert.equal(f.total, 4);
    // get_task(id:task) + report_shipped(taskId:task). NOT get_user, NOT search_users.
    assert.deepEqual(f.atRisk.sort(), ['get_task', 'report_shipped']);
  });

  it('prints the term every receipt on this card was missing: at-risk AND unprobed', () => {
    const f = frameCensus(fakeTools, ['get_task']);
    assert.deepEqual(f.unprobed, ['report_shipped']);
  });

  it('keys on the KIND OF ROW, not the argument name — the reading the hand pass got wrong', () => {
    // `id` means a different kind of row on each of these. A name-only key
    // swept get_user into the at-risk set and inflated the denominator.
    assert.equal(referentOf('get_task', 'id'), 'task');
    assert.equal(referentOf('get_note', 'id'), 'note');
    assert.equal(referentOf('get_user', 'id'), 'user');
    assert.equal(referentOf('cancel_prompt', 'id'), 'prompt');
    assert.equal(referentOf('delete_comment', 'id'), 'comment');
    assert.equal(referentOf('scratchpad_dismiss', 'id'), 'scratch');
  });

  it('counts only share-scoped row kinds as at-risk — a user id cannot produce this bug', () => {
    assert.deepEqual(SHAREABLE_REFERENTS, ['task', 'note', 'scratch']);
    assert.ok(!SHAREABLE_REFERENTS.includes('user'));
  });

  it('puts an UNCLASSIFIED argument on the alarming side, never the healthy one', () => {
    // RULE 30: an aggregate that counts the defect value reads an unread row as
    // healthy. A new tool with an argument nobody has classified must be loud.
    const withNewArg: RegisteredTool[] = [
      ...fakeTools,
      { name: 'brand_new_tool', inputSchemaJson: { properties: { widgetId: {} } } },
    ];
    const f = frameCensus(withNewArg, ['get_task']);
    assert.equal(referentOf('brand_new_tool', 'widgetId'), 'UNCLASSIFIED');
    assert.ok(f.atRisk.includes('brand_new_tool'), 'an unclassified id argument must count AT-RISK');
    assert.deepEqual(f.unclassifiedArgs, [{ tool: 'brand_new_tool', prop: 'widgetId' }]);
    assert.ok(!frameControlsOk(f), 'an unclassified argument must void the frame, not be absorbed by it');
  });

  it('voids the coverage claim rather than publishing a pass over an unreadable denominator', () => {
    const f = frameCensus(
      [...fakeTools, { name: 'brand_new_tool', inputSchemaJson: { properties: { widgetId: {} } } }],
      ['get_task', 'report_shipped', 'brand_new_tool'],
    );
    const v = decide({ ...prodNotesToday(), rows: [row('get_task', 'NOT_SHARED', 'NOT_FOUND')], frame: f });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /unclassified/);
    assert.match(v.reason, /brand_new_tool\.widgetId/);
  });

  it('a tool with no id argument at all is not at-risk — it has no subject to conflate', () => {
    const f = frameCensus(fakeTools, ['get_task']);
    assert.ok(f.noIdArg.includes('search_users'));
    assert.ok(!f.atRisk.includes('search_users'));
  });

  it('names its two NEG-CTLs, and both read as NOT at-risk', () => {
    const f = frameCensus(fakeTools, ['get_task']);
    assert.equal(FRAME_USER_ID_NEG_CTL, 'get_user');
    assert.equal(FRAME_NO_ID_NEG_CTL, 'search_users');
    assert.ok(f.controls.userIdNegCtl.ok, 'a user id must not read as a shareable row');
    assert.ok(f.controls.noIdNegCtl.ok);
  });

  it('fires the probed-are-at-risk control — a PROBED tool reading as safe would deflate the denominator', () => {
    const f = frameCensus(fakeTools, ['get_task']);
    assert.ok(f.controls.probedAreAtRisk.ok);
    // And it FAILS when a probed tool is not at-risk, which is the only way the
    // fraction can silently read better than the truth.
    const bad = frameCensus(fakeTools, ['get_task', 'search_users']);
    assert.ok(!bad.controls.probedAreAtRisk.ok);
    assert.ok(!frameControlsOk(bad));
  });

  it('a frame over an empty registry is not a denominator', () => {
    const f = frameCensus([], []);
    assert.ok(!f.controls.population.ok);
    assert.ok(!frameControlsOk(f));
  });

  it('carries a catch-net for an id-shaped argument the name test would miss', () => {
    const f = frameCensus(
      [{ name: 'odd', inputSchemaJson: { properties: { parent: { description: 'Parent task id, or null' } } } }],
      [],
    );
    assert.ok(!isIdShaped('parent'));
    assert.deepEqual(f.catchNet, [{ tool: 'odd', prop: 'parent' }]);
  });
});

describe('the frame, against the REAL registry — the numbers a receipt may quote', () => {
  const real = frameCensus(TOOLS as unknown as RegisteredTool[], [
    ...PROBES.map((p) => p.tool),
    ...DEFERRED.map((d) => d.tool),
  ]);

  it('every control fires on the real tree, so its figures are readings', () => {
    assert.ok(frameControlsOk(real), 'the real-registry frame must have no unclassified argument');
    assert.equal(real.unclassifiedArgs.length, 0);
    assert.ok(real.controls.probedAreAtRisk.ok);
  });

  it('every PROBED tool is itself at-risk — 13 of 13', () => {
    assert.equal(real.controls.probedAreAtRisk.total, real.probed.length);
    assert.equal(real.controls.probedAreAtRisk.atRisk, real.probed.length);
  });

  it('the three buckets sum to the registry — no tool is dropped on the floor', () => {
    const nonShareableIds = real.rows.filter((r) => !r.atRisk && r.idArgs.length > 0).length;
    assert.equal(real.atRisk.length + real.noIdArg.length + nonShareableIds, real.total);
  });

  it('holds provision_agent at-risk — the row the 2026-09-14 hand pass missed', () => {
    // The hand-written census said 27 at-risk / 14 unprobed. Derived, it is
    // 28 / 15, and this is the extra row: `shareTaskId` is documented as
    // "Entity/task id to share with the new agent" and reaches
    // shareTaskWithUserId. A hand-listed denominator drifts; a derived one
    // cannot. Pinned so a future edit cannot quietly drop it again.
    assert.ok(real.atRisk.includes('provision_agent'));
    assert.ok(real.unprobed.includes('provision_agent'));
    assert.equal(referentOf('provision_agent', 'shareTaskId'), 'task');
  });

  it('move_task is at-risk on BEHAVIOUR and PROBED — while its DESCRIPTION stays the doc-half NEG-CTL', () => {
    // ⚠️ This assertion was inverted on 2026-09-15 03:4xZ and the inversion is
    // the point, not an accident to be smoothed over. Until this hour it read
    // `unprobed.includes('move_task')` — true because nobody had designed a
    // safe subject for a destructive tool. The row is now probed, so that
    // clause had to go, and a test edited to stay green is exactly the hazard
    // this repo's notes warn about. So what replaces it is the clause that was
    // always the load-bearing one: the two axes must not leak into each other.
    //
    // BEHAVIOUR axis — move_task takes two task ids, is at-risk, and is now
    // measured against the real subject pair.
    assert.ok(real.atRisk.includes('move_task'));
    assert.ok(real.probed.includes('move_task'));
    assert.ok(!real.unprobed.includes('move_task'));
    // ── DOC axis — the clause that used to live here is RETIRED, 2026-09-18 ──
    //
    // It read: `assert.ok(!description.includes('not_shared'), 'move_task must
    // stay undocumented — it is the doc-half NEG-CTL in tasks.test.ts')`.
    //
    // That control no longer exists. `93797d2` retired it FROM tasks.test.ts
    // the same day, for the reason it was always going to have to be retired: a
    // NEG-CTL that can only survive while a defect survives ALARMS AT ITS OWN
    // FIX. This copy outlived the original by two hours and went red the moment
    // move_task got its `not_shared` sentence — a correct, wanted repair.
    //
    // 🔑 And it was invisible to the gate built for exactly this. `DG-NEGCTL-FREE`
    // (not-shared-doc-gap.mts) screens the gap list against `tasks.test.ts` and
    // read ✅ GREEN through the edit, because its claim was about one file and
    // this pin lives in another. Same shape as the tripwire `7f9fac6` retired
    // one file over. That leg has been widened to screen every `*.test.ts` in
    // this package rather than one named file.
    //
    // What survives here is the clause that was always load-bearing and is NOT
    // keyed on the defect: the two axes must not leak into each other. A tool
    // may be probed on BEHAVIOUR without that probe deciding what it SAYS.
    const t = (TOOLS as unknown as { name: string; description?: string }[]).find((x) => x.name === 'move_task')!;
    assert.ok(t, 'move_task left the registry — this whole subtest is about a tool that no longer exists');
    assert.equal(
      typeof t.description,
      'string',
      'move_task has no description at all — the doc axis is unreadable, which is not the same as undocumented',
    );
  });
});

describe('INCOMPLETE — the status the exit contract was missing', () => {
  const clean = [row('get_task', 'NOT_SHARED', 'NOT_FOUND')];
  /**
   * Both NEG-CTL subjects are present on purpose. A registry without them
   * cannot EXECUTE those controls, and `frameControlsOk` correctly refuses to
   * call such a frame a denominator — pinned as its own test below.
   */
  const negCtls: RegisteredTool[] = [
    { name: FRAME_USER_ID_NEG_CTL, inputSchemaJson: { properties: { id: {} } } },
    { name: FRAME_NO_ID_NEG_CTL, inputSchemaJson: { properties: { query: {} } } },
  ];
  const coveredFrame = frameCensus(
    [{ name: 'get_task', inputSchemaJson: { properties: { id: {} } } }, ...negCtls],
    ['get_task'],
  );
  const gappyFrame = frameCensus(
    [
      { name: 'get_task', inputSchemaJson: { properties: { id: {} } } },
      { name: 'delete_task', inputSchemaJson: { properties: { id: {} } } },
      ...negCtls,
    ],
    ['get_task'],
  );

  it('a registry missing a NEG-CTL subject voids the frame — a control that cannot EXECUTE is not a control', () => {
    // RULE 37. The two NEG-CTLs are named tools; drop them from the registry and
    // the control is perfectly aimed at nothing. That must read as "no
    // denominator", not as a clean frame — it is how a shrinking registry would
    // quietly turn the coverage figure green.
    const noNegCtl = frameCensus([{ name: 'get_task', inputSchemaJson: { properties: { id: {} } } }], ['get_task']);
    assert.ok(!noNegCtl.controls.userIdNegCtl.ok);
    assert.ok(!noNegCtl.controls.noIdNegCtl.ok);
    assert.ok(!frameControlsOk(noNegCtl));
    assert.equal(decide({ ...prodToday(), rows: clean, frame: noNegCtl }).status, 'INCONCLUSIVE');
  });

  it('does not report a clean pass as DISTINGUISHES while at-risk tools were never asked', () => {
    const v = decide({ ...prodToday(), rows: clean, frame: gappyFrame });
    assert.equal(v.status, 'INCOMPLETE');
    assert.match(v.reason, /never asked/);
    assert.match(v.reason, /delete_task/);
  });

  it('reaches DISTINGUISHES only when the frame is actually covered', () => {
    const v = decide({ ...prodToday(), rows: clean, frame: coveredFrame });
    assert.equal(v.status, 'DISTINGUISHES');
    assert.deepEqual(v.unprobed, []);
  });

  it('lets a real defect outrank a coverage gap, and still prints both terms', () => {
    // A conflating tool is a defect; an unprobed one is a gap. The headline is
    // the defect — but the gap must not vanish from the sentence.
    const v = decide({ ...prodNotesToday(), frame: gappyFrame });
    assert.equal(v.status, 'CONFLATES');
    assert.match(v.reason, /answer the same thing/);
    assert.match(v.reason, /1 of 2 AT-RISK tool\(s\) were never asked \(delete_task\)/);
    assert.deepEqual(v.unprobed, ['delete_task']);
  });

  it('reports unprobed on every verdict shape, so it is printable at zero', () => {
    const shapes = [
      decide({ ...prodToday(), rows: clean, frame: coveredFrame }),
      decide({ ...prodToday(), rows: clean, frame: gappyFrame }),
      decide({ ...prodNotesToday(), frame: gappyFrame }),
      decide({ ...prodToday(), subjectControlOk: false, frame: gappyFrame }),
      decide({ rows: [writeRow('create_task', true)], subjectControlOk: true, authControlSameAsReal: false, classifierControlOk: true, frame: gappyFrame }),
    ];
    for (const v of shapes) assert.ok(Array.isArray(v.unprobed), `${v.status} must carry unprobed`);
  });

  it('leaves an older caller with no frame exactly as it was', () => {
    // The frame is additive. A caller that supplies no registry genuinely
    // cannot state coverage, and must not be told it has none.
    const v = decide({ ...prodToday(), rows: clean });
    assert.equal(v.status, 'DISTINGUISHES');
    assert.doesNotMatch(v.reason, /AT-RISK/);
    assert.deepEqual(v.unprobed, []);
  });

  it('a voided run still voids — the frame cannot rescue a failed subject control', () => {
    const v = decide({ ...prodToday(), subjectControlOk: false, frame: coveredFrame });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /did not read as not-shared/);
  });
});

describe('create_upload — the first row taken from the frame\'s own to-do list', () => {
  it('is probed, and probed as a WRITE', () => {
    const p = PROBES.find((x) => x.tool === 'create_upload');
    assert.ok(p, 'create_upload must be a probed row — it was #3 on the frame\'s never-probed list');
    assert.equal(p!.write, true, 'it mints a signed PUT into someone else\'s prefix; a non-refusal is a write');
  });

  it('names its subject with taskId, so the probe actually reaches the access assert', () => {
    const args = PROBES.find((x) => x.tool === 'create_upload')!.args(NOT_SHARED_TASK_ID);
    assert.equal(args.taskId, NOT_SHARED_TASK_ID);
    assert.equal(args.filename, PROBE_UPLOAD_FILENAME);
  });

  it('is NOT assumed from attach_file — both are present, and they are different rows', () => {
    // The card's recurring failure is a call site believed covered by a
    // sibling's guarantee. attach_file reaches the assert via
    // resolveAttachmentParent from addAttachment; create_upload via
    // createUploadTicket. Same surface, two paths, two rows.
    assert.ok(PROBES.some((x) => x.tool === 'attach_file'));
    assert.ok(PROBES.some((x) => x.tool === 'create_upload'));
  });

  it('the WRITE-SAFETY reason tells the reader this row leaves NOTHING to look for', () => {
    // Every other write probe's remedy is "go and find the artifact". For this
    // one that advice is false, and false remediation advice is worse than
    // none: it sends the reader to an enumerator that cannot see the damage.
    const v = decide({
      rows: [{ tool: 'create_upload', note: '', notShared: 'OTHER_OK', neverReal: 'NOT_FOUND', distinguishes: true, guidance: 'N/A', write: true, landed: true }],
      subjectControlOk: true,
      authControlSameAsReal: false,
      classifierControlOk: true,
    });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.deepEqual(v.landedWrites, ['create_upload']);
    assert.match(v.reason, /NO artifact to look for/);
    assert.match(v.reason, /credential as leaked/);
  });
});

describe('ADMIN-GATED — a control answered before it reaches the subject is not a reading', () => {
  it('holds the three adminOnly tools, and every one of them is a real registered tool', () => {
    assert.equal(ADMIN_GATED.length, 3);
    for (const g of ADMIN_GATED) {
      const t = (TOOLS as unknown as RegisteredTool[]).find((x) => x.name === g.tool);
      assert.ok(t, `${g.tool} must exist in the registry — a deferral aimed at nothing is not a deferral`);
    }
  });

  it('they stay AT-RISK and stay COUNTED — naming the reason shrinks the text, not the gate', () => {
    // RULE 36: an exclusion that moves a row out of the findings list moves it
    // out of every gate at the same time. These rows are explained, not disposed.
    const frame = frameCensus(TOOLS as unknown as RegisteredTool[], PROBES.map((p) => p.tool));
    for (const g of ADMIN_GATED) {
      assert.ok(frame.atRisk.includes(g.tool), `${g.tool} must remain in the AT-RISK denominator`);
      assert.ok(frame.unprobed.includes(g.tool), `${g.tool} must remain in the unprobed to-do list`);
    }
  });

  it('a closed gate is recognised by the refusal, not by the error alone', () => {
    assert.equal(adminGateStillClosed({ isError: true, text: `error: This action ${ADMIN_REFUSAL}.` }), true);
    // NEG-CTL: some OTHER error is not the admin gate, and must not be read as
    // one — that would let an outage keep the deferral alive forever.
    assert.equal(adminGateStillClosed({ isError: true, text: 'not_found: Task zzz not found' }), false);
    // And a success means the caller now reaches the handler: deferral stale.
    assert.equal(adminGateStillClosed({ isError: false, text: '{"ventures":[]}' }), false);
  });

  it('the control call carries the subject id and NOTHING else — safe in the world where the gate opens', () => {
    // share_task grants access; provision_agent mints a user and a token. If
    // assertAdmin ever stops answering, the zod parse must be what refuses
    // next, so these argument objects are deliberately incomplete.
    assert.deepEqual(adminGateProbeArgs('office_venture', 'X1'), { entityId: 'X1' });
    assert.deepEqual(adminGateProbeArgs('share_task', 'X1'), { taskId: 'X1' });
    assert.deepEqual(adminGateProbeArgs('provision_agent', 'X1'), { shareTaskId: 'X1' });
    for (const g of ADMIN_GATED) {
      assert.equal(Object.keys(adminGateProbeArgs(g.tool, 'X1')).length, 1, `${g.tool}: exactly one argument`);
    }
  });

  it('none of the three is ALSO in PROBES — the two lists cannot both claim a tool', () => {
    for (const g of ADMIN_GATED) {
      assert.ok(!PROBES.some((p) => p.tool === g.tool), `${g.tool} is deferred; it must not also be probed`);
      assert.ok(!DEFERRED.some((d) => d.tool === g.tool), `${g.tool} is admin-gated, not subject-deferred`);
    }
  });
});

describe('move_task — the first DESTRUCTIVE row, and why its subject sits in the OTHER slot', () => {
  const move = PROBES.find((p) => p.tool === 'move_task');

  it('is probed, and probed as a WRITE', () => {
    assert.ok(move, 'move_task must be in PROBES — it was the only one of the destructive four with a safe design');
    assert.equal(move!.write, true);
  });

  it('puts the VARYING subject in newParentId and a caller-owned row in the id slot', () => {
    // moveTask asserts `id` FIRST (src/tasks.ts:792) and `newParentId` second.
    // A never-real id in the `id` slot short-circuits on the first assert, so
    // both legs would answer not_found and the row would read CONFLATES off an
    // assert that has nothing to do with the destination. This is the whole
    // design and it is forced by the source, not chosen.
    const args = move!.args('SUBJECT') as { id: string; newParentId: string };
    assert.equal(args.newParentId, 'SUBJECT', 'the subject under test must be the DESTINATION');
    assert.equal(args.id, MOVE_FIXTURE_TASK_ID, 'the id slot must hold the caller-owned fixture');
    assert.notEqual(args.id, 'SUBJECT');
  });

  it('bounds the blast radius to a row this caller can read and put back', () => {
    // The fixture's expected parent is what the repair path restores to, and
    // what the precondition compares against. Without it a probe that landed
    // would be detected and then left where it landed.
    assert.ok(MOVE_FIXTURE_PARENT_ID.length > 0);
    assert.notEqual(MOVE_FIXTURE_TASK_ID, NOT_SHARED_TASK_ID);
    assert.notEqual(MOVE_FIXTURE_TASK_ID, NEVER_REAL_TASK_ID);
  });

  it('refuses to probe on an unusable fixture rather than publishing a row with no reading behind it', () => {
    assert.equal(moveFixtureUsable({ reachOk: true, parentId: MOVE_FIXTURE_PARENT_ID }), true);
    // REACH failed: the call never got to move_task's handler, so a verdict off
    // it would be a reading of whatever answered first (RULE 37).
    assert.equal(moveFixtureUsable({ reachOk: false, parentId: MOVE_FIXTURE_PARENT_ID }), false);
    // Fixture already somewhere else: a PREVIOUS run landed a write nobody
    // repaired. Probing over it would quietly ratify that.
    assert.equal(moveFixtureUsable({ reachOk: true, parentId: 'somewhereElse' }), false);
    assert.equal(moveFixtureUsable({ reachOk: true, parentId: null }), false);
  });

  it('reads the STATE, not just the answer — the two can disagree on a move', () => {
    // `landed` fires on a non-error reply. This leg fires on the world having
    // changed. A build that moved the row and still answered with an error is
    // reported by nothing else in this file.
    const clean = [row('get_task', 'NOT_SHARED', 'NOT_FOUND')];
    const v = decide({
      rows: clean,
      subjectControlOk: true,
      authControlSameAsReal: false,
      classifierControlOk: true,
      moveFixtureMoved: true,
    });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /NOT where it was before this run/);
    assert.match(v.reason, new RegExp(MOVE_FIXTURE_TASK_ID));
  });

  it('the state leg outranks every other control, including the answer leg', () => {
    // Ordering matters: a run that CHANGED the target must not be reported as
    // "the subject control failed", which reads as "this run measured nothing".
    const v = decide({
      rows: [row('get_task', 'NOT_SHARED', 'NOT_FOUND')],
      subjectControlOk: false,
      authControlSameAsReal: true,
      classifierControlOk: false,
      moveFixtureMoved: true,
    });
    assert.match(v.reason, /NOT where it was before this run/);
  });

  it('defaults to not-moved, so an older caller is unchanged', () => {
    const v = decide({
      rows: [row('get_task', 'NOT_SHARED', 'NOT_FOUND')],
      subjectControlOk: true,
      authControlSameAsReal: false,
      classifierControlOk: true,
    });
    assert.notEqual(v.status, 'INCONCLUSIVE');
  });

  it('parentIdOf keeps "could not read it" distinct from "read it, it is elsewhere"', () => {
    assert.equal(parentIdOf({ isError: false, text: '{"id":"a","parentId":"P1"}' }), 'P1');
    // A top-level task really has no parent — but so does an error and so does
    // an unparseable body, and only one of those three is a fact about the row.
    // Collapsing them is safe HERE only because `moveFixtureUsable` requires an
    // EQUAL match against a non-empty expected parent, so null never passes.
    assert.equal(parentIdOf({ isError: true, text: 'not_found: Task x not found' }), null);
    assert.equal(parentIdOf({ isError: false, text: 'not json' }), null);
    assert.equal(parentIdOf({ isError: false, text: '{"id":"a","parentId":null}' }), null);
    assert.equal(moveFixtureUsable({ reachOk: true, parentId: null }), false);
  });
});

describe('the destructive four were THREE reasons, not one bucket', () => {
  it('names all three remaining tools, each with a reason and a discharge', () => {
    assert.deepEqual(
      UNPROBEABLE.map((u) => u.tool).sort(),
      // `move_note` LEFT this list on 2026-09-16 — both its blockers (a
      // not-shared NOTE subject, a caller-owned note for the id slot) are
      // derived/minted per run now, and it is a DEFERRED row that CONFLATES.
      ['delete_note', 'delete_task', 'report_shipped', 'scratchpad_dismiss', 'update_note'],
    );
    for (const u of UNPROBEABLE) {
      assert.ok(u.reason.length > 0, `${u.tool} needs a reason`);
      assert.ok(u.discharge.length > 0, `${u.tool} needs a discharge — a limit with no price closes the conversation`);
    }
  });

  it('separates the DESTRUCTIVE reason from the SUBJECT reason — only one of the three is about destructiveness', () => {
    // The 02:4xZ receipt filed all four under "destructive paths". Designing
    // the fix split it: move_task is probed, delete_task is unsafe, and the two
    // note rows are blocked one step earlier, on a subject that does not exist
    // for this caller at all.
    const byTool = Object.fromEntries(UNPROBEABLE.map((u) => [u.tool, u.kind]));
    assert.equal(byTool['delete_task'], 'UNSAFE-SUBJECT');
    // `delete_note` is now the only NOTE-SUBJECT row, and it carries BOTH
    // reasons: the subject is a note AND the act has no undo. That is why it
    // did not leave with `move_note`, whose subject went in a spare slot.
    assert.equal(byTool['delete_note'], 'NOTE-SUBJECT');
    assert.ok(!UNPROBEABLE.some((u) => u.tool === 'move_task'), 'move_task is probed, not deferred');
    assert.ok(!UNPROBEABLE.some((u) => u.tool === 'move_note'), 'move_note is a DEFERRED row now, not unprobeable');
  });

  it('update_note is UNSAFE-SUBJECT for a reason about the BLAST RADIUS, not about the assert order', () => {
    // It was named "the cheapest next row" because its assert order IS the
    // move_task order. That argument is about whether the call REACHES the
    // assert; it says nothing about what an unrefused write leaves behind, and
    // the next runner's obvious move is to re-make it. So the row has to carry
    // the second question, and the measurement that answered it.
    const upd = UNPROBEABLE.find((u) => u.tool === 'update_note')!;
    assert.equal(upd.kind, 'UNSAFE-SUBJECT');
    assert.match(upd.reason, /move_task SHAPE but not its blast radius/);
    assert.match(upd.reason, /note-scope-blast-radius/, 'the reason must name the command that measured it');
    assert.ok(
      !PROBES.some((p) => p.tool === 'update_note'),
      'update_note must not be a probed row — an unrefused write orphans the fixture with no undo',
    );
  });

  it('report_shipped is a THIRD shape — the artifact is DELIVERED, not gone and not orphaned', () => {
    // The 06:2xZ receipt named it as a CANDIDATE with its open question
    // attached (precondition 18): the assert order is trivially right and
    // settles nothing; the question is where an unrefused write lands. It was
    // measured, and the answer needed a kind of its own — filing it as
    // UNSAFE-SUBjECT alongside update_note would have said "the artifact is
    // lost", and the remedy that follows from that ("give the caller a reader")
    // is the wrong remedy for a row that is sitting in a human's feed.
    const rs = UNPROBEABLE.find((u) => u.tool === 'report_shipped')!;
    assert.equal(rs.kind, 'THIRD-PARTY-ARTIFACT');
    assert.match(rs.reason, /DELIVERED/, 'the reason must say where the artifact went, not just that it is unreachable');
    assert.match(rs.reason, /report-shipped-blast-radius/, 'the reason must name the command that measured it');
    assert.ok(
      !PROBES.some((p) => p.tool === 'report_shipped'),
      'report_shipped must not be a probed row — an unrefused call posts to the human feed with no undo',
    );
    // Its discharge is NOT the same as the note rows'. Naming an env var would
    // be wrong here: no subject this caller can mint fixes it, because the gap
    // is in who OWNS the row that gets written.
    assert.match(rs.discharge, /reader scoped to the CALLER|access assert can be read directly/);
  });

  it('the kinds are all different reasons, and each is used by at least one row', () => {
    // RULE 36's shape: a bucket named for a REASON reads as disposal. Distinct
    // kinds keep the reasons from collapsing into "deferred", which is what
    // happened when all four were "destructive paths".
    const kinds = new Set(UNPROBEABLE.map((u) => u.kind));
    assert.deepEqual(
      [...kinds].sort(),
      ['COMPLEMENTARY-SUBJECT', 'NOTE-SUBJECT', 'THIRD-PARTY-ARTIFACT', 'UNSAFE-SUBJECT'],
    );
  });

  it('scratchpad_dismiss is a FOURTH shape — the subject and the refusal exclude each other', () => {
    // The 13:3xZ hand-off left it as the only unprobed tool with no reason at
    // all, and guessed it was the delete_note shape: "a share-scoped caller
    // cannot find one". Measured (`npm run scratch-subject-reachability`, 6
    // legs, 4 controls, all fired) it is NOT that shape — the enumerator
    // EXISTS and returns the row. It is gated on the same isAdmin() predicate
    // that makes the refusal unreachable, so whoever can hold the id cannot be
    // refused by it and whoever can be refused cannot hold the id.
    const sd = UNPROBEABLE.find((u) => u.tool === 'scratchpad_dismiss')!;
    assert.equal(sd.kind, 'COMPLEMENTARY-SUBJECT');
    assert.match(sd.reason, /COMPLEMENTARY populations/);
    assert.match(sd.reason, /scratch-subject-reachability/, 'the reason must name the command that measured it');
    assert.ok(
      !PROBES.some((p) => p.tool === 'scratchpad_dismiss'),
      'scratchpad_dismiss must not be a probed row — an unrefused call mutates a human idea row with no undo',
    );
    // The discharge must say the env var is only HALF of it. `delete_note`
    // already carries that lesson for the note rows; here it matters more,
    // because the subject half looks like the whole blocker and an env var is
    // the cheapest thing on the list to reach for.
    assert.match(sd.discharge, /NOT_SHARED_SCRATCH_ID/);
    assert.match(sd.discharge, /ONLY/, 'the discharge must say the subject half is not the whole price');
    assert.match(sd.discharge, /detector/);
  });

  it('the damage it describes is a MUTATION, so a marker-shaped detector cannot see it', () => {
    // Every other write row on this table leaves a row that was CREATED, and
    // WRITE-SAFETY finds it by a marker this caller wrote. dismissScratchEntry
    // creates nothing — it flips an existing row's status. A reason that did
    // not say so would invite the next runner to reach for the marker control
    // that makes the other seven write probes defensible.
    const sd = UNPROBEABLE.find((u) => u.tool === 'scratchpad_dismiss')!;
    assert.match(sd.reason, /nothing is created/i);
    assert.match(sd.reason, /flipped new→dismissed/);
    assert.match(sd.reason, /filedBy/, 'the reason must name the field that records WHO did it');
  });

  it('says out loud that WRITE-SAFETY cannot cover a delete', () => {
    // The control that makes the other write probes defensible is a DETECTOR.
    // For a delete on an unreadable subject there is nothing to detect with and
    // nothing to restore from, and a deferral that does not say so invites the
    // next runner to "just add the row like create_task".
    const del = UNPROBEABLE.find((u) => u.tool === 'delete_task')!;
    assert.match(del.reason, /WRITE-SAFETY detects, it does not prevent/);
  });

  it('they stay AT-RISK and stay COUNTED — RULE 36, the same as the admin rows', () => {
    const frame = frameCensus(TOOLS as unknown as RegisteredTool[], PROBES.map((p) => p.tool));
    for (const u of UNPROBEABLE) {
      assert.ok(frame.atRisk.includes(u.tool), `${u.tool} must remain in the AT-RISK denominator`);
      assert.ok(frame.unprobed.includes(u.tool), `${u.tool} must remain in the unprobed to-do list`);
    }
  });

  it('no tool is claimed by two lists at once', () => {
    for (const u of UNPROBEABLE) {
      assert.ok(!PROBES.some((p) => p.tool === u.tool), `${u.tool} is deferred; it must not also be probed`);
      assert.ok(!DEFERRED.some((d) => d.tool === u.tool), `${u.tool} is not discharged by an env var alone`);
      assert.ok(!ADMIN_GATED.some((g) => g.tool === u.tool), `${u.tool} is not admin-gated`);
    }
  });

  it('every one of them is a real registered tool — a deferral aimed at nothing is not a deferral', () => {
    for (const u of UNPROBEABLE) {
      assert.ok(
        (TOOLS as unknown as RegisteredTool[]).some((t) => t.name === u.tool),
        `${u.tool} must exist in the registry`,
      );
    }
  });
});

describe('a SKIPPED probe is not a probed tool — the branch an ablation found untested', () => {
  it('counts every intended probe when nothing was skipped', () => {
    const names = probedNamesFor([], DEFERRED.map((d) => d.tool));
    assert.ok(names.includes('move_task'));
    for (const d of DEFERRED) assert.ok(names.includes(d.tool), `${d.tool} was ASKED this run, so it is covered`);
  });

  it('a DEFERRED tool is NOT covered just by being listed — the second argument decides it', () => {
    // The old signature added every DEFERRED tool unconditionally, so a row
    // whose subject failed to resolve was counted as covered while its own
    // "NOT PROBED" line said the opposite. Two numbers in one headline,
    // disagreeing in the reassuring direction.
    const names = probedNamesFor([], []);
    for (const d of DEFERRED) assert.ok(!names.includes(d.tool), `${d.tool} was never asked, so it is not covered`);
    const frame = frameCensus(TOOLS as unknown as RegisteredTool[], names);
    for (const d of DEFERRED) assert.ok(frame.unprobed.includes(d.tool));
  });

  it('omitting the deferred argument UNDER-reports coverage rather than over-reporting it', () => {
    // The direction is the guarantee. A forgotten argument has to show up as a
    // row on the to-do list, which somebody chases — never as a covered row,
    // which nobody does.
    for (const d of DEFERRED) assert.ok(!probedNamesFor([]).includes(d.tool));
  });
});

describe('deferredProbedNames — asked, not listed', () => {
  const rows = [
    { tool: 'get_note', reason: 'r', envVar: 'NOT_SHARED_NOTE_ID' },
    {
      tool: 'move_note',
      reason: 'r',
      envVar: 'NOT_SHARED_NOTE_ID',
      needsFixtureNote: true,
      write: true,
      args: (s: string, f: string) => ({ id: f, newParentNoteId: s }),
    },
  ];

  it('counts a row only when its subject resolved', () => {
    assert.deepEqual(deferredProbedNames(rows, [], true), []);
    assert.deepEqual(deferredProbedNames(rows, ['get_note'], true), ['get_note']);
  });

  it('a fixture-needing row is dropped when the fixture is unusable, and the other row is not', () => {
    // The two halves fail independently: the subject derivation can succeed on
    // a run where minting the fixture does not, and vice versa.
    assert.deepEqual(deferredProbedNames(rows, ['get_note', 'move_note'], false), ['get_note']);
    assert.deepEqual(deferredProbedNames(rows, ['get_note', 'move_note'], true), ['get_note', 'move_note']);
  });

  it('a row whose REACH leg failed is not covered — a run that measured nothing is not a finding', () => {
    assert.deepEqual(deferredProbedNames(rows, ['get_note', 'move_note'], true, ['move_note']), ['get_note']);
  });

  it('a row can fail all three ways at once without reappearing', () => {
    assert.deepEqual(deferredProbedNames(rows, [], false, ['move_note', 'get_note']), []);
  });
});

describe('move_note — the note surface`s move_task, folded in from the hand probe', () => {
  const mn = DEFERRED.find((d) => d.tool === 'move_note');

  it('is a DEFERRED row, and a WRITE one', () => {
    assert.ok(mn, 'move_note must be in DEFERRED');
    assert.equal(mn!.write, true);
    assert.equal(mn!.needsFixtureNote, true);
  });

  it('NEVER puts the not-shared subject in the id slot — that is the delete_task shape', () => {
    // `id` is where the act LANDS. Putting a row the caller cannot see there
    // is the design that has no safe version; the subject belongs in the
    // parent slot, which is what made move_task probeable.
    const args = deferredArgs(mn!, 'HIDDEN', 'FIXTURE') as { id: string; newParentNoteId: string };
    assert.equal(args.id, 'FIXTURE');
    assert.equal(args.newParentNoteId, 'HIDDEN');
  });

  it('varies the SUBJECT between the two legs and holds the fixture fixed', () => {
    // If the never-real leg moved the fixture too, the two legs would differ
    // in two ways and neither answer would be about the subject.
    const a = deferredArgs(mn!, 'HIDDEN', 'FIXTURE') as Record<string, unknown>;
    const b = deferredNeverRealArgs(mn!, 'FIXTURE') as Record<string, unknown>;
    assert.equal(a.id, b.id);
    assert.notEqual(a.newParentNoteId, b.newParentNoteId);
    assert.equal(b.newParentNoteId, NEVER_REAL_NOTE_ID);
  });

  it('its REACH leg is a no-op move to root — safe, and it must SUCCEED', () => {
    const r = mn!.reachArgs!('FIXTURE') as { id: string; newParentNoteId: null };
    assert.equal(r.id, 'FIXTURE');
    assert.equal(r.newParentNoteId, null);
  });

  it('get_note keeps the plain single-id shape — the default is not disturbed', () => {
    const gn = DEFERRED.find((d) => d.tool === 'get_note')!;
    assert.deepEqual(deferredArgs(gn, 'HIDDEN', 'FIXTURE'), { id: 'HIDDEN' });
    assert.deepEqual(deferredNeverRealArgs(gn, 'FIXTURE'), { id: NEVER_REAL_NOTE_ID });
    assert.equal(gn.write, undefined);
    assert.equal(gn.needsFixtureNote, undefined);
  });

  it('update_note and delete_note did NOT come free with it', () => {
    // Same "caller-owned note in the id slot" shape, opposite blast radius:
    // update_note's subject slot IS scopeTaskId, which takes the note off the
    // owner leg and orphans it from its own repair call; delete_note has
    // neither a spare slot nor an undo.
    for (const t of ['update_note', 'delete_note']) {
      assert.ok(!DEFERRED.some((d) => d.tool === t), `${t} must not be probed on move_note's argument`);
      assert.ok(!PROBES.some((p) => p.tool === t));
    }
  });

  it('the fixture title is distinct from the must-never-exist marker', () => {
    // One marks a note that must NEVER be created; the other marks one that
    // SHOULD exist after every run. A grep that cannot tell them apart reports
    // the safe fixture as damage.
    assert.notEqual(NOTE_FIXTURE_TITLE, PROBE_NOTE_TITLE);
    assert.ok(!NOTE_FIXTURE_TITLE.includes('must never be created'));
  });
});

describe('noteParentOf — three values, because unreadable is not the same as at-root', () => {
  it('reads a parent back', async () => {
    assert.equal(await noteParentOf({ isError: false, text: '{"id":"n","parentNoteId":"P"}' }), 'P');
  });

  it('a note at root is null — the un-landed state', async () => {
    assert.equal(await noteParentOf({ isError: false, text: '{"id":"n","parentNoteId":null}' }), null);
    assert.equal(await noteParentOf({ isError: false, text: '{"id":"n"}' }), null);
  });

  it('an error, unparseable text, or a null body is UNKNOWN and never null', async () => {
    // Folding these into `null` turns a blind safety gauge into a green one:
    // "0 landed" would then be printed by a control that read nothing.
    assert.equal(await noteParentOf({ isError: true, text: 'not_shared: …' }), 'unknown');
    assert.equal(await noteParentOf({ isError: false, text: 'not json' }), 'unknown');
    assert.equal(await noteParentOf({ isError: false, text: 'null' }), 'unknown');
  });
});

describe('the per-run note fixture is removed, but never when it is evidence', () => {
  it('an un-landed fixture is deleted — it is minted hourly, so leaving it is a slow leak', () => {
    assert.equal(noteFixtureCleanupEligible(null, null), true);
  });

  it('a fixture a probe leg MOVED is kept — deleting it would erase the finding', () => {
    // delete_note takes descendants with it, and the row a WRITE-SAFETY control
    // just flagged is the one artifact a human needs to look at.
    assert.equal(noteFixtureCleanupEligible('SOME_PARENT', null), false);
    assert.equal(noteFixtureCleanupEligible('SOME_PARENT', false), false);
  });

  it('a moved-then-repaired fixture IS deletable — it is back in the certified state', () => {
    assert.equal(noteFixtureCleanupEligible('SOME_PARENT', true), true);
  });

  it('an UNREADABLE fixture is never deleted — the gauge that would justify it is blind', () => {
    // This is the case where the cleanup and the safety control disagree about
    // what they know. The control abstains, so the delete abstains too.
    assert.equal(noteFixtureCleanupEligible('unknown', null), false);
    assert.equal(noteFixtureCleanupEligible('unknown', true), false);
  });

  it('puts a skipped tool back on the to-do list instead of counting it as covered', () => {
    // PROBES is a list of INTENTIONS. A row whose subject was unusable was
    // never asked, and this is the only thing standing between that and a
    // coverage figure that counts it.
    const names = probedNamesFor(['move_task']);
    assert.ok(!names.includes('move_task'));
    const frame = frameCensus(TOOLS as unknown as RegisteredTool[], names);
    assert.ok(frame.unprobed.includes('move_task'));
    assert.ok(!frame.probed.includes('move_task'));
  });

  it('skipping one row does not disturb the others', () => {
    const names = probedNamesFor(['move_task']);
    for (const t of ['get_task', 'list_tasks', 'create_upload']) assert.ok(names.includes(t));
  });

  it('decides the skip list from the fixture preconditions, one row each', () => {
    // Extracted from `main()` deliberately: the inline version of this
    // decision was the branch ABL-7 proved untestable on 2026-09-15 03:5xZ.
    assert.deepEqual(probesToSkip({ moveFixtureOk: true, scratchFixtureOk: true }), []);
    assert.deepEqual(probesToSkip({ moveFixtureOk: false, scratchFixtureOk: true }), ['move_task']);
    assert.deepEqual(probesToSkip({ moveFixtureOk: true, scratchFixtureOk: false }), ['scratchpad_file']);
    // One bad fixture must not take the other row down with it, and two bad
    // ones must not collapse to one — the case a hard-coded name would miss.
    assert.deepEqual(probesToSkip({ moveFixtureOk: false, scratchFixtureOk: false }), [
      'move_task',
      'scratchpad_file',
    ]);
  });

  it('puts scratchpad_file back on the to-do list too — the guard is per ROW, not per tool name', () => {
    // The skip branch was written for move_task and then reused. A second row
    // relying on it is exactly where a hard-coded name would have survived
    // unnoticed, so it is asserted rather than assumed.
    const names = probedNamesFor(['scratchpad_file']);
    assert.ok(!names.includes('scratchpad_file'));
    const frame = frameCensus(TOOLS as unknown as RegisteredTool[], names);
    assert.ok(frame.unprobed.includes('scratchpad_file'));
  });
});

describe('scratchpad_file — reachability is not blast radius, and only the second one decided it', () => {
  const sf = PROBES.find((p) => p.tool === 'scratchpad_file');

  it('is probed, and probed as a WRITE', () => {
    assert.ok(sf, 'scratchpad_file must be in PROBES');
    assert.equal(sf!.write, true);
  });

  it('puts the VARYING subject in taskId and a caller-owned entry in the id slot', () => {
    // fileScratchEntry asserts `id` FIRST (loadAccessible) and `taskId` second.
    // A never-real id in the `id` slot short-circuits on the first assert, so
    // both legs would answer not_found off an assert that has nothing to do
    // with the destination — the move_task defect, on a different surface.
    const args = sf!.args('SUBJECT') as { id: string; taskId: string };
    assert.equal(args.taskId, 'SUBJECT', 'the subject under test must be the FILING TARGET');
    assert.equal(args.id, SCRATCH_FIXTURE_ENTRY_ID, 'the id slot must hold the caller-owned entry');
    assert.notEqual(args.id, 'SUBJECT');
  });

  it('is NOT in UNPROBEABLE, unlike the two rows whose assert order it shares', () => {
    // update_note has the IDENTICAL assert order and is UNSAFE-SUBJECT;
    // report_shipped's assert order is even simpler and it is UNPROBEABLE too.
    // If the order were the criterion all three would have the same verdict.
    assert.ok(!UNPROBEABLE.some((u) => u.tool === 'scratchpad_file'));
    assert.ok(UNPROBEABLE.some((u) => u.tool === 'update_note'));
    assert.ok(UNPROBEABLE.some((u) => u.tool === 'report_shipped'));
  });

  it('is NOT in UNPROBEABLE — and the reason is the access rule, not the assert order', () => {
    // update_note has the IDENTICAL assert order and is UNSAFE-SUBJECT. If the
    // order were the criterion these two would have the same verdict, so this
    // pair is what stops "it has the move_task shape" from ever again being
    // the whole argument.
    assert.ok(!UNPROBEABLE.some((u) => u.tool === 'scratchpad_file'));
    assert.ok(UNPROBEABLE.some((u) => u.tool === 'update_note'));
  });

  it('bounds the blast radius to a row this caller can read and re-file', () => {
    assert.ok(SCRATCH_FIXTURE_TASK_ID.length > 0);
    assert.notEqual(SCRATCH_FIXTURE_TASK_ID, NOT_SHARED_TASK_ID);
    assert.notEqual(SCRATCH_FIXTURE_TASK_ID, NEVER_REAL_TASK_ID);
    assert.notEqual(SCRATCH_FIXTURE_ENTRY_ID, MOVE_FIXTURE_TASK_ID);
  });

  it('refuses to probe on an unusable fixture rather than publishing a row with no reading behind it', () => {
    assert.equal(scratchFixtureUsable({ reachOk: true, filedTaskId: SCRATCH_FIXTURE_TASK_ID }), true);
    assert.equal(scratchFixtureUsable({ reachOk: false, filedTaskId: SCRATCH_FIXTURE_TASK_ID }), false);
    // Filed somewhere else = a PREVIOUS run landed a write nobody repaired.
    assert.equal(scratchFixtureUsable({ reachOk: true, filedTaskId: NOT_SHARED_TASK_ID }), false);
    assert.equal(scratchFixtureUsable({ reachOk: true, filedTaskId: null }), false);
  });

  it('reads the STATE, not just the answer', () => {
    const v = decide({
      rows: [row('get_task', 'NOT_SHARED', 'NOT_FOUND')],
      subjectControlOk: true,
      authControlSameAsReal: false,
      classifierControlOk: true,
      scratchFixtureMoved: true,
    });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /NOT filed where it was before this run/);
    assert.match(v.reason, new RegExp(SCRATCH_FIXTURE_ENTRY_ID));
  });

  it('the state leg outranks the subject and answer controls', () => {
    const v = decide({
      rows: [row('get_task', 'NOT_SHARED', 'NOT_FOUND')],
      subjectControlOk: false,
      authControlSameAsReal: true,
      classifierControlOk: false,
      scratchFixtureMoved: true,
    });
    assert.match(v.reason, /NOT filed where it was before this run/);
  });

  it('defaults to not-moved, so an older caller is unchanged', () => {
    const v = decide({
      rows: [row('get_task', 'NOT_SHARED', 'NOT_FOUND')],
      subjectControlOk: true,
      authControlSameAsReal: false,
      classifierControlOk: true,
    });
    assert.notEqual(v.status, 'INCONCLUSIVE');
  });

  it('filedTaskIdOf selects the fixture BY ID, never the first row of the list', () => {
    // There is no scalar getter for a scratch entry on the MCP surface, so the
    // enumerator is the only reader — and its first row is the NEWEST entry,
    // which on any day the caller captured an idea is not the fixture.
    const list = JSON.stringify([
      { id: 'somethingElse', filedTaskId: 'WRONG' },
      { id: SCRATCH_FIXTURE_ENTRY_ID, filedTaskId: SCRATCH_FIXTURE_TASK_ID },
    ]);
    assert.equal(filedTaskIdOf({ isError: false, text: list }, SCRATCH_FIXTURE_ENTRY_ID), SCRATCH_FIXTURE_TASK_ID);
  });

  it('keeps "could not read the list" distinct from "read it, the entry is unfiled"', () => {
    assert.equal(filedTaskIdOf({ isError: true, text: 'not_shared: …' }, SCRATCH_FIXTURE_ENTRY_ID), null);
    assert.equal(filedTaskIdOf({ isError: false, text: 'not json' }, SCRATCH_FIXTURE_ENTRY_ID), null);
    assert.equal(filedTaskIdOf({ isError: false, text: '[]' }, SCRATCH_FIXTURE_ENTRY_ID), null);
    // A `new` entry has filedTaskId null — same reading as an unreadable list,
    // and safe only because `scratchFixtureUsable` needs an EQUAL match.
    const unfiled = JSON.stringify([{ id: SCRATCH_FIXTURE_ENTRY_ID, filedTaskId: null }]);
    assert.equal(filedTaskIdOf({ isError: false, text: unfiled }, SCRATCH_FIXTURE_ENTRY_ID), null);
    assert.equal(scratchFixtureUsable({ reachOk: true, filedTaskId: null }), false);
  });
});

/* ------------------------------------------------------------------ */
/* the VARIANTS dimension — a tool whose verdict rides a second argument */
/* ------------------------------------------------------------------ */

const variantRow = (
  name: string,
  notShared: Row['notShared'],
  neverReal: Row['neverReal'],
  readable: VariantRow['readable'],
): VariantRow => ({
  name,
  why: '',
  notShared,
  neverReal,
  readable,
  status: variantStatus({ notShared, neverReal, readable }),
});

/**
 * `attach_file_from_url` on prod, measured 2026-09-15 09:4xZ and again at
 * 11:5xZ: the fetchable url gets two distinct handler verdicts, the unfetchable
 * one gets a network error from all three subjects INCLUDING a readable one.
 */
const AFU_PROD_VARIANTS: VariantRow[] = [
  variantRow('url=unfetchable', 'OTHER_ERR', 'OTHER_ERR', 'OTHER_ERR'),
  variantRow('url=fetchable', 'NOT_SHARED', 'NOT_FOUND', null),
];

function afuRow(variants: VariantRow[] = AFU_PROD_VARIANTS): Row {
  const rolled = rollUpVariants(variants);
  return {
    tool: 'attach_file_from_url',
    note: '',
    guidance: 'N/A',
    notShared: variants[0].notShared,
    neverReal: variants[0].neverReal,
    distinguishes: rolled.distinguishes,
    variants,
    varies: rolled.varies,
    unreachedVariants: rolled.unreachedVariants,
    write: true,
    landed: false,
  };
}

describe('variantsOf — the degenerate case must be byte-identical to what it replaced', () => {
  it('a probe with no variants yields exactly one, carrying its own args', () => {
    const p = PROBES.find((x) => x.tool === 'get_task')!;
    const vs = variantsOf(p, 'https://example.com/api/mcp');
    assert.equal(vs.length, 1);
    assert.deepEqual(vs[0].args(NOT_SHARED_TASK_ID), p.args(NOT_SHARED_TASK_ID));
  });

  it('and it is reachSafe:false — this change may not silently re-verdict the existing rows', () => {
    // The scope line of the unit. A reach leg on the single-argument rows would
    // add a third subject to `list_tasks` / `list_notes` / `search_notes` and
    // restate three verdicts this card has published for two days, off a leg
    // whose readable subject has not been chosen per tool. NEG-CTL for the
    // whole dimension: if this ever flips, the table changed meaning.
    for (const p of PROBES.filter((x) => !x.variants)) {
      assert.equal(variantsOf(p, 'https://example.com/api/mcp')[0].reachSafe, false, `${p.tool}`);
    }
  });

  it('every single-argument row still reads exactly as before — no reach leg, so no new status', () => {
    // POS-CTL for the paragraph above, at the level that matters: the VERDICT.
    assert.equal(variantStatus({ notShared: 'EMPTY_SUCCESS', neverReal: 'EMPTY_SUCCESS', readable: null }), 'CONFLATES');
    assert.equal(variantStatus({ notShared: 'NOT_SHARED', neverReal: 'NOT_FOUND', readable: null }), 'DISTINGUISHES');
    // …and the three collection rows this card publishes as CONFLATING still do.
    const v = decide(prodNotesToday());
    assert.equal(v.status, 'CONFLATES');
    assert.deepEqual(v.conflating, ['list_tasks', 'list_notes', 'search_notes']);
  });
});

describe('variantStatus — three identical rows is "never asked", not "conflates"', () => {
  it('UNREACHED when the READABLE subject answers the same thing as both refused ones', () => {
    // The exact output the 2026-09-15 08:5xZ hand pass published `CONFLATES`
    // from. It had no third subject, so its reading was unfalsifiable from its
    // own output — and it was wrong.
    assert.equal(variantStatus({ notShared: 'OTHER_ERR', neverReal: 'OTHER_ERR', readable: 'OTHER_ERR' }), 'UNREACHED');
  });

  it('CONFLATES when the readable subject DIFFERS — the call did reach the handler', () => {
    assert.equal(variantStatus({ notShared: 'EMPTY_SUCCESS', neverReal: 'EMPTY_SUCCESS', readable: 'OTHER_OK' }), 'CONFLATES');
  });

  it('DISTINGUISHES needs no reach leg — two different handler verdicts ARE the reach proof', () => {
    assert.equal(variantStatus({ notShared: 'NOT_SHARED', neverReal: 'NOT_FOUND', readable: null }), 'DISTINGUISHES');
  });
});

describe('rollUpVariants — the conjunction, because the comforting half must not win', () => {
  it("prod's attach_file_from_url does NOT roll up to distinguishing, though one variant does", () => {
    const rolled = rollUpVariants(AFU_PROD_VARIANTS);
    assert.equal(rolled.distinguishes, false);
    assert.equal(rolled.varies, true);
    assert.deepEqual(rolled.unreachedVariants, ['url=unfetchable']);
  });

  it('ABLATION — the fetchable-url-only probe, which is what a one-dimensional table would have printed', () => {
    // 🟢 and the defect is invisible. This is the single-url design that scores
    // the row green, reproduced so the reason the dimension exists is a test
    // rather than a paragraph.
    const rolled = rollUpVariants([variantRow('url=fetchable', 'NOT_SHARED', 'NOT_FOUND', null)]);
    assert.equal(rolled.distinguishes, true);
    assert.equal(rolled.varies, false);
  });

  it('ABLATION — the unfetchable-url-only probe: right verdict, wrong reason, and it is caught', () => {
    // The other single-url design. Without the roll-up this reads 🔴 CONFLATES
    // off three identical rows; with the reach leg it reads UNREACHED, and
    // `decide` turns that into INCONCLUSIVE rather than a finding.
    const only = [variantRow('url=unfetchable', 'OTHER_ERR', 'OTHER_ERR', 'OTHER_ERR')];
    assert.deepEqual(rollUpVariants(only).unreachedVariants, ['url=unfetchable']);
    const v = decide({ ...prodToday(), rows: [...prodToday().rows.filter((r) => r.tool !== 'list_tasks'), afuRow(only)] });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /never asked/);
  });
});

describe('decide — VARIES is its own status, and CONFLATES must not swallow it', () => {
  it("reports VARIES on prod's reading once nothing else conflates", () => {
    const base = prodToday();
    const v = decide({ ...base, rows: [...base.rows.filter((r) => r.tool !== 'list_tasks'), afuRow()] });
    assert.equal(v.status, 'VARIES');
    assert.deepEqual(v.varying, ['attach_file_from_url']);
    assert.deepEqual(v.unreached, ['attach_file_from_url[url=unfetchable]']);
  });

  it('and it is NOT lost when a real conflation outranks it — the clause rides the reason', () => {
    // CONFLATES is the higher-ranked status, so without `varyingClause` the
    // VARIES finding would be invisible on exactly the days this card has had
    // for two weeks: days when list_tasks is red.
    const v = decide({ ...prodNotesToday(), rows: [...prodNotesToday().rows, afuRow()] });
    assert.equal(v.status, 'CONFLATES');
    assert.deepEqual(v.varying, ['attach_file_from_url']);
    assert.match(v.reason, /different verdicts on different argument sets/);
    assert.match(v.reason, /never reached the handler/);
  });

  it('ABLATION — strip the clause and the CONFLATES reason stops mentioning the varying row', () => {
    // Counter-ablation for the test above: the assertion must fail for the
    // right reason, i.e. the clause is load-bearing rather than incidentally
    // matched by some other sentence.
    assert.equal(varyingClause([], []), '');
    assert.doesNotMatch(
      `1 of 5 probed tool(s) answer the same thing to both subjects${varyingClause([], [])}`,
      /different verdicts on different argument sets/,
    );
  });

  it('varying is printable at zero on every shape — a finding only visible when it fires is not a finding', () => {
    for (const v of [decide(prodToday()), decide(prodNotesToday()), decide({ ...prodToday(), subjectControlOk: false })]) {
      assert.deepEqual(v.varying, []);
      assert.deepEqual(v.unreached, []);
    }
  });

  it('VARIES exits 1, not 0 — pinned on the REAL exit map, not a copy of it', () => {
    // The map lived inline in `main()` and no test could reach it, so this
    // test would have been a re-implementation agreeing with itself. It is
    // exported now: `VARIES` landing in the 0 bucket makes the whole dimension
    // decorative, and that is invisible to a suite of pure `decide` tests.
    const base = prodToday();
    const varies = decide({ ...base, rows: [...base.rows.filter((r) => r.tool !== 'list_tasks'), afuRow()] });
    assert.equal(varies.status, 'VARIES');
    assert.equal(exitCodeFor(varies), 1);
    // The other three buckets, so the map is not stuck at 1.
    assert.equal(exitCodeFor(decide({ ...base, rows: base.rows.filter((r) => r.tool !== 'list_tasks') })), 0);
    assert.equal(exitCodeFor(decide(prodToday())), 1);
    assert.equal(exitCodeFor(decide({ ...base, subjectControlOk: false })), 2);
  });
});

describe('the url dimension — its fixtures, and the pairing it may never send', () => {
  it('readable × fetchable is absent from AFU_SAFE_PAIRINGS, and the variant table agrees with it', () => {
    // The two halves of the safety argument were written in different files and
    // could drift. This is the JOIN: `reachSafe` is exactly the pairings the
    // table permits with a readable subject. A variant marked reachSafe that
    // the pairing table forbids would send the one call that can land.
    assert.equal(afuPairingIsSafe('readable', 'fetchable'), false);
    for (const v of afuVariants('https://example.com/api/mcp')) {
      const kind = v.name === 'url=unfetchable' ? 'unfetchable' : 'fetchable';
      assert.equal(v.reachSafe, afuPairingIsSafe('readable', kind), `${v.name} reachSafe must match the pairing table`);
    }
  });

  it('every other pairing IS allowed, so the gate is not vacuous', () => {
    for (const subject of ['notShared', 'neverReal', 'neverRealNote'] as const) {
      for (const url of ['unfetchable', 'fetchable'] as const) assert.ok(afuPairingIsSafe(subject, url));
    }
    assert.ok(afuPairingIsSafe('readable', 'unfetchable'));
    assert.equal(AFU_SAFE_PAIRINGS.length, 7);
  });

  it('the reach leg is sent to a task this caller can READ, and it is not either subject', () => {
    assert.notEqual(READABLE_REACH_TASK_ID, NOT_SHARED_TASK_ID);
    assert.notEqual(READABLE_REACH_TASK_ID, NEVER_REAL_TASK_ID);
  });

  it('the unfetchable url is a reserved TLD, so no body can come back in EITHER assert order', () => {
    assert.match(AFU_UNFETCHABLE_URL, /\.invalid\//);
  });

  it("the fetchable url is derived from the endpoint's own origin, never hard-coded at a fleet property", () => {
    // An earlier hand pass pointed it at verikal.ai and put a row in that
    // site's own 404 census — a probe that makes another lane's gauge red.
    assert.equal(afuFetchableUrlFor('https://x.example.com/api/mcp'), 'https://x.example.com/zzz-not-shared-order-ctl');
  });

  it('a failed url precondition SKIPS the row rather than degrading it to one variant', () => {
    // Degrading is the worst available outcome: with only the fetchable url the
    // row scores green and the defect disappears. A row measured on half its
    // dimension is a row with no reading behind it, so it goes back on the
    // to-do list — where the frame counts it as unprobed.
    assert.deepEqual(probesToSkip({ moveFixtureOk: true, scratchFixtureOk: true, afuUrlsOk: false }), ['attach_file_from_url']);
    assert.deepEqual(probesToSkip({ moveFixtureOk: true, scratchFixtureOk: true, afuUrlsOk: true }), []);
    // Defaulted, so every existing caller is unchanged.
    assert.deepEqual(probesToSkip({ moveFixtureOk: true, scratchFixtureOk: true }), []);
    assert.ok(!probedNamesFor(['attach_file_from_url']).includes('attach_file_from_url'));
  });

  it('attach_file_from_url is on the table and carries the dimension', () => {
    const p = PROBES.find((x) => x.tool === 'attach_file_from_url');
    assert.ok(p, 'the tool the whole dimension exists for must be probed');
    assert.equal(variantsOf(p, 'https://example.com/api/mcp').length, 2);
    assert.equal(p.write, true);
  });

  it('it is AT-RISK in the frame, so probing it moves the coverage denominator', () => {
    const frame = frameCensus(TOOLS as unknown as RegisteredTool[], probedNamesFor([]));
    assert.ok(frame.atRisk.includes('attach_file_from_url'));
    assert.ok(!frame.unprobed.includes('attach_file_from_url'));
    // …and skipping it puts it straight back on the to-do list.
    const skipped = frameCensus(TOOLS as unknown as RegisteredTool[], probedNamesFor(['attach_file_from_url']));
    assert.ok(skipped.unprobed.includes('attach_file_from_url'));
  });
});

describe('finalize_upload — the call that actually INSERTS, and the first write row safe enough for a reach leg', () => {
  it('is on the table, is flagged as a write, and carries its own named variant', () => {
    const p = PROBES.find((x) => x.tool === 'finalize_upload');
    assert.ok(p, 'the second half of the upload path must be probed in its own right');
    assert.equal(p.write, true);
    // NOT the degenerate `default` variant: the name says which argument set
    // the row's verdict is a claim about (precondition 21).
    const vs = variantsOf(p, 'https://example.com/api/mcp');
    assert.equal(vs.length, 1);
    assert.equal(vs[0].name, 'object=absent');
  });

  it('is AT-RISK in the frame, so probing it moves the coverage denominator', () => {
    const frame = frameCensus(TOOLS as unknown as RegisteredTool[], probedNamesFor([]));
    assert.ok(frame.atRisk.includes('finalize_upload'));
    assert.ok(!frame.unprobed.includes('finalize_upload'));
  });

  it('joins the SECOND reach-safe write variant on the table — and the pin caught me claiming it was the first', () => {
    // ✍️ Written as *"the ONLY write row with a reach leg"*. The pin failed on
    // the spot and named the row I had forgotten:
    // `attach_file_from_url[url=unfetchable]`, reachSafe since 11:5xZ. The
    // correction is worth keeping rather than quietly editing away, because the
    // two rows are safe for the SAME reason at different layers and I had
    // filed one of them under "url dimension" instead of under "write":
    //
    //   afu[url=unfetchable]      DNS cannot resolve, so no body can arrive
    //   finalize_upload[absent]   nothing was PUT, so head() finds no object
    //
    // Neither depends on prod's assert order — which is what this file
    // measures, so a safety argument that leaned on it would be circular. Every
    // OTHER write variant is reachSafe:false precisely because it does.
    const reachSafeWrites = PROBES.filter((p) => p.write).flatMap((p) =>
      variantsOf(p, 'https://example.com/api/mcp')
        .filter((v) => v.reachSafe)
        .map((v) => `${p.tool}[${v.name}]`),
    );
    // ➕ `ask_human[unpackaged+non-goal]` joined on 2026-09-15 13:4xZ, and it is
    // safe for a THIRD reason rather than a repeat of these two: not "the
    // effect has nothing to point at", but "two independent guards refuse ahead
    // of the insert, and neither of them is the access assert." One of those
    // guards is a workspace RULE that a human can switch off at
    // /settings/rules, which is why the row carries two and not one.
    assert.deepEqual(reachSafeWrites, [
      'attach_file_from_url[url=unfetchable]',
      'finalize_upload[object=absent]',
      'ask_human[unpackaged+non-goal]',
    ]);
    // And the complement, which is the half that would rot silently: a write
    // variant that becomes reachSafe without an argument for why fails HERE.
    const unsafeWrites = PROBES.filter((p) => p.write).flatMap((p) =>
      variantsOf(p, 'https://example.com/api/mcp')
        .filter((v) => !v.reachSafe)
        .map((v) => p.tool),
    );
    assert.deepEqual(unsafeWrites.sort(), [
      'attach_file',
      'attach_file_from_url',
      'create_note',
      'create_task',
      'create_upload',
      'move_task',
      'post_comment',
      'scratchpad_file',
      'update_task',
    ]);
  });

  it('sends an attachmentId that was never PUT — the insert is unreachable in EITHER assert order', () => {
    const p = PROBES.find((x) => x.tool === 'finalize_upload')!;
    const args = p.args(NOT_SHARED_TASK_ID) as Record<string, unknown>;
    assert.equal(args.attachmentId, NEVER_PUT_ATTACHMENT_ID);
    assert.equal(args.taskId, NOT_SHARED_TASK_ID);
    // The subject is the taskId, not the attachmentId — this is the argument
    // being varied, and the row would be measuring the wrong thing otherwise.
    assert.equal((p.args(NEVER_REAL_TASK_ID) as Record<string, unknown>).attachmentId, NEVER_PUT_ATTACHMENT_ID);
  });

  it('gives the finalize probe its OWN marker, distinct from create_upload\'s', () => {
    // The two halves of the upload path leave different traces, and a shared
    // filename would make a stray row from one look like a stray row from the
    // other. `create_upload` leaves no row at all; this one would leave one.
    assert.notEqual(PROBE_FINALIZE_FILENAME, PROBE_UPLOAD_FILENAME);
    const p = PROBES.find((x) => x.tool === 'finalize_upload')!;
    assert.equal((p.args(NOT_SHARED_TASK_ID) as Record<string, unknown>).filename, PROBE_FINALIZE_FILENAME);
  });

  it('the row-level args and the variant args agree — two spellings of one call is one drift away from a lie', () => {
    const p = PROBES.find((x) => x.tool === 'finalize_upload')!;
    assert.deepEqual(finalizeVariants()[0].args(NOT_SHARED_TASK_ID), p.args(NOT_SHARED_TASK_ID));
  });
});

describe('ask_human — the only probed row whose unrefused call is DELIVERED to a human', () => {
  it('is on the table, is flagged as a write, and carries its own named variant', () => {
    const p = PROBES.find((x) => x.tool === 'ask_human');
    assert.ok(p, 'the first row taken off the unprobed list that carried no exclusion at all');
    assert.equal(p.write, true);
    const vs = variantsOf(p, 'https://example.com/api/mcp');
    assert.equal(vs.length, 1);
    // The name states the two guards, not the tool — the verdict is a claim
    // about THIS argument set. Sent with a packaged deck it is a different
    // call with a different safety argument, and that call is not made here.
    assert.equal(vs[0].name, 'unpackaged+non-goal');
  });

  it('is AT-RISK in the frame, so probing it moves the coverage denominator', () => {
    const frame = frameCensus(TOOLS as unknown as RegisteredTool[], probedNamesFor([]));
    assert.ok(frame.atRisk.includes('ask_human'));
    assert.ok(!frame.unprobed.includes('ask_human'));
    // …and skipping it puts it straight back on the to-do list, rather than
    // leaving a tool nobody asked inside the covered count.
    const skipped = frameCensus(TOOLS as unknown as RegisteredTool[], probedNamesFor(['ask_human']));
    assert.ok(skipped.unprobed.includes('ask_human'));
  });

  it('sends NEITHER half of the packaging AND a non-goal goalTaskId — two independent pre-insert refusals', () => {
    const p = PROBES.find((x) => x.tool === 'ask_human')!;
    const args = p.args(NOT_SHARED_TASK_ID) as Record<string, unknown>;
    assert.equal(args.taskId, NOT_SHARED_TASK_ID);
    // Guard 1 — the agent packaging check. All three fields absent, because
    // the error names whichever it finds missing and any one of them is enough.
    assert.equal(args.deck, undefined);
    assert.equal(args.recommendation, undefined);
    assert.equal(args.estSeconds, undefined);
    // Guard 2 — the goal-link validation. This is the one that survives a
    // workspace with `prompt_requires_deck` switched off, which is why it is
    // here at all: `isAgentRuleEnabled` reads a setting this caller does not
    // control, so a single-guard row would have had a safety argument that a
    // human could turn off from the web UI without ever seeing this file.
    assert.equal(args.goalTaskId, ASK_NON_GOAL_TASK_ID);
    // ⚠️ And the goal id must be a REAL, READABLE, non-goal task. A never-real
    // id there makes the goal leg throw `not_found` — one of the exact two
    // answers this row exists to tell apart, so the row would report a
    // conflation it had manufactured itself.
    assert.notEqual(ASK_NON_GOAL_TASK_ID, NEVER_REAL_TASK_ID);
    assert.notEqual(ASK_NON_GOAL_TASK_ID, NOT_SHARED_TASK_ID);
  });

  it('varies the SUBJECT and holds both guards fixed across the legs', () => {
    const p = PROBES.find((x) => x.tool === 'ask_human')!;
    const a = p.args(NOT_SHARED_TASK_ID) as Record<string, unknown>;
    const b = p.args(NEVER_REAL_TASK_ID) as Record<string, unknown>;
    assert.notEqual(a.taskId, b.taskId);
    assert.equal(a.goalTaskId, b.goalTaskId);
    assert.equal(a.prompt, b.prompt);
  });

  it('carries a marker distinct from every other write probe', () => {
    // A stray prompt is findable — `list_prompts` distinguishes, unlike the
    // note case — but only if the text identifies itself. Shared wording with
    // another probe would make one probe's damage read as another's.
    const p = PROBES.find((x) => x.tool === 'ask_human')!;
    assert.equal((p.args(NOT_SHARED_TASK_ID) as Record<string, unknown>).prompt, PROBE_ASK_PROMPT);
    for (const other of [PROBE_TASK_TITLE, PROBE_COMMENT_BODY, PROBE_NOTE_TITLE]) {
      assert.notEqual(PROBE_ASK_PROMPT, other);
    }
  });

  it("names its retraction path in the WRITE-SAFETY reason — a marker with no undo is half a control", () => {
    const verdict = decide({
      rows: [{ tool: 'ask_human', write: true, landed: true } as never],
      subjectOk: true,
      authOk: true,
      classOk: true,
    } as never);
    assert.equal(verdict.status, 'INCONCLUSIVE');
    assert.match(verdict.reason, /ask_human/);
    assert.match(verdict.reason, /list_prompts/);
    assert.match(verdict.reason, /cancel_prompt/);
    // The half a reader would not guess: the task has been MOVED, so undoing
    // the prompt is not the whole repair.
    assert.match(verdict.reason, /review/);
  });

  it('the row-level args and the variant args agree — two spellings of one call is one drift away from a lie', () => {
    const p = PROBES.find((x) => x.tool === 'ask_human')!;
    assert.deepEqual(askHumanVariants()[0].args(NOT_SHARED_TASK_ID), p.args(NOT_SHARED_TASK_ID));
  });
});

describe('variantLanded — the WRITE-SAFETY rule, extracted so a test can reach the code and not a copy', () => {
  const refused = { isError: true };
  const ok = { isError: false };

  it('does not fire when both refused subjects were refused and there is no reach leg', () => {
    assert.equal(variantLanded({ notShared: refused, neverReal: refused, readable: null }), false);
  });

  it('fires when the not-shared subject was NOT refused', () => {
    assert.equal(variantLanded({ notShared: ok, neverReal: refused, readable: null }), true);
  });

  it('fires when the never-real subject was NOT refused', () => {
    assert.equal(variantLanded({ notShared: refused, neverReal: ok, readable: null }), true);
  });

  it('🔑 fires when only the REACH leg succeeded — the leg the rule described and did not read', () => {
    // This is the regression. Before 2026-09-15 12:5xZ this case returned
    // false: `readable` was a `Klass` by then and its `isError` was gone. On a
    // readable subject a successful write is a REAL attachment on a real task,
    // so this is the one leg where "landed" is not hypothetical.
    assert.equal(variantLanded({ notShared: refused, neverReal: refused, readable: ok }), true);
  });

  it('a refused reach leg does not fire it — the control is keyed on success, not on presence', () => {
    assert.equal(variantLanded({ notShared: refused, neverReal: refused, readable: refused }), false);
  });
});

/**
 * ## The deferred subject — 2026-09-16
 *
 * `get_note`'s deferral was discharged by hand on 2026-09-15 23:4xZ and came
 * back CONFLATES. The very next DEFAULT run printed `3 of 18 conflate` again,
 * because the discharge lived in `NOT_SHARED_NOTE_ID` and nothing set it.
 *
 * Two properties are pinned here, and the second is the one that bites:
 *   1. with no env var the probe DERIVES its own subject, so the discharge is
 *      not a remedy behind a flag;
 *   2. a derivation that fails leaves the row UNRESOLVED — it must not fall
 *      through to "covered". The reassuring direction is the default direction
 *      for this row, which is exactly why it needs a test rather than a rule.
 */
describe('resolveDeferredSubject — a discharge that is not behind a flag', () => {
  const D = { tool: 'get_note', envVar: 'NOT_SHARED_NOTE_ID' };
  const derived = async () => ({
    status: 'DERIVED' as const,
    noteId: 'nOtE1',
    callerId: 'u1',
    scope: 'sCoPe1',
    lines: ['  POS-CTL     28 note(s) VISIBLE   ✅'],
  });

  it('derives a subject when the env var is unset — the default path probes the row', async () => {
    const o = await resolveDeferredSubject(D, {}, derived);
    assert.equal(o.resolved, true);
    assert.equal(o.subjectId, 'nOtE1');
    assert.match(o.from, /DERIVED in-process/);
  });

  it('carries the derivation\'s own controls, so the subject is auditable and not merely asserted', async () => {
    const o = await resolveDeferredSubject(D, {}, derived);
    assert.deepEqual(o.lines, ['  POS-CTL     28 note(s) VISIBLE   ✅']);
  });

  it('an env var still PINS the subject, and does not silently lose to the derivation', async () => {
    let called = false;
    const o = await resolveDeferredSubject(D, { NOT_SHARED_NOTE_ID: 'pinned9' }, async () => {
      called = true;
      return derived();
    });
    assert.equal(o.subjectId, 'pinned9');
    assert.match(o.from, /env/);
    assert.equal(called, false, 'a pinned subject must not be silently replaced by a derived one');
  });

  it('🔑 a derivation that finds NOTHING leaves the row unresolved — not quietly covered', async () => {
    const o = await resolveDeferredSubject(D, {}, async () => ({ status: 'NONE' as const, lines: [] }));
    assert.equal(o.resolved, false);
    assert.equal(o.subjectId, undefined);
    assert.match(o.detail, /no hidden note exists/);
  });

  it('🔑 an INCONCLUSIVE derivation is unresolved too, and says why — it is not the same fact as NONE', async () => {
    const o = await resolveDeferredSubject(D, {}, async () => ({
      status: 'INCONCLUSIVE' as const,
      reason: 'no workspace DB',
      lines: [],
    }));
    assert.equal(o.resolved, false);
    assert.match(o.detail, /INCONCLUSIVE — no workspace DB/);
  });

  it('every DEFERRED row names an env var, so nothing here can become underivable in silence', () => {
    for (const d of DEFERRED) assert.ok(d.envVar.length > 0, `${d.tool} has no envVar`);
  });
});

/**
 * The caller cross-check. A hand-typed id that names a DIFFERENT user than the
 * bearer token does would make the whole derivation a true statement about
 * someone else's hidden note, printed under the prober's name.
 */
describe('decideCaller — the identity the probe actually authenticates as', () => {
  it('resolves from the token when nothing is typed — the flag is not required', () => {
    assert.deepEqual(decideCaller(undefined, 'uTok', ''), { id: 'uTok', from: 'token' });
  });

  it('🔑 REFUSES when the typed id and the token disagree — it does not prefer either', () => {
    const r = decideCaller('uEnv', 'uTok', '');
    assert.equal(r.id, null);
    assert.match(r.mismatch!, /uEnv/);
    assert.match(r.mismatch!, /uTok/);
  });

  it('agreement is reported as agreement, not as a bare token read', () => {
    assert.equal(decideCaller('uSame', 'uSame', '').from, 'env+token (agree)');
  });

  it('falls back to the typed id when the token cannot be resolved at all', () => {
    assert.deepEqual(decideCaller('uEnv', null, 'boom'), { id: 'uEnv', from: 'env' });
  });

  it('with neither, it yields no identity AND carries the token error — a blank reason sends the reader nowhere', () => {
    const r = decideCaller(undefined, null, 'the bearer token resolves to no user');
    assert.equal(r.id, null);
    assert.match(r.mismatch!, /resolves to no user/);
  });
});

describe('partitionUnprobed — a flat "never asked" count misdescribes its own rows', () => {
  // The bucket's real contents on 2026-09-16: 5 with a measured UNPROBEABLE
  // reason, 3 admin-gated with the gate read CLOSED this run, 0 unexamined —
  // reported for three days as "8 never asked · this is a to-do list".
  const CTX = {
    adminGated: [{ tool: 'share_task' }, { tool: 'provision_agent' }, { tool: 'office_venture' }],
    adminReadings: [
      { tool: 'share_task', closed: true },
      { tool: 'provision_agent', closed: true },
      { tool: 'office_venture', closed: true },
    ],
    unprobeable: [
      { tool: 'delete_task' },
      { tool: 'update_note' },
      { tool: 'delete_note' },
      { tool: 'scratchpad_dismiss' },
      { tool: 'report_shipped' },
    ],
    skipped: [] as string[],
  };
  const EIGHT = [
    'delete_task',
    'update_note',
    'delete_note',
    'scratchpad_dismiss',
    'report_shipped',
    'share_task',
    'provision_agent',
    'office_venture',
  ];

  it('the real bucket has ZERO unexamined rows — the to-do reading was wrong', () => {
    const p = partitionUnprobed(EIGHT, CTX);
    assert.deepEqual(p.open, []);
    assert.equal(p.blocked.length, 5);
    assert.equal(p.unreachable.length, 3);
  });

  it('is a PARTITION — every row lands in exactly one column and none is dropped', () => {
    const p = partitionUnprobed(EIGHT, CTX);
    assert.equal(p.open.length + p.blocked.length + p.unreachable.length, EIGHT.length);
    assert.deepEqual([...p.open, ...p.blocked, ...p.unreachable].sort(), [...EIGHT].sort());
  });

  it('a tool with no reason at all is UNEXAMINED — the default is the to-do column', () => {
    const p = partitionUnprobed([...EIGHT, 'brand_new_tool'], CTX);
    assert.deepEqual(p.open, ['brand_new_tool']);
  });

  it('an admin gate measured OPEN escapes to UNEXAMINED — an expired deferral is not permanent', () => {
    const p = partitionUnprobed(EIGHT, {
      ...CTX,
      adminReadings: CTX.adminReadings.map((r) =>
        r.tool === 'share_task' ? { ...r, closed: false } : r,
      ),
    });
    assert.ok(p.open.includes('share_task'), 'an opened gate must read as PROBE IT');
    assert.ok(!p.unreachable.includes('share_task'));
    assert.equal(p.unreachable.length, 2);
  });

  it('an admin-gated tool with NO reading is UNEXAMINED, never UNREACHABLE', () => {
    // An unmeasured gate filed as permanently out of reach is the same defect
    // as counting an unprobed row as covered, one bucket over.
    const p = partitionUnprobed(EIGHT, { ...CTX, adminReadings: [] });
    assert.equal(p.unreachable.length, 0);
    assert.equal(p.open.length, 3);
  });

  it('a row SKIPPED this run is UNEXAMINED even when a constant explains it', () => {
    const p = partitionUnprobed(EIGHT, { ...CTX, skipped: ['report_shipped'] });
    assert.ok(p.open.includes('report_shipped'), 'no reading behind it this run');
    assert.equal(p.blocked.length, 4);
  });

  it('admin-gating wins over an UNPROBEABLE entry — the gate answers first', () => {
    const p = partitionUnprobed(['share_task'], {
      ...CTX,
      unprobeable: [...CTX.unprobeable, { tool: 'share_task' }],
    });
    assert.deepEqual(p.unreachable, ['share_task']);
    assert.deepEqual(p.blocked, []);
  });

  it('an empty bucket partitions to three empty columns, not to a throw', () => {
    assert.deepEqual(partitionUnprobed([], CTX), { open: [], blocked: [], unreachable: [] });
  });
});

describe("decide — the coverage clause says WHICH KIND of never-asked", () => {
  const ROWS = [
    { tool: 'get_task', distinguishes: true, write: false, landed: false, varies: false },
  ] as unknown as Row[];
  // Built with its controls PASSING, so the coverage clause is reached at all.
  // A frame whose controls failed is not a denominator and decide() says so
  // before it ever gets to coverage — which is how the first draft of these
  // four cases passed a fixture that read as a frame and was not one.
  const FRAME = {
    total: 39,
    atRisk: new Array(28).fill('x'),
    probed: [],
    unprobed: ['a', 'b'],
    rows: [],
    noIdArg: [],
    unclassifiedArgs: [],
    controls: {
      probedAreAtRisk: { ok: true, probed: 0, atRisk: 28 },
      userIdNegCtl: { ok: true },
      noIdNegCtl: { ok: true },
      population: { ok: true, total: 39 },
    },
  } as unknown as Parameters<typeof decide>[0]['frame'];
  const base = {
    rows: ROWS,
    subjectControlOk: true,
    authControlSameAsReal: false,
    classifierControlOk: true,
    frame: FRAME,
  };

  it('without a partition the clause is exactly the flat count it has always been', () => {
    assert.match(decide(base).reason ?? '', /2 of 28 AT-RISK tool\(s\) were never asked \(a, b\)/);
  });

  it('with a partition it names the UNEXAMINED column, which is the actionable one', () => {
    const r = decide({
      ...base,
      unprobedPartition: { open: [], blocked: ['a'], unreachable: ['b'] },
    }).reason ?? '';
    assert.match(r, /0 UNEXAMINED/);
    assert.match(r, /1 blocked on a named precondition/);
    assert.match(r, /1 not probeable by this caller/);
  });

  it('the unexamined tools are NAMED, so a real to-do is never just a number', () => {
    const r = decide({
      ...base,
      unprobedPartition: { open: ['a'], blocked: [], unreachable: ['b'] },
    }).reason ?? '';
    assert.match(r, /1 UNEXAMINED: a/);
  });

  it('the partition never changes the COUNT — same 8 rows, same bucket', () => {
    const flat = decide(base);
    const split = decide({
      ...base,
      unprobedPartition: { open: [], blocked: ['a'], unreachable: ['b'] },
    });
    assert.deepEqual(flat.unprobed, split.unprobed);
    assert.equal(flat.status, split.status);
  });
});

/**
 * ## The GUIDANCE column — the MESSAGE axis, added 2026-09-18
 *
 * Three objects this card keeps nearly running together: what a tool ANSWERS
 * (`klass`), what its DESCRIPTION says (`not-shared-doc-gap.mts`), and what the
 * answer's MESSAGE TEXT tells the agent to do. This column is the third, and
 * it is the surface an agent actually reads at the moment it decides whether to
 * recreate a row.
 */
describe('gradeGuidance — the message axis', () => {
  it('the needle is DERIVED from the two shipped messages, not typed', () => {
    // The point of the derivation: it cannot disagree with the product.
    assert.ok(NOT_SHARED_MESSAGE.includes(GUIDANCE_NEEDLE));
    assert.ok(NOT_SHARED_SCRATCH_MESSAGE.includes(GUIDANCE_NEEDLE));
    assert.ok(GUIDANCE_NEEDLE_OK, `derived needle is only ${GUIDANCE_NEEDLE.length} ch: ${JSON.stringify(GUIDANCE_NEEDLE)}`);
  });

  it('and it carries the instruction, not just any shared words', () => {
    // A needle that were merely the longest shared *phrase* could be something
    // like "This task exists but". Assert it is the part that TELLS YOU WHAT
    // NOT TO DO — the only part whose absence is a defect.
    assert.match(GUIDANCE_NEEDLE, /recreate/);
  });

  it('a real not_shared message CARRIES', () => {
    assert.equal(gradeGuidance('NOT_SHARED', `not_shared: Task X not shared — ${NOT_SHARED_MESSAGE}`), 'CARRIES');
  });

  it('🔑 the right CODE with a bare message is SILENT — the defect this column exists to see', () => {
    // The 2026-09-03 harm at the surface the agent reads: correct code, and a
    // message that still invites a recreate.
    assert.equal(gradeGuidance('NOT_SHARED', 'not_shared: Task X not found'), 'SILENT');
  });

  it('a non-not_shared answer is N/A, never SILENT', () => {
    // Folding these into SILENT would inflate the numerator with rows whose
    // finding is a different one — they do not answer not_shared at all.
    for (const k of ['NOT_FOUND', 'OTHER_ERR', 'EMPTY_SUCCESS', 'OTHER_OK'] as const) {
      assert.equal(gradeGuidance(k, NOT_SHARED_MESSAGE), 'N/A', k);
    }
  });

  it('N/A even when the text happens to contain the clause — the klass decides admission', () => {
    // A successful read of a card whose BODY quotes the clause (this card's own
    // description does) must not be scored on this axis at all. Same shape as
    // the 2026-09-14 21:5xZ substring-census bug one function over.
    assert.equal(gradeGuidance('OTHER_OK', `{"description":"${NOT_SHARED_MESSAGE}"}`), 'N/A');
  });

  it('longestCommonSubstring is a real LCS, not a prefix test', () => {
    assert.equal(longestCommonSubstring('xxABCDyy', 'zzABCDww'), 'ABCD');
    assert.equal(longestCommonSubstring('abc', 'xyz'), '');
    // NEG-CTL for the length floor: two strings sharing only a space must not
    // clear GUIDANCE_NEEDLE_OK's bar.
    assert.ok(longestCommonSubstring('a b', 'c d').length < 12);
  });
});
