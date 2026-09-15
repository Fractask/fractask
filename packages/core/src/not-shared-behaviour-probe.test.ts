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
  MOVE_FIXTURE_TASK_ID,
  MOVE_FIXTURE_PARENT_ID,
  moveFixtureUsable,
  SCRATCH_FIXTURE_ENTRY_ID,
  SCRATCH_FIXTURE_TASK_ID,
  scratchFixtureUsable,
  filedTaskIdOf,
  probesToSkip,
  probedNamesFor,
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
  type Row,
  type VariantRow,
  type RegisteredTool,
} from '../scripts/not-shared-behaviour-probe.mts';
import { TOOLS } from './mcp-tools.ts';

const row = (tool: string, notShared: Row['notShared'], neverReal: Row['neverReal']): Row => ({
  tool,
  note: '',
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
    // DOC axis — untouched. `tasks.test.ts` uses move_task's description as the
    // NEG-CTL proving the documentation matcher can report a tool as
    // undocumented; probing what a tool ANSWERS must never edit what it SAYS.
    const t = (TOOLS as unknown as { name: string; description?: string }[]).find((x) => x.name === 'move_task')!;
    assert.ok(
      !String(t.description ?? '').includes('not_shared'),
      'move_task must stay undocumented — it is the doc-half NEG-CTL in tasks.test.ts',
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
      rows: [{ tool: 'create_upload', note: '', notShared: 'OTHER_OK', neverReal: 'NOT_FOUND', distinguishes: true, write: true, landed: true }],
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
      ['delete_note', 'delete_task', 'move_note', 'report_shipped', 'update_note'],
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
    assert.equal(byTool['move_note'], 'NOTE-SUBJECT');
    assert.ok(!UNPROBEABLE.some((u) => u.tool === 'move_task'), 'move_task is probed, not deferred');
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

  it('the three kinds are three different reasons, and each is used by at least one row', () => {
    // RULE 36's shape: a bucket named for a REASON reads as disposal. Three
    // distinct kinds keep the reasons from collapsing into "deferred", which is
    // what happened when all four were "destructive paths".
    const kinds = new Set(UNPROBEABLE.map((u) => u.kind));
    assert.deepEqual([...kinds].sort(), ['NOTE-SUBJECT', 'THIRD-PARTY-ARTIFACT', 'UNSAFE-SUBJECT']);
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
    const names = probedNamesFor([]);
    assert.ok(names.includes('move_task'));
    for (const d of DEFERRED) assert.ok(names.includes(d.tool), `${d.tool} is named, and named is what DEFERRED means`);
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
