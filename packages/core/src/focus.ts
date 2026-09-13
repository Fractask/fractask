/**
 * Focus Mode event log. Every meaningful moment in a Focus session — a card
 * opened, answered, sent back, skipped; a do-card started, checked in,
 * drifted, ended; an agent reporting something shipped — lands here as one
 * row. This table is the single source for quota, streaks, pace, drift
 * stats, estimate calibration, and the ship feed; none of those are stored,
 * all are derived.
 */
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { focusEvents, type FocusEventRow, type FocusEventType } from './schema.js';
import { assertAccessibleExists } from './access.js';
import { idSchema } from './types.js';
import { DEFAULT_TZ } from './recurrence.js';
import { updateTask } from './tasks.js';

export const focusEventTypeSchema = z.enum([
  'opened',
  'answered',
  'sent_back',
  'not_relevant',
  'skipped',
  'snoozed',
  'do_started',
  'checkin_ok',
  'drift',
  'do_ended',
  'shipped',
]);

export const logFocusEventInputSchema = z.object({
  taskId: idSchema.optional(),
  promptId: idSchema.optional(),
  type: focusEventTypeSchema,
  /** Actual time on the card / task, in seconds. */
  seconds: z.number().int().nonnegative().max(86_400).optional(),
  /** Small JSON side-channel: {url,title} for shipped, {estSeconds} snapshots, etc. */
  meta: z.record(z.unknown()).optional(),
});
export type LogFocusEventInput = z.infer<typeof logFocusEventInputSchema>;

export async function logFocusEvent(
  ctx: Context,
  input: LogFocusEventInput,
): Promise<FocusEventRow> {
  const parsed = logFocusEventInputSchema.parse(input);
  const row: FocusEventRow = {
    id: nanoid(12),
    userId: ctx.userId,
    taskId: parsed.taskId ?? null,
    promptId: parsed.promptId ?? null,
    type: parsed.type as FocusEventType,
    seconds: parsed.seconds ?? null,
    meta: parsed.meta ? JSON.stringify(parsed.meta) : null,
    createdAt: Date.now(),
  };
  const db = getDb();
  await db.insert(focusEvents).values(row);
  return row;
}

export type ListFocusEventsFilter = {
  since?: number;
  until?: number;
  types?: FocusEventType[];
  taskId?: string;
};

/** Events for the current user, oldest first. Drives quota/pace/summary math. */
export async function listFocusEvents(
  ctx: Context,
  filter: ListFocusEventsFilter = {},
): Promise<FocusEventRow[]> {
  const db = getDb();
  const conditions = [eq(focusEvents.userId, ctx.userId)];
  if (filter.since !== undefined) conditions.push(gte(focusEvents.createdAt, filter.since));
  if (filter.until !== undefined) conditions.push(lte(focusEvents.createdAt, filter.until));
  if (filter.types && filter.types.length > 0) {
    conditions.push(inArray(focusEvents.type, filter.types));
  }
  if (filter.taskId !== undefined) conditions.push(eq(focusEvents.taskId, filter.taskId));
  return db
    .select()
    .from(focusEvents)
    .where(and(...conditions))
    .orderBy(asc(focusEvents.createdAt));
}

/** How long after a resolution the human can undo it in Focus. */
export const UNDO_WINDOW_MS = 15_000;

