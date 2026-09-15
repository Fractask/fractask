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
  type Row,
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
    assert.deepEqual(writes, ['attach_file', 'create_note', 'create_task', 'post_comment', 'update_task']);
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

  it('does not count move_task as unprobed-and-safe — it is at-risk on BEHAVIOUR', () => {
    // This card's rules keep move_task UNDOCUMENTED as the doc-half NEG-CTL.
    // That is the prose axis. The frame is the behaviour axis, and on that axis
    // move_task takes two task ids and is at-risk. Nothing here touches its
    // description.
    assert.ok(real.atRisk.includes('move_task'));
    assert.ok(real.unprobed.includes('move_task'));
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
