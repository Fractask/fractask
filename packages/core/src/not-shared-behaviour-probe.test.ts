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
  NOT_SHARED_TASK_ID,
  NEVER_REAL_TASK_ID,
  type Row,
} from '../scripts/not-shared-behaviour-probe.mts';

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
    assert.deepEqual(writes, ['attach_file', 'create_task', 'update_task']);
    for (const readOnly of ['get_task', 'list_comments', 'list_prompts', 'list_attachments', 'list_tasks', 'list_notes', 'search_notes']) {
      assert.ok(!PROBES.find((p) => p.tool === readOnly)!.write, `${readOnly} is a read and must not be flagged`);
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