/** Drop the most recent matching focus event — used when undoing a card answer. */
export async function deleteLatestFocusEvent(
  ctx: Context,
  filter: { promptId?: string; taskId?: string; types: FocusEventType[] },
): Promise<boolean> {
  if (filter.types.length === 0) return false;
  const db = getDb();
  const conditions = [eq(focusEvents.userId, ctx.userId), inArray(focusEvents.type, filter.types)];
  if (filter.promptId !== undefined) conditions.push(eq(focusEvents.promptId, filter.promptId));
  if (filter.taskId !== undefined) conditions.push(eq(focusEvents.taskId, filter.taskId));
  const rows = await db
    .select()
    .from(focusEvents)
    .where(and(...conditions))
    .orderBy(desc(focusEvents.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  await db.delete(focusEvents).where(eq(focusEvents.id, row.id));
  return true;
}

/** Undo marking a do-card done in Focus — reopen the task within the undo window. */
export async function undoDoEnd(ctx: Context, taskId: string): Promise<void> {
  const task = await assertAccessibleExists(ctx, taskId);
  if (task.status !== 'done') throw new Error('Task is not done');
  if (task.recurrence && task.recurrenceMode !== 'deliverable') {
    throw new Error('Cannot undo recurring task completion');
  }

  const events = await listFocusEvents(ctx, { taskId, types: ['do_ended'] });
  const latest = events[events.length - 1];
  if (!latest || Date.now() - latest.createdAt > UNDO_WINDOW_MS) {
    throw new Error('Undo window expired');
  }

  await deleteLatestFocusEvent(ctx, { taskId, types: ['do_ended'] });
  await updateTask(ctx, taskId, { status: 'open' });
}

/* ─────────────────────────────── snooze ─────────────────────────────── */

/**
 * Snooze is deliberately short: park a card for at most an hour so it comes
 * back the same session and things actually get taken care of. State lives in
 * the event log (type 'snoozed', meta.until) — no schema change, and the
 * "avoided it twice" pattern stays visible in stats later.
 */
export const MAX_SNOOZE_SECONDS = 3600;
export const MIN_SNOOZE_SECONDS = 60;

/** Card key: prompt cards snooze by prompt id, do-cards by task id. */
export async function snoozeFocusCard(
  ctx: Context,
  input: { taskId?: string; promptId?: string; seconds: number },
): Promise<{ until: number }> {
  if (!input.taskId && !input.promptId) throw new Error('taskId or promptId required');
  const seconds = Math.min(
    MAX_SNOOZE_SECONDS,
    Math.max(MIN_SNOOZE_SECONDS, Math.round(input.seconds)),
  );
  const until = Date.now() + seconds * 1000;
  await logFocusEvent(ctx, {
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.promptId ? { promptId: input.promptId } : {}),
    type: 'snoozed',
    meta: { until },
  });
  return { until };
}

/**
 * Active snoozes for the user: card key → until. The lookback equals the max
 * snooze, so anything older is expired by construction; meta.until is also
 * re-capped server-side in case a client wrote a longer value.
 */
export async function getActiveSnoozes(
  ctx: Context,
  now: number = Date.now(),
): Promise<Map<string, number>> {
  const rows = await listFocusEvents(ctx, {
    since: now - MAX_SNOOZE_SECONDS * 1000,
    types: ['snoozed'],
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    // oldest-first: a re-snooze overwrites the earlier one
    let until = 0;
    try {
      until = Number((JSON.parse(r.meta ?? '{}') as { until?: unknown }).until ?? 0);
    } catch {
      until = 0;
    }
    until = Math.min(until, r.createdAt + MAX_SNOOZE_SECONDS * 1000);
    const key = r.promptId ?? r.taskId;
    if (key) out.set(key, until);
  }
  for (const [k, u] of out) if (u <= now) out.delete(k);
  return out;
}

/**
 * Answer-credit earned in a time window: ACTUAL seconds spent, for every
 * resolution kind. (The spec's original `max(actual, est)` rule inflated the
 * quota — a 10s answer on a 10-minute do-card credited 10 minutes — so Joel
 * changed it 2026-08-29: the quota measures real attention time. Estimates
 * still ride along in event meta (`{estSeconds}`) for per-agent calibration.)
 */
export function creditSeconds(events: FocusEventRow[]): number {
  let total = 0;
  for (const e of events) {
    if (
      e.type === 'answered' ||
      e.type === 'sent_back' ||
      e.type === 'not_relevant' ||
      e.type === 'do_ended'
    ) {
      total += e.seconds ?? 0;
    }
  }
  return total;
}

/**
 * Agents call this when something they were driving goes public — a page
 * published, a post live, a campaign launched. Feeds the empty-state /
 * summary "shipped because of past answers" feed, which is what makes
 * answering cards feel consequential. Logged under the task owner's id (the
 * feed is the owner's), with the reporting agent in meta.
 */
export async function reportShipped(
  ctx: Context,
  input: { taskId: string; url?: string; title: string },
): Promise<FocusEventRow> {
  const task = await assertAccessibleExists(ctx, input.taskId);
  const row: FocusEventRow = {
    id: nanoid(12),
    userId: task.userId,
    taskId: task.id,
    promptId: null,
    type: 'shipped',
    seconds: null,
    meta: JSON.stringify({
      title: input.title,
      ...(input.url ? { url: input.url } : {}),
      byUserId: ctx.userId,
    }),
    createdAt: Date.now(),
  };
  const db = getDb();
  await db.insert(focusEvents).values(row);
  return row;
}

export type ShippedItem = {
  taskId: string | null;
  title: string;
  url: string | null;
  createdAt: number;
};

/** Most recent ships for the current user's feed, newest first. */
export async function listShippedFeed(ctx: Context, limit = 8): Promise<ShippedItem[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(focusEvents)
    .where(and(eq(focusEvents.userId, ctx.userId), eq(focusEvents.type, 'shipped')))
    .orderBy(desc(focusEvents.createdAt))
    .limit(limit);
  return rows.map((r) => {
    let meta: { title?: unknown; url?: unknown } = {};
    try {
      meta = r.meta ? (JSON.parse(r.meta) as typeof meta) : {};
    } catch {
      // ignore malformed meta
    }
    return {
      taskId: r.taskId,
      title: typeof meta.title === 'string' ? meta.title : 'Shipped',
      url: typeof meta.url === 'string' ? meta.url : null,
      createdAt: r.createdAt,
    };
  });
}

/** Start-of-day (ms) for the wall-clock day containing `ts` in `tz`. */
function startOfDayInTz(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const msIntoDay = ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 + (ts % 1000);
  return ts - msIntoDay;
}

const DAY = 86_400_000;

export type FocusDayRow = {
  /** Start-of-day ms in the workspace tz. */
  dayStart: number;
  /** Actual attention time credited that day, in seconds. */
  creditSeconds: number;
  answered: number;
  sentBack: number;
  notRelevant: number;
  doEnded: number;
  drifts: number;
};

/**
 * Per-day time-worked rows for the current user, oldest first, derived
 * entirely from focus_events (§4.4 — the single source for time tracking).
 * Empty days are included so charts and week/month roll-ups stay aligned.
 */
export async function getFocusTimeRows(
  ctx: Context,
  opts: { days?: number; now?: number; tz?: string } = {},
): Promise<FocusDayRow[]> {
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? DEFAULT_TZ;
  const days = Math.min(Math.max(opts.days ?? 190, 1), 400);
  const todayStart = startOfDayInTz(now, tz);
  const events = await listFocusEvents(ctx, { since: todayStart - (days - 1) * DAY });

  const byDay = new Map<number, FocusEventRow[]>();
  for (const e of events) {
    const day = startOfDayInTz(e.createdAt, tz);
    const list = byDay.get(day) ?? [];
    list.push(e);
    byDay.set(day, list);
  }

  const rows: FocusDayRow[] = [];
  for (let d = days - 1; d >= 0; d--) {
    // Midday sample sidesteps DST edges when stepping whole days.
    const dayStart = startOfDayInTz(todayStart - d * DAY + DAY / 2, tz);
    const list = byDay.get(dayStart) ?? [];
    const count = (t: FocusEventRow['type']) => list.filter((e) => e.type === t).length;
    rows.push({
      dayStart,
      creditSeconds: creditSeconds(list),
      answered: count('answered'),
      sentBack: count('sent_back'),
      notRelevant: count('not_relevant'),
      doEnded: count('do_ended'),
      drifts: count('drift'),
    });
  }
  return rows;
}

export type FocusDaySummary = {
  /** Credit earned today (Asia/Jerusalem day), in seconds. */
  todayCreditSeconds: number;
  /**
   * Consecutive prior days (ending yesterday) that met the streak bar —
   * ≥60% of quota. Today extends it in the UI once today's bar is met, so
   * the streak shown is `streakDays + (today met ? 1 : 0)`.
   */
  streakDays: number;
  todayStart: number;
};

/**
 * Quota + streak inputs, derived entirely from focus_events (§8). A day
 * counts toward the streak when its credit reaches 60% of the daily quota.
 * ("Or the stack was cleared" also counts per spec — the UI grants today on
 * clear; historical clears are approximated by the credit bar in v1.)
 */
export async function getFocusDaySummary(
  ctx: Context,
  dailyQuotaSeconds: number,
  opts: { now?: number; tz?: string } = {},
): Promise<FocusDaySummary> {
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? DEFAULT_TZ;
  const todayStart = startOfDayInTz(now, tz);
  const LOOKBACK_DAYS = 60;
  const events = await listFocusEvents(ctx, { since: todayStart - LOOKBACK_DAYS * DAY });

  // Bucket credit by wall-clock day.
  const byDay = new Map<number, FocusEventRow[]>();
  for (const e of events) {
    const day = startOfDayInTz(e.createdAt, tz);
    const list = byDay.get(day) ?? [];
    list.push(e);
    byDay.set(day, list);
  }

  const bar = Math.ceil(dailyQuotaSeconds * 0.6);
  let streakDays = 0;
  for (let d = 1; d <= LOOKBACK_DAYS; d++) {
    const day = startOfDayInTz(todayStart - d * DAY + DAY / 2, tz);
    const credit = creditSeconds(byDay.get(day) ?? []);
    if (credit >= bar) streakDays++;
    else break;
  }

  return {
    todayCreditSeconds: creditSeconds(byDay.get(todayStart) ?? []),
    streakDays,
    todayStart,
  };
}
