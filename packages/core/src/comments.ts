import { and, asc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { taskComments, type TaskComment } from './schema.js';
import { assertAccessibleExists, NotFoundError } from './access.js';
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
  if (!row) throw new NotFoundError(id);
  if (row.authorUserId !== ctx.userId && row.userId !== ctx.userId) {
    throw new NotFoundError(id);
  }
  await db.delete(taskComments).where(eq(taskComments.id, id));
}
