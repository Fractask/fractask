/**
 * Tests for the `not_shared` deploy marker.
 *
 * The point of the script is that a NOT-DEPLOYED reading is only believable
 * when three controls held, so the cases below are mostly ABLATIONS: knock out
 * one control and the verdict must stop being `NOT_DEPLOYED` and become
 * `INCONCLUSIVE`. A suite that only checked the happy path would stay green
 * over a script whose controls were decorative.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  censusSide,
  decide,
  MARKER,
  MATCHER_NEG_CTL,
  type ListedTool,
  type Side,
} from '../scripts/not-shared-deploy-marker.mts';
import { TOOLS } from './mcp-tools.ts';

const doc = (name: string): ListedTool => ({ name, description: `… returns ${MARKER} …` });
const undoc = (name: string): ListedTool => ({ name, description: 'plain description' });

/** prod missing one documented tool — the shape a real pending deploy has. */
function pendingDeploy() {
  const localTools = [doc('get_task'), doc('list_tasks'), undoc('move_task')];
  const prodTools = [doc('get_task'), undoc('list_tasks'), undoc('move_task')];
  return {
    local: censusSide(localTools),
    prod: censusSide(prodTools),
    localNames: localTools.map((t) => t.name),
    prodNames: prodTools.map((t) => t.name),
    authControlSameAsReal: false,
    matcherControlHits: 0,
  };
}

describe('censusSide — the count itself', () => {
  it('counts only descriptions carrying the marker', () => {
    const side = censusSide([doc('a'), undoc('b'), doc('c')]);
    assert.equal(side.total, 3);
    assert.deepEqual(side.documented, ['a', 'c']);
  });

  it('a missing description is not a match', () => {
    assert.deepEqual(censusSide([{ name: 'a' }]).documented, []);
  });

  // NEG-CTL for the census itself: the matcher must be able to return zero.
  it('the matcher can return zero', () => {
    assert.deepEqual(censusSide([undoc('a'), undoc('b')]).documented, []);
  });

  it('an empty tool list is total 0, not a small census', () => {
    assert.equal(censusSide([]).total, 0);
  });
});

describe('decide — the verdict, and every control that can void it', () => {
  it('a pending deploy reads NOT_DEPLOYED and names what is missing', () => {
    const v = decide(pendingDeploy());
    assert.equal(v.status, 'NOT_DEPLOYED');
    assert.deepEqual(v.missing, ['list_tasks']);
  });

  it('prod documenting everything local does reads DEPLOYED', () => {
    const tools = [doc('get_task'), doc('list_tasks')];
    const side = censusSide(tools);
    const names = tools.map((t) => t.name);
    const v = decide({
      local: side,
      prod: side,
      localNames: names,
      prodNames: names,
      authControlSameAsReal: false,
      matcherControlHits: 0,
    });
    assert.equal(v.status, 'DEPLOYED');
    assert.deepEqual(v.missing, []);
  });

  // ── ablations: each one alone must void an otherwise-red reading ──────────

  it('ABLATION · a zero-tool prod is INCONCLUSIVE, never NOT_DEPLOYED', () => {
    const base = pendingDeploy();
    const v = decide({ ...base, prod: { total: 0, documented: [] } as Side, prodNames: [] });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /no denominator/);
  });

  it('ABLATION · a real call indistinguishable from the garbage bearer is INCONCLUSIVE', () => {
    const v = decide({ ...pendingDeploy(), authControlSameAsReal: true });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /credential/);
  });

  it('ABLATION · a matcher control that matches anything is INCONCLUSIVE', () => {
    const v = decide({ ...pendingDeploy(), matcherControlHits: 1 });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /prove nothing/);
  });

  it('ABLATION · a tree documenting nothing has no target, so it cannot report red', () => {
    const base = pendingDeploy();
    const v = decide({ ...base, local: { total: 3, documented: [] } });
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.match(v.reason, /nothing for a deploy to carry/);
  });

  // The three ablations above are only meaningful if the UN-ablated input is
  // red. Asserted here rather than trusted, so a change that makes the base
  // case green silently turns every ablation into a tautology.
  it('the ablation baseline really is red', () => {
    assert.equal(decide(pendingDeploy()).status, 'NOT_DEPLOYED');
  });

  it('a tool prod carries and this tree does not is surfaced, not silently dropped', () => {
    const base = pendingDeploy();
    const v = decide({ ...base, prodNames: [...base.prodNames, 'ghost_tool'] });
    assert.deepEqual(v.onlyProd, ['ghost_tool']);
  });

  it('the tool-count gap is reported as a set, not as a difference', () => {
    const v = decide(pendingDeploy());
    // Same length on both sides here, and onlyLocal/onlyProd both empty — a
    // bare `39 vs 32` cannot distinguish this from seven renames.
    assert.deepEqual(v.onlyLocal, []);
    assert.deepEqual(v.onlyProd, []);
  });
});

