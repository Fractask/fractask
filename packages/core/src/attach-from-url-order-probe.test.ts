import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAFE_PAIRINGS,
  pairingIsSafe,
  fetchableUrlFor,
  decideOrder,
  exitCodeFor,
  UNFETCHABLE_URL,
  type OrderReading,
} from '../scripts/attach-from-url-order-probe.mts';

/** Prod's reading, 2026-09-15 09:4xZ. */
const LIVE_DEFECT: OrderReading = {
  notSharedUnfetchable: 'OTHER_ERR',
  notSharedFetchable: 'NOT_SHARED',
  neverRealFetchable: 'NOT_FOUND',
  readableUnfetchable: 'OTHER_ERR',
  noteFetchable: 'NOT_FOUND',
  noteUnfetchable: 'OTHER_ERR',
};

/** The world after the hoist ships: the url stops deciding the verdict. */
const HOISTED: OrderReading = {
  ...LIVE_DEFECT,
  notSharedUnfetchable: 'NOT_SHARED',
  readableUnfetchable: 'OTHER_ERR',
  noteUnfetchable: 'NOT_FOUND',
};

describe('attach_file_from_url order probe — the pairing this probe may never send', () => {
  // The safety argument is the ABSENCE of one row, and an absence is exactly
  // what a later edit re-adds without noticing. `readable × fetchable` is the
  // only pairing where an unrefused write has somewhere to land.
  test('readable × fetchable is not in SAFE_PAIRINGS', () => {
    assert.equal(pairingIsSafe('readable', 'fetchable'), false);
  });

  test('every other pairing of the four subjects IS allowed, so the gate is not vacuous', () => {
    for (const subject of ['notShared', 'neverReal', 'neverRealNote'] as const) {
      assert.equal(pairingIsSafe(subject, 'fetchable'), true, `${subject} × fetchable`);
      assert.equal(pairingIsSafe(subject, 'unfetchable'), true, `${subject} × unfetchable`);
    }
    assert.equal(pairingIsSafe('readable', 'unfetchable'), true);
    assert.equal(SAFE_PAIRINGS.length, 7);
  });

  test('the unfetchable url is a reserved TLD, so no delegation can ever make it yield a body', () => {
    assert.match(UNFETCHABLE_URL, /^https:\/\/[^/]+\.invalid\//);
  });

  test('the fetchable url is derived from the endpoint origin, not hard-coded at a fleet property', () => {
    assert.equal(
      fetchableUrlFor('https://getshitdone-kappa.vercel.app/api/mcp'),
      'https://getshitdone-kappa.vercel.app/zzz-not-shared-order-ctl',
    );
    // The 08:5xZ hand pass pointed this at verikal.ai and put a row in that
    // property's own 404 census. Derivation is what stops that recurring.
    assert.ok(!fetchableUrlFor('https://example.test/api/mcp').includes('verikal'));
  });
});

describe('attach_file_from_url order probe — the verdict', () => {
  test("prod's live reading is ORDER-DEFECT-LIVE, exit 1", () => {
    const v = decideOrder(LIVE_DEFECT, true);
    assert.equal(v.status, 'ORDER-DEFECT-LIVE');
    assert.equal(exitCodeFor(v), 1);
    assert.equal(v.reachOk, true);
    assert.equal(v.noteLegSameOrder, true);
  });

  // Precondition 19: a control keyed on the DEFECT alarms when the defect is
  // fixed, and the repair it invites is to the instrument. Asked "what does
  // this print in the fixed world?", the answer must be a verdict about the
  // world — and it must name the follow-up, because this is the only moment
  // anyone would be told the row became an ordinary probeable row.
  test('the FIXED world exits 0 and says to delete this probe — it does not alarm', () => {
    const v = decideOrder(HOISTED, true);
    assert.equal(v.status, 'PROD-HOISTED');
    assert.equal(exitCodeFor(v), 0);
    assert.match(v.reason, /delete this probe/);
    assert.match(v.reason, /do not just quote this green/);
  });

  // Precondition 12: three identical answers means the call was never asked,
  // not that the tool conflates. The unfetchable leg ALONE produces exactly
  // that, which is why REACH is read first and gates everything after it.
  test('REACH is read before the verdict — an unreached handler is INCONCLUSIVE, never CONFLATES', () => {
    const neverReached: OrderReading = {
      ...LIVE_DEFECT,
      notSharedFetchable: 'OTHER_ERR',
      neverRealFetchable: 'OTHER_ERR',
    };
    const v = decideOrder(neverReached, true);
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.equal(exitCodeFor(v), 2);
    assert.equal(v.reachOk, false);
    assert.match(v.reason, /reached the access layer/);
  });

  test('a failed url precondition means the probe was NOT sent, and says so', () => {
    const v = decideOrder(LIVE_DEFECT, false);
    assert.equal(v.status, 'INCONCLUSIVE');
    assert.equal(exitCodeFor(v), 2);
    assert.match(v.reason, /did not send the probe/);
  });

  // The note surface has already given the opposite verdict on an identical
  // assert shape once (`update_note`), so this must be read, never inherited.
  test('the note leg is reported independently of the task leg', () => {
    const noteDiffers: OrderReading = { ...LIVE_DEFECT, noteUnfetchable: 'NOT_FOUND' };
    const v = decideOrder(noteDiffers, true);
    assert.equal(v.status, 'ORDER-DEFECT-LIVE', 'the task-leg verdict is unchanged');
    assert.equal(v.noteLegSameOrder, false, 'and the note leg dissents on its own');
  });
});
