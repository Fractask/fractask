/**
 * Recurrence engine. Two rule shapes, both stored in the `tasks.recurrence`
 * text column (a superset of the original format, so old values still parse):
 *
 *   interval : `<n>m|h|d|w|mo`         e.g. 4h, 1d, 1w, 1mo   (legacy)
 *   weekdays : `weekdays`              Mon–Fri
 *              `mon,wed,fri`           any subset, comma-separated
 *
 * `nextOccurrence` computes the next due timestamp strictly after a base time.
 * Weekday rules are evaluated in a wall-clock timezone (default Asia/Jerusalem)
 * so "every Monday 9am" stays at 9am local across DST.
 */

export const DEFAULT_TZ = 'Asia/Jerusalem';

const WEEKDAY_NUM: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const WEEKDAY_NAME = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type ParsedRecurrence =
  | { kind: 'interval'; n: number; unit: 'm' | 'h' | 'd' | 'w' | 'mo' }
  | { kind: 'weekdays'; days: number[] }; // days: 0=Sun … 6=Sat, sorted unique

const INTERVAL_RE = /^([1-9][0-9]*)(m|h|d|w|mo)$/;

/** Parse a recurrence string; returns null if invalid. */
export function parseRecurrence(raw: string): ParsedRecurrence | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  const m = INTERVAL_RE.exec(s);
  if (m) return { kind: 'interval', n: Number(m[1]), unit: m[2] as 'm' | 'h' | 'd' | 'w' | 'mo' };

  if (s === 'weekdays') return { kind: 'weekdays', days: [1, 2, 3, 4, 5] };

  const tokens = s.split(',').map((t) => t.trim());
  if (tokens.length > 0 && tokens.every((t) => t in WEEKDAY_NUM)) {
    const days = [...new Set(tokens.map((t) => WEEKDAY_NUM[t]!))].sort((a, b) => a - b);
    return { kind: 'weekdays', days };
  }
  return null;
}

/** True if the string is a valid recurrence rule. */
export function isValidRecurrence(raw: string): boolean {
  return parseRecurrence(raw) !== null;
}

/** A human-readable label, e.g. "Mon, Wed, Fri" or "Every 1d". */
export function describeRecurrence(raw: string): string {
  const p = parseRecurrence(raw);
  if (!p) return raw;
  if (p.kind === 'interval') return `Every ${p.n}${p.unit}`;
  if (p.days.length === 5 && [1, 2, 3, 4, 5].every((d) => p.days.includes(d))) return 'Weekdays';
  const cap = (n: number) => WEEKDAY_NAME[n]!.charAt(0).toUpperCase() + WEEKDAY_NAME[n]!.slice(1);
  return p.days.map(cap).join(', ');
}

// --- timezone helpers ---

function zonedParts(ts: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour'), mi: g('minute'), s: g('second') };
}

/** ms that `tz` is ahead of UTC at the given instant (DST-aware). */
function tzOffset(utcMs: number, tz: string): number {
  const p = zonedParts(utcMs, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - utcMs;
}

/** UTC ms for a wall-clock date/time interpreted in `tz`. */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  return guess - tzOffset(guess, tz);
}

/** Weekday (0=Sun) for a wall-clock calendar date. */
function weekdayOf(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/**
 * Next due timestamp strictly after `afterMs`.
 * - interval rules: base + fixed delta (calendar bump for months).
 * - weekday rules: the next matching weekday, at the same local time-of-day.
 */
export function nextOccurrence(afterMs: number, raw: string, tz: string = DEFAULT_TZ): number {
  const p = parseRecurrence(raw);
  if (!p) return afterMs;

  if (p.kind === 'interval') {
    const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
    switch (p.unit) {
      case 'm': return afterMs + p.n * MIN;
      case 'h': return afterMs + p.n * HOUR;
      case 'd': return afterMs + p.n * DAY;
      case 'w': return afterMs + p.n * WEEK;
      case 'mo': {
        const dt = new Date(afterMs);
        dt.setMonth(dt.getMonth() + p.n);
        return dt.getTime();
      }
    }
  }

  // weekdays: keep the local time-of-day of `afterMs`, walk forward 1..7 days.
  const { h, mi, s } = zonedParts(afterMs, tz);
  const base = zonedParts(afterMs, tz);
  for (let i = 1; i <= 7; i++) {
    const dayMs = Date.UTC(base.y, base.mo - 1, base.d) + i * 86_400_000;
    const nd = new Date(dayMs);
    const cy = nd.getUTCFullYear(), cmo = nd.getUTCMonth() + 1, cd = nd.getUTCDate();
    if (p.days.includes(weekdayOf(cy, cmo, cd))) {
      return wallToUtc(cy, cmo, cd, h, mi, s, tz);
    }
  }
  return afterMs;
}
