import { and, eq, inArray, isNull, isNotNull, lt, ne, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from './db/client.js';
import { tasks, type Task } from './schema.js';
import { nextOccurrence, DEFAULT_TZ } from './recurrence.js';
import { getRecurrenceSettings } from './settings.js';

const DAY = 86_400_000;

/** Start-of-day (ms) for the wall-clock day containing `ts` in `tz`. */
function startOfDayInTz(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return ts - (((g('hour') * 60 + g('minute')) * 60 + g('second')) * 1000 + (ts % 1000));
}

export type RecurrenceCronResult = {
  spawned: number;
  rolled: number;
  archived: number;
  /** Occurrences whose null assignee/reviewer was back-filled from the template. */
  repaired: number;
  templates: number;
};

/**
 * An occurrence is still in flight — i.e. it can still land in someone's queue —
 * in these statuses. Terminal rows are left alone by the ownership repair.
 */
const LIVE_STATUSES = ['open', 'doing', 'review'] as const;

/**
 * Materialize `deliverable` recurring tasks. For each template whose next due is
 * today or overdue, spawn a child instance for that occurrence (idempotent per
 * occurrence day) and roll the template's dueAt forward; then apply archival.
 *
 * Runs system-wide (all users) — this is a background job, not user-scoped, so
 * it operates directly on the DB rather than through a per-user Context.
 */
export async function materializeRecurrences(now: number = Date.now()): Promise<RecurrenceCronResult> {
  const db = getDb();
  const tz = DEFAULT_TZ;
  const todayStart = startOfDayInTz(now, tz);
  const todayEnd = todayStart + DAY;
  const { archiveDays, archiveOnNextOccurrence } = await getRecurrenceSettings();

  // Deliverable recurring templates (not themselves instances, not archived).
  const templates = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.recurrence),
        eq(tasks.recurrenceMode, 'deliverable'),
        isNull(tasks.occurrenceDate),
        ne(tasks.status, 'archived'),
      ),
    );

  let spawned = 0;
  let rolled = 0;
  let archived = 0;
  let repaired = 0;

  for (const t of templates) {
    if (t.dueAt == null || t.recurrence == null) continue;
    let due = t.dueAt;
    let guard = 0; // catch-up cap so a long-dormant template can't spawn hundreds
    while (due < todayEnd && guard < 14) {
      const occDay = startOfDayInTz(due, tz);
      // Idempotent per occurrence day.
      const existing = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.parentId, t.id), eq(tasks.occurrenceDate, occDay)));
      if (existing.length === 0) {
        // Ownership is inherited, never defaulted: an occurrence of an owned
        // template must land in the same person's queue. Read once so the
        // guard below and the row insert can't disagree.
        const assigneeId = t.assigneeId;
        const reviewerId = t.reviewerId;
        if (t.assigneeId !== null && assigneeId === null) {
          // Unreachable by construction, and deliberately so — this is the
          // invariant, not a fallback. A `deliverable` occurrence with a null
          // assignee under an owned template is the silent-stall shape: it can
          // be worked, approved and parked in `review` while appearing in
          // nobody's queue. Refuse the spawn and make the failure loud rather
          // than materializing an ownerless card.
          console.warn(
            `[recurrence] refusing to spawn ownerless occurrence of template ${t.id} ` +
              `(occurrenceDate ${occDay}): template assignee ${t.assigneeId} was not inherited`,
          );
          due = nextOccurrence(due, t.recurrence, tz);
          guard++;
          continue;
        }
        const inst: Task = {
          id: nanoid(12),
          userId: t.userId,
          title: t.title,
          description: t.description,
          status: 'open',
          kind: 'task',
          rules: null,
          parentId: t.id,
          position: 0,
          source: t.source,
          dueAt: due,
          assigneeId,
          reviewerId,
          recurrence: null,
          recurrenceMode: 'checkbox',
          // Instances inherit the template's goal link — the daily deliverable
          // advances the same goal the template was pointed at.
          goalId: t.goalId,
          milestoneId: t.milestoneId,
          progressPct: null,
          occurrenceDate: occDay,
          priority: t.priority,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        };
        await db.insert(tasks).values(inst);
        spawned++;
      }
      due = nextOccurrence(due, t.recurrence, tz);
      guard++;
    }

    if (due !== t.dueAt) {
      await db.update(tasks).set({ dueAt: due, updatedAt: now }).where(eq(tasks.id, t.id));
      rolled++;
    }

    // Back-fill ownership on live occurrences that are missing it. Spawn
    // inherits (above), but rows created before that did, or orphaned by an
    // assignee delete, are ownerless forever otherwise — and an ownerless
    // occurrence is invisible in every queue while still looking like work in
    // progress from the tree. Terminal rows (done/archived/backlog/snoozed)
    // are left alone; so is a template that has no owner to lend.
    if (t.assigneeId !== null || t.reviewerId !== null) {
      const orphans = await db
        .select({ id: tasks.id, assigneeId: tasks.assigneeId, reviewerId: tasks.reviewerId })
        .from(tasks)
        .where(
          and(
            eq(tasks.parentId, t.id),
            isNotNull(tasks.occurrenceDate),
            inArray(tasks.status, [...LIVE_STATUSES]),
            or(
              t.assigneeId !== null ? isNull(tasks.assigneeId) : undefined,
              t.reviewerId !== null ? isNull(tasks.reviewerId) : undefined,
            ),
          ),
        );
      for (const o of orphans) {
        const patch: Partial<Task> = { updatedAt: now };
        if (o.assigneeId === null && t.assigneeId !== null) patch.assigneeId = t.assigneeId;
        if (o.reviewerId === null && t.reviewerId !== null) patch.reviewerId = t.reviewerId;
        await db.update(tasks).set(patch).where(eq(tasks.id, o.id));
        repaired++;
        console.warn(
          `[recurrence] repaired ownerless occurrence ${o.id} of template ${t.id} ` +
            `(assignee → ${patch.assigneeId ?? o.assigneeId}, reviewer → ${patch.reviewerId ?? o.reviewerId})`,
        );
      }
    }

    if (archiveOnNextOccurrence && spawned > 0) {
      // Archive prior done instances now that a newer occurrence exists.
      const res = await db
        .update(tasks)
        .set({ status: 'archived', updatedAt: now })
        .where(
          and(
            eq(tasks.parentId, t.id),
            isNotNull(tasks.occurrenceDate),
            eq(tasks.status, 'done'),
            lt(tasks.occurrenceDate, todayStart),
          ),
        );
      archived += res.rowsAffected ?? 0;
    }
  }

  // Age-based archival across all deliverable instances.
  if (archiveDays > 0) {
    const cutoff = now - archiveDays * DAY;
    const res = await db
      .update(tasks)
      .set({ status: 'archived', updatedAt: now })
      .where(
        and(
          isNotNull(tasks.occurrenceDate),
          eq(tasks.status, 'done'),
          isNotNull(tasks.completedAt),
          lt(tasks.completedAt, cutoff),
        ),
      );
    archived += res.rowsAffected ?? 0;
  }

  return { spawned, rolled, archived, repaired, templates: templates.length };
}