describe('the marker against the REAL tool table — no network', () => {
  const local = censusSide(TOOLS as unknown as ListedTool[]);

  it('this tree documents the marker on at least one tool', () => {
    assert.ok(
      local.documented.length > 0,
      'no tool in this tree documents not_shared — the deploy marker has no target',
    );
  });

  it('the target is DERIVED from TOOLS, never a remembered figure', () => {
    // The regression this whole file exists for: `2 of 32` was typed into an
    // hourly receipt and carried for a day after it stopped being true. The
    // only defence is that no expected value is written down anywhere — so
    // this asserts the relationship, not the number.
    assert.equal(local.total, TOOLS.length);
    assert.ok(local.documented.every((n) => TOOLS.some((t) => t.name === n)));
  });

  it('NEG-CTL · no real description contains the matcher control string', () => {
    assert.equal(
      (TOOLS as unknown as ListedTool[]).filter((t) => (t.description ?? '').includes(MATCHER_NEG_CTL))
        .length,
      0,
    );
  });
});

/**
 * The headline rises when THIS TREE does the work.
 *
 * `missing` is `local.documented \ prod.documented`, and prod is frozen
 * between deploys — so writing the 13 descriptions `not-shared-doc-gap` is
 * asking for, a correct and wanted repair, makes the number this report leads
 * with go UP with nothing on prod changed. These legs pin the framing that
 * keeps that readable: the gate must not move, the number must never be
 * printed without its denominator, and there must exist one channel whose
 * growth really is bad news about prod.
 */
describe('framing — a number that grows when somebody does the work', () => {
  /** Same prod build, two local trees: one documents 2 tools, one documents 5. */
  function twoLocalTrees() {
    const names = ['get_task', 'list_tasks', 'move_task', 'post_comment', 'update_task'];
    const prodTools = [doc('get_task'), ...names.slice(1).map(undoc)];
    const before = [doc('get_task'), doc('list_tasks'), ...names.slice(2).map(undoc)];
    const after = names.map(doc);
    const shared = {
      prod: censusSide(prodTools),
      prodNames: names,
      localNames: names,
      authControlSameAsReal: false,
      matcherControlHits: 0,
    };
    return {
      before: decide({ ...shared, local: censusSide(before) }),
      after: decide({ ...shared, local: censusSide(after) }),
    };
  }

  it('the GATE does not move — the exit code was never keyed on local progress', () => {
    const { before, after } = twoLocalTrees();
    assert.equal(before.status, 'NOT_DEPLOYED');
    assert.equal(after.status, 'NOT_DEPLOYED');
  });

  it('the headline number DOES rise — this is the defect, pinned so it stays visible', () => {
    const { before, after } = twoLocalTrees();
    assert.equal(before.missing.length, 1);
    assert.equal(after.missing.length, 4);
    assert.ok(
      after.missing.length > before.missing.length,
      'if this ever stops being true the framing below is solving a problem that went away',
    );
  });

  it('the reason carries its own denominator, so the count cannot be read as a size', () => {
    const { before, after } = twoLocalTrees();
    // 1 of 2 documented here, then 4 of 5 — both terms present in both.
    assert.match(before.reason, /BEHIND by 1 of the 2 description/);
    assert.match(after.reason, /BEHIND by 4 of the 5 description/);
    // NEG-CTL for this matcher: the DEPLOYED reason has no such shape, so a
    // match above is about the wording and not about `reason` being any string.
    const deployed = decide({
      local: censusSide([doc('get_task')]),
      prod: censusSide([doc('get_task')]),
      prodNames: ['get_task'],
      localNames: ['get_task'],
      authControlSameAsReal: false,
      matcherControlHits: 0,
    });
    assert.equal(deployed.status, 'DEPLOYED');
    assert.doesNotMatch(deployed.reason, /BEHIND by/);
  });

  it('regressedOnProd is the one channel whose growth is bad news about PROD', () => {
    const { before, after } = twoLocalTrees();
    // Stays empty across a local repair that quadrupled `missing`.
    assert.deepEqual(before.regressedOnProd, []);
    assert.deepEqual(after.regressedOnProd, []);

    // POS-CTL — it CAN fire, so the zeroes above read as "prod is not ahead"
    // rather than as a field nobody computes. Prod documents `ghost`; this
    // tree does not.
    const names = ['get_task', 'ghost'];
    const regressed = decide({
      local: censusSide([doc('get_task'), undoc('ghost')]),
      prod: censusSide([doc('get_task'), doc('ghost')]),
      prodNames: names,
      localNames: names,
      authControlSameAsReal: false,
      matcherControlHits: 0,
    });
    assert.deepEqual(regressed.regressedOnProd, ['ghost']);
    // …and it is genuinely a DIFFERENT axis: this same run has nothing missing.
    assert.deepEqual(regressed.missing, []);
    assert.equal(regressed.status, 'DEPLOYED');
  });

  it('missing splits into what a description deploy can carry and what it cannot', () => {
    // `office_pulse` is documented here and prod\'s build does not carry the
    // tool at all — no amount of redeploying descriptions closes that row.
    const v = decide({
      local: censusSide([doc('get_task'), doc('list_tasks'), doc('office_pulse')]),
      prod: censusSide([doc('get_task'), undoc('list_tasks')]),
      prodNames: ['get_task', 'list_tasks'],
      localNames: ['get_task', 'list_tasks', 'office_pulse'],
      authControlSameAsReal: false,
      matcherControlHits: 0,
    });
    assert.deepEqual(v.missing, ['list_tasks', 'office_pulse']);
    assert.deepEqual(v.deployableNow, ['list_tasks']);
    assert.deepEqual(v.needsCodeFirst, ['office_pulse']);
    // The split is a partition of `missing` — no row falls out of both buckets
    // into silence.
    assert.equal(v.deployableNow.length + v.needsCodeFirst.length, v.missing.length);
  });
});
