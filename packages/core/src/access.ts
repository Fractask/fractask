import { and, eq, sql } from 'drizzle-orm';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { tasks, type Task } from './schema.js';

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`Task ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  constructor(id: string) {
    super(`Task ${id} requires owner permission`);
    this.name = 'ForbiddenError';
  }
}

/**
 * Returns task IDs accessible to ctx.userId — owned tasks plus the descendant
 * closure of every `task_shares` row for the user. One round-trip via a
 * recursive CTE.
 */
export async function getAccessibleTaskIds(ctx: Context): Promise<string[]> {
  const db = getDb();
  const rows = await db.all<{ id: string }>(sql`
    WITH RECURSIVE roots(id) AS (
      SELECT id FROM tasks WHERE user_id = ${ctx.userId}
      UNION
      SELECT task_id FROM task_shares WHERE user_id = ${ctx.userId}
    ),
    accessible(id) AS (
      SELECT id FROM roots
      UNION
      SELECT t.id FROM tasks t JOIN accessible a ON t.parent_id = a.id
    )
    SELECT DISTINCT id FROM accessible
  `);
  return rows.map((r) => r.id);
}

/**
 * Asserts that `id` is accessible to ctx.userId (owned or shared), returns
 * the row. Throws NotFoundError otherwise — same error shape callers already
 * handle, so a non-accessible id looks the same as a non-existent one.
 */
export async function assertAccessibleExists(ctx: Context, id: string): Promise<Task> {
  const db = getDb();
  const rows = await db.all<Record<string, unknown>>(sql`
    WITH RECURSIVE roots(id) AS (
      SELECT id FROM tasks WHERE user_id = ${ctx.userId}
      UNION
      SELECT task_id FROM task_shares WHERE user_id = ${ctx.userId}
    ),
    accessible(id) AS (
      SELECT id FROM roots
      UNION
      SELECT t.id FROM tasks t JOIN accessible a ON t.parent_id = a.id
    )
    SELECT t.* FROM tasks t
     WHERE t.id = ${id}
       AND t.id IN (SELECT id FROM accessible)
  `);
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  return rowToTask(row);
}

/**
 * Asserts that `id` is owned by ctx.userId. Used for share/unshare ops where
 * only the owner can act. Throws ForbiddenError if accessible-but-not-owned,
 * NotFoundError if not even accessible.
 */
export async function assertOwnedExists(ctx: Context, id: string): Promise<Task> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, ctx.userId)));
  const row = rows[0];
  if (row) return row;

  // Not owned — distinguish "doesn't exist / not accessible" from "exists but shared with me".
  await assertAccessibleExists(ctx, id);
  throw new ForbiddenError(id);
}

function rowToTask(r: Record<string, unknown>): Task {
  return {
    id: r['id'] as string,
    userId: r['user_id'] as string,
    title: r['title'] as string,
    description: (r['description'] as string | null) ?? null,
    status: r['status'] as Task['status'],
    kind: r['kind'] as Task['kind'],
    rules: (r['rules'] as string | null) ?? null,
    parentId: (r['parent_id'] as string | null) ?? null,
    position: r['position'] as number,
    source: r['source'] as Task['source'],
    dueAt: (r['due_at'] as number | null) ?? null,
    assigneeId: (r['assignee_id'] as string | null) ?? null,
    reviewerId: (r['reviewer_id'] as string | null) ?? null,
    recurrence: (r['recurrence'] as string | null) ?? null,
    priority: (r['priority'] as number | null) ?? null,
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
    completedAt: (r['completed_at'] as number | null) ?? null,
  };
}
