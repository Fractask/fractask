import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecurrence, isValidRecurrence, describeRecurrence, nextOccurrence } from './recurrence.js';

const TZ = 'Asia/Jerusalem';
const WD3: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
// Helper: weekday (0=Sun) of a ts in TZ, read directly from Intl.
function wd(ts: number): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })
    .format(ts)
    .toLowerCase();
  return WD3[name]!;
}
function localHour(ts: number): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit' }).format(ts),
  );
}

test('parse: legacy intervals still valid', () => {
  assert.deepEqual(parseRecurrence('1d'), { kind: 'interval', n: 1, unit: 'd' });
  assert.deepEqual(parseRecurrence('4h'), { kind: 'interval', n: 4, unit: 'h' });
  assert.deepEqual(parseRecurrence('2w'), { kind: 'interval', n: 2, unit: 'w' });
  assert.deepEqual(parseRecurrence('1mo'), { kind: 'interval', n: 1, unit: 'mo' });
});

test('parse: weekdays keyword + lists', () => {
  assert.deepEqual(parseRecurrence('weekdays'), { kind: 'weekdays', days: [1, 2, 3, 4, 5] });
  assert.deepEqual(parseRecurrence('mon,wed,fri'), { kind: 'weekdays', days: [1, 3, 5] });
  assert.deepEqual(parseRecurrence('FRI, mon'), { kind: 'weekdays', days: [1, 5] }); // case + order + spaces
  assert.deepEqual(parseRecurrence('mon,mon'), { kind: 'weekdays', days: [1] }); // dedupe
});

test('parse: invalid', () => {
  assert.equal(parseRecurrence('funday'), null);
  assert.equal(parseRecurrence('0d'), null);
  assert.equal(parseRecurrence(''), null);
  assert.equal(isValidRecurrence('mon,xyz'), false);
});

test('describe', () => {
  assert.equal(describeRecurrence('weekdays'), 'Weekdays');
  assert.equal(describeRecurrence('mon,wed,fri'), 'Mon, Wed, Fri');
  assert.equal(describeRecurrence('1d'), 'Every 1d');
});

test('nextOccurrence: interval adds fixed delta', () => {
  const base = Date.UTC(2026, 6, 28, 9, 0, 0); // arbitrary
  assert.equal(nextOccurrence(base, '1d'), base + 86_400_000);
  assert.equal(nextOccurrence(base, '4h'), base + 4 * 3_600_000);
});

test('nextOccurrence: weekdays lands on a matching day, strictly after', () => {
  // 2026-07-27 is a Monday. From Monday, weekdays(mon-fri) → next is Tuesday.
  const mon = Date.UTC(2026, 6, 27, 6, 0, 0); // 09:00 Israel (UTC+3)
  const next = nextOccurrence(mon, 'weekdays', TZ);
  assert.ok(next > mon);
  assert.equal(wd(next), 2); // Tuesday
});

test('nextOccurrence: mon,wed,fri from Wednesday → Friday', () => {
  // 2026-07-29 is a Wednesday.
  const wed = Date.UTC(2026, 6, 29, 6, 0, 0);
  const next = nextOccurrence(wed, 'mon,wed,fri', TZ);
  assert.equal(wd(next), 5); // Friday
});

test('nextOccurrence: weekdays from Friday skips weekend → Monday', () => {
  // 2026-07-31 is a Friday.
  const fri = Date.UTC(2026, 6, 31, 6, 0, 0);
  const next = nextOccurrence(fri, 'weekdays', TZ);
  assert.equal(wd(next), 1); // Monday
});

test('nextOccurrence: preserves local time-of-day', () => {
  const mon = Date.UTC(2026, 6, 27, 6, 0, 0); // 09:00 Israel
  const next = nextOccurrence(mon, 'weekdays', TZ);
  assert.equal(localHour(next), localHour(mon)); // still 09:00 local
});
