import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { taskComments, taskCompletions, tasks, type Task, type TaskComment } from './schema.js';
import { assertAccessibleExists, ForbiddenError, NotFoundError } from './access.js';
import { dayStartInTz, rollRecurrence } from './recurrence.js';
import { idSchema } from './types.js';

export const createCommentInputSchema = z.object({
  taskId: idSchema,
  body: z.string().min(1).max(20000),
  source: z.enum(['human', 'agent']).optional(),
});
export type CreateCommentInput = z.infer<typeof createCommentInputSchema>;

export async function listCommentsForTask(
  ctx: Context,
  taskId: string,
): Promise<TaskComment[]> {
  await assertAccessibleExists(ctx, taskId);
  const db = getDb();
  return db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt));
}

export async function listCommentsForTasks(
  ctx: Context,
  taskIds: string[],
): Promise<Map<string, TaskComment[]>> {
  const out = new Map<string, TaskComment[]>();
  if (taskIds.length === 0) return out;
  const db = getDb();
  const rows = await db
    .select()
    .from(taskComments)
    .where(and(eq(taskComments.userId, ctx.userId), inArray(taskComments.taskId, taskIds)))
    .orderBy(asc(taskComments.createdAt));
  for (const r of rows) {
    const list = out.get(r.taskId) ?? [];
    list.push(r);
    out.set(r.taskId, list);
  }
  return out;
}

export async function createComment(
  ctx: Context,
  input: CreateCommentInput,
): Promise<TaskComment> {
  const parsed = createCommentInputSchema.parse(input);
  const task = await assertAccessibleExists(ctx, parsed.taskId);
  const row: TaskComment = {
    id: nanoid(12),
    userId: task.userId,
    taskId: parsed.taskId,
    authorUserId: ctx.userId,
    body: parsed.body,
    source: parsed.source ?? 'human',
    createdAt: Date.now(),
  };
  await getDb().insert(taskComments).values(row);
  await consumeOccurrenceFromComment(task, row);
  return row;
}

/**
 * `✅ <YYYY-MM-DD>` at the top of a comment closes that occurrence of a
 * `checkbox` recurring task — card `NxaXw3oBX3Wd`, part 2.
 *
 * Anchored at the start and tolerant of leading whitespace only. A looser
 * matcher was the obvious alternative and is wrong here: this lane's receipts
 * routinely contain a ✅ mid-body (a passing check, a table cell), and a
 * matcher that found those would roll the due date off an unrelated tick mark.
 * The date must be there too — a bare ✅ names no occurrence.
 *
 * ⚠️ A machine prefix (`☁️ yoel · ✅ 2026-09-19 …`) does NOT match, by
 * decision: "starts with" is the contract the card wrote, and widening it to
 * "starts with, after any prefix" is how a start anchor stops anchoring.
 * Callers that want the roll put the ✅ first.
 */
async function consumeOccurrenceFromComment(task: Task, comment: TaskComment): Promise<void> {
  if (!task.recurrence || task.recurrenceMode === 'deliverable') return;
  const m = /^\s*✅\s+(\d{4}-\d{2}-\d{2})\b/.exec(comment.body);
  if (!m) return;
  // The DAY the receipt claims, not `dueAt`. Which of the two identifies the
  // occurrence was the one real decision here, and `dueAt` is the wrong
  // answer: it MOVES as soon as the first ✅ rolls it, so a runner posting the
  // same receipt three times in an hour would present three different
  // occurrence keys and consume three days. Keying on the claimed date makes
  // "one ✅ per day" mean what it says. Cost, stated rather than hidden: a
  // back-dated receipt closes the day it names, not the day the board owed.
  const claimedDay = dayStartInTz(m[1]!);
  if (claimedDay === null) return;

  const db = getDb();

  // One day, one completion — and the window is the whole day, so this also
  // sees a row written by the TICK path, which stores the occurrence instant
  // (09:00 local) rather than the day start. Two routes into one state
  // machine that dedupe on keys which never compare equal would each think the
  // other never ran.
  const already = await db
    .select({ id: taskCompletions.id })
    .from(taskCompletions)
    .where(
      and(
        eq(taskCompletions.taskId, task.id),
        gte(taskCompletions.occurrenceAt, claimedDay),
        lt(taskCompletions.occurrenceAt, claimedDay + 86_400_000),
      ),
    );
  if (already.length > 0) return;

  const occurrenceAt = claimedDay;

  const now = comment.createdAt;
  await db.insert(taskCompletions).values({
    id: nanoid(12),
    taskId: task.id,
    userId: task.userId,
    completedByUserId: comment.authorUserId,
    occurrenceAt,
    completedAt: now,
    source: comment.source,
  });

  // The roll advances the BOARD's outstanding occurrence, not the claimed day.
  // Rolling from `claimedDay` would also quietly re-time the card — a standing
  // 09:00 card would come back at 00:00 — so the two roles stay separate: the
  // claimed day says WHICH occurrence closed, dueAt says what to advance.
  const base = task.dueAt ?? claimedDay;
  // Same clamp as the tick path, from the same function — see rollRecurrence.
  const { dueAt, premature, lead, intervalMs } = rollRecurrence(base, task.recurrence, now);
  if (premature) {
    console.warn(
      `[recurrence] ✅ comment on ${task.id} logged but did not advance it: occurrence ` +
        `${new Date(base).toISOString()} is ${(lead / 86_400_000).toFixed(2)}d away, ` +
        `more than half its own ${intervalMs}ms interval.`,
    );
  }
  // Status is deliberately untouched: the card is a standing one, the comment
  // is the attendance mark, and nothing spawns.
  await db.update(tasks).set({ dueAt, updatedAt: now }).where(eq(tasks.id, task.id));
}

export async function deleteComment(ctx: Context, id: string): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(taskComments).where(eq(taskComments.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(id, 'Comment');
  if (row.authorUserId !== ctx.userId && row.userId !== ctx.userId) {
    // The row EXISTS and this caller may not delete it. Reporting that as
    // NotFoundError is the same "not shared is not not-there" conflation this
    // module exists to remove — one object type over: a COMMENT id, not a task
    // id. delete_comment is the only MCP tool that takes a comment id, so it
    // reaches neither assertAccessibleExists nor assertAccessibleNoteExists and
    // the two earlier fixes both passed it by.
    //
    // Two failures are fused here and they want different answers:
    //   - the parent task is unreachable  -> NotSharedError, via the one guard
    //                                        that can tell hidden from missing
    //   - the task is readable, the caller just did not write this comment
    //                                     -> ForbiddenError, the vocabulary
    //                                        assertOwnedExists already uses
    // Nothing about WHO may delete changes: the set of successful deletes is
    // identical, only the error on the already-failing path gets its name back.
    await assertAccessibleExists(ctx, row.taskId);
    throw new ForbiddenError(id, 'Comment');
  }
  await db.delete(taskComments).where(eq(taskComments.id, id));
}
