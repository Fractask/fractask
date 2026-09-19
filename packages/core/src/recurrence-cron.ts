import { and, eq, inArray, isNull, isNotNull, like, lt, ne, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from './db/client.js';
import { taskComments, tasks, type Task } from './schema.js';
import { nextOccurrence, DEFAULT_TZ } from './recurrence.js';
import { getRecurrenceSettings } from './settings.js';

const DAY = 86_400_000;

/**
 * Machine-readable tail on every skip note. Both the idempotency check and any
 * later census read THIS, not the prose above it — the sentence can be
 * rewritten without silently turning the guard off.
 */
const SKIP_MARKER = '<!-- recurrence:skipped-occurrence -->';

/**
 * `YYYY-MM-DD` for `ts` **in `tz`**.
 *
 * Not `toISOString().slice(0, 10)`. An occurrence day here is the start-of-day
 * INSTANT in `tz` — for Asia/Jerusalem that is 21:00 or 22:00 UTC the previous
 * calendar day, so a UTC label renders every occurrence as the day before the
 * one it means. Caught by the skip-note test, which is the only place these
 * timestamps are shown to a human rather than compared to each other.
 */
function dayInTz(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ts));
}

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
  /** Occurrences NOT spawned because a previous one was still in flight. */
  skipped: number;
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
  let skipped = 0;

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
        // ── The backpressure guard (card `NxaXw3oBX3Wd`) ──────────────────
        //
        // Measured on the live tree 2026-09-09: four open copies of "Post
        // Verikal social content — daily", two of the Joel Hackett post, two
        // Sunbek write-ups, two Kitkoo design days. Nothing was wrong with
        // any single spawn — the cron did exactly what it was told, once a
        // day, while nobody closed yesterday's. A daily template with a
        // multi-day turnaround is a queue with no backpressure, and the
        // board fills up with copies of one job.
        //
        // So: a template does not open a second front. If ANY previous
        // occurrence is still in flight (`open`/`doing`/`review` — the same
        // LIVE_STATUSES the ownership repair uses, for the same reason: those
        // are the rows that can still land in someone's queue), this
        // occurrence is skipped.
        //
        // Skipped, not deferred. `due` still rolls past it below, so the
        // template tracks the calendar rather than accumulating a backlog it
        // would later dump all at once. That means the miss is REAL, and a
        // real miss has to be visible or the guard just deletes work
        // quietly — hence the comment on the template, which is the only
        // durable surface the human reads.
        const blockers = await db
          .select({
            id: tasks.id,
            status: tasks.status,
            occurrenceDate: tasks.occurrenceDate,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.parentId, t.id),
              isNotNull(tasks.occurrenceDate),
              inArray(tasks.status, [...LIVE_STATUSES]),
            ),
          );
        if (blockers.length > 0) {
          await noteSkippedOccurrence(t, occDay, blockers, now, tz);
          skipped++;
          due = nextOccurrence(due, t.recurrence, tz);
          guard++;
          continue;
        }
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

  return { spawned, rolled, archived, repaired, skipped, templates: templates.length };
}

/**
 * Record a skipped occurrence on the template's own thread.
 *
 * Written straight to `task_comments` rather than through `createComment`:
 * this cron is system-wide and has no Context, and inventing one would mean
 * inventing an authorising user. `authorUserId` is the template's assignee
 * when it has one, so the note appears from the lane that owns the work.
 *
 * Idempotent on `SKIP_MARKER + occurrence day`. The roll below the call site
 * already makes a second visit to the same occurrence unreachable in a normal
 * run, but "already unreachable" is an argument, not a guard — a retried cron,
 * a failed roll or a hand-run catch-up would otherwise post the same note
 * every time, and a notice that repeats is one the reader learns to skip.
 */
async function noteSkippedOccurrence(
  t: Task,
  occDay: number,
  blockers: { id: string; status: string; occurrenceDate: number | null }[],
  now: number,
  tz: string,
): Promise<void> {
  const db = getDb();
  const day = (ms: number | null) => (ms == null ? 'no date' : dayInTz(ms, tz));
  const marker = `${SKIP_MARKER} ${day(occDay)}`;

  const prior = await db
    .select({ id: taskComments.id })
    .from(taskComments)
    .where(and(eq(taskComments.taskId, t.id), like(taskComments.body, `%${marker}%`)));
  if (prior.length > 0) return;

  const list = blockers
    .slice()
    .sort((a, b) => (a.occurrenceDate ?? 0) - (b.occurrenceDate ?? 0))
    .map((b) => `- \`${b.id}\` — ${day(b.occurrenceDate)}, still \`${b.status}\``)
    .join('\n');
  const body =
    `**Occurrence skipped — ${day(occDay)}.** ` +
    `${blockers.length} earlier occurrence${blockers.length === 1 ? ' is' : 's are'} ` +
    `still in flight, so no new child was created for this day:\n\n${list}\n\n` +
    `Close ${blockers.length === 1 ? 'it' : 'them'} and the next due day spawns normally. ` +
    `This day is skipped, not queued — it will not spawn later.\n\n${marker}`;

  await db.insert(taskComments).values({
    id: nanoid(12),
    userId: t.userId,
    taskId: t.id,
    authorUserId: t.assigneeId ?? t.userId,
    body,
    source: 'agent',
    createdAt: now,
  });
  console.warn(
    `[recurrence] skipped occurrence ${day(occDay)} of template ${t.id}: ` +
      `${blockers.length} live occurrence(s) — ${blockers.map((b) => b.id).join(', ')}`,
  );
}
