/**
 * Tests for the not_found NOUN probe.
 *
 * The finding this script produces — *five tools tell an agent a task is
 * missing when the id was a note, a prompt, a comment or an attachment* — is
 * only believable if two things are true, and neither is visible in the
 * output itself:
 *
 *   1. the message COULD have carried the right noun (POS-CTL: scratchpad_file
 *      already does), otherwise `Task` everywhere is a platform limitation and
 *      no row is a defect;
 *   2. the matcher is reading the noun and not something else (NEG-CTL: a tool
 *      whose id genuinely is a task must read `Task`).
 *
 * So most cases below are ABLATIONS: knock out a control and the verdict must
 * stop being `WRONG-NOUN` and become `INCONCLUSIVE`. A suite that only drove
 * the happy path would stay green over a script whose controls were decorative
 * — which is the failure this repo has now recorded three times.
 *
 * The other half of the suite is about `UNMEASURED`, because that is where a
 * false OK comes from: the probe has two ways to miss its subject (a schema
 * rejection and a call that simply succeeds) and both return something that
 * is not an error message. Folding either into OK would report a tool as
 * clean that was never read.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, decide, PROBES, NEVER_REAL, type Probe, type Reading } from '../scripts/notfound-noun-probe.mts';

const probeFor = (tool: string): Probe => {
  const p = PROBES.find((x) => x.tool === tool);
  assert.ok(p, `no probe row for ${tool}`);
  return p;
};

/** The reading set prod actually produced on 2026-09-16, as a fixture. */
function prodShape(): Reading[] {
  return [
    ...['list_comments', 'list_attachments', 'list_prompts', 'delete_task', 'report_shipped'].map((t) =>
      classify(probeFor(t), `not_found: Task ${NEVER_REAL} not found`),
    ),
    ...['update_note', 'delete_note', 'cancel_prompt', 'delete_comment', 'delete_attachment'].map((t) =>
      classify(probeFor(t), `not_found: Task ${NEVER_REAL} not found`),
    ),
    classify(probeFor('scratchpad_file'), `error: Scratch entry ${NEVER_REAL} not found`),
  ];
}

describe('classify — one reading at a time', () => {
  it('a note id described as a task is WRONG-NOUN', () => {
    const r = classify(probeFor('update_note'), `not_found: Task ${NEVER_REAL} not found`);
    assert.equal(r.verdict, 'WRONG-NOUN');
    assert.match(r.why, /goes looking for a task that never existed/);
  });

  it('a task id described as a task is OK — the NEG-CTL side', () => {
    assert.equal(classify(probeFor('delete_task'), `not_found: Task ${NEVER_REAL} not found`).verdict, 'OK');
  });

  it('the POS-CTL row reads its own noun', () => {
    assert.equal(classify(probeFor('scratchpad_file'), `error: Scratch entry ${NEVER_REAL} not found`).verdict, 'OK');
  });

  it('a note id described as a NOTE is OK — this is the shape a fix produces', () => {
    assert.equal(classify(probeFor('update_note'), `not_found: Note ${NEVER_REAL} not found`).verdict, 'OK');
  });

  // The two ways the probe misses its subject. Both return something; neither
  // is evidence about nouns.
  it('a schema rejection is UNMEASURED, never OK — the probe never reached the row', () => {
    const r = classify(probeFor('cancel_prompt'), 'error: [ { "code": "invalid_type", "path": ["id"] } ]');
    assert.equal(r.verdict, 'UNMEASURED');
    assert.match(r.why, /never reached the row/);
  });

  it('a call that did not error at all is UNMEASURED, never OK', () => {
    assert.equal(classify(probeFor('update_note'), null).verdict, 'UNMEASURED');
  });

  it('the prefix is stripped before matching, so `not_found:` cannot hide the noun', () => {
    assert.equal(classify(probeFor('delete_note'), `not_found: Note ${NEVER_REAL} not found`).verdict, 'OK');
  });

  it('the noun is matched at the START — a message merely MENTIONING a note is not a fix', () => {
    const r = classify(probeFor('delete_note'), `not_found: Task ${NEVER_REAL} not found (it may be a note)`);
    assert.equal(r.verdict, 'WRONG-NOUN');
  });
});

