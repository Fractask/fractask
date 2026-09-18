import { and, asc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { taskComments, type TaskComment } from './schema.js';
import { assertAccessibleExists, ForbiddenError, NotFoundError } from './access.js';
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
  return row;
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
