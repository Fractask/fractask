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
  decide,
  PROBES,
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
});