describe('decide — the census verdict, and the controls it rests on', () => {
  it("prod's shape today is WRONG-NOUN over exactly five tools", () => {
    const v = decide(prodShape(), false);
    assert.equal(v.status, 'WRONG-NOUN');
    for (const t of ['update_note', 'delete_note', 'cancel_prompt', 'delete_comment', 'delete_attachment']) {
      assert.match(v.reason, new RegExp(t));
    }
  });

  it('ABLATION — a dead POS-CTL makes the whole reading INCONCLUSIVE, not a finding', () => {
    // If scratchpad_file also said "Task", then "Task" everywhere is equally
    // explained by the platform having one noun, and no row is a defect.
    const rs = prodShape().map((r) =>
      r.referent === 'scratch' ? classify(probeFor('scratchpad_file'), `not_found: Task ${NEVER_REAL} not found`) : r,
    );
    const v = decide(rs, false);
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /platform having one noun/);
  });

  it('ABLATION — a NEG-CTL that stops reading "Task" means the matcher is on the wrong field', () => {
    const rs = prodShape().map((r) =>
      r.tool === 'delete_task' ? classify(probeFor('delete_task'), `not_found: Widget ${NEVER_REAL} not found`) : r,
    );
    assert.equal(decide(rs, false).status, 'INCONCLUSIVE');
  });

  it('ABLATION — an auth control indistinguishable from the real call voids the run', () => {
    const v = decide(prodShape(), true);
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /measured the credential/);
  });

  it('an empty census is INCONCLUSIVE — no rows is not a clean run', () => {
    assert.equal(decide([], false).status, 'INCONCLUSIVE');
  });

  it('CLEAN is reachable — the verdict is not hardwired to red', () => {
    const fixed = prodShape().map((r) => {
      if (r.referent === 'task' || r.referent === 'scratch') return r;
      const noun = r.referent[0].toUpperCase() + r.referent.slice(1);
      return classify(probeFor(r.tool), `not_found: ${noun} ${NEVER_REAL} not found`);
    });
    assert.equal(decide(fixed, false).status, 'CLEAN');
  });

  it('UNMEASURED rows do not become OK — a census of misses is not a clean census', () => {
    const rs = prodShape().map((r) => (r.referent === 'note' ? classify(probeFor(r.tool), null) : r));
    const v = decide(rs, false);
    // Still red on the three that WERE read; the two unread rows are simply
    // not in the numerator, and they are not in the OK column either.
    assert.equal(v.status, 'WRONG-NOUN');
    assert.equal(rs.filter((r) => r.verdict === 'OK').length, 6);
    assert.equal(rs.filter((r) => r.verdict === 'UNMEASURED').length, 2);
  });
});

describe('the probe list itself', () => {
  it('every row is keyed on the REFERENT, not the argument name', () => {
    // `id` names a task on delete_task, a note on delete_note and a prompt on
    // cancel_prompt. A census keyed on the argument name would call all three
    // the same row — the mistake this card already made once, on get_user.
    const byId = PROBES.filter((p) => 'id' in p.args);
    assert.ok(new Set(byId.map((p) => p.referent)).size >= 3, 'the `id` rows must span several referents');
  });

  it('carries both controls', () => {
    assert.ok(PROBES.some((p) => p.referent === 'scratch'), 'POS-CTL row missing — the census would prove nothing');
    assert.ok(PROBES.some((p) => p.referent === 'task'), 'NEG-CTL row missing');
  });

  it('every probe sends the never-real id, so nothing real can be touched', () => {
    for (const p of PROBES) {
      const ids = Object.values(p.args).filter((v) => typeof v === 'string');
      assert.ok(ids.includes(NEVER_REAL), `${p.tool} does not send the never-real id`);
    }
  });

  it('WRITE-SAFETY — the destructive rows are only safe BECAUSE the id is never-real', () => {
    // delete_task / delete_note / delete_comment / delete_attachment are real
    // deletes. They are in the census because a never-real id cannot match a
    // row; if a future edit ever points one of them at a real id, this test is
    // the thing that should stop it.
    const destructive = PROBES.filter((p) => /^delete_/.test(p.tool));
    assert.ok(destructive.length >= 4);
    for (const p of destructive) assert.deepEqual(Object.values(p.args), [NEVER_REAL]);
  });
});
