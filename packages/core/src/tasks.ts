import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  max,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import {
  tags,
  tasks,
  taskTags,
  type Task,
  type TaskAttachment,
  type TaskKind,
  type TaskStatus,
} from './schema.js';
import { listAttachments } from './attachments.js';
import { listPromptsForTask, type AgentPrompt } from './prompts.js';
import {
  createTaskInputSchema,
  listTasksFilterSchema,
  updateTaskInputSchema,
  type CreateTaskInput,
  type ListTasksFilter,
  type UpdateTaskInput,
} from './types.js';
import {
  assertAccessibleExists,
  getAccessibleTaskIds,
  NotFoundError,
} from './access.js';

export { NotFoundError, ForbiddenError } from './access.js';

export type TaskWithChildren = Task & {
  children: Task[];
  attachments: TaskAttachment[];
  prompts: AgentPrompt[];
};
export type TaskTree = Task & { children: TaskTree[] };
export type TaskWithChildCount = Task & { childCount: number };

export class CycleError extends Error {
  constructor(message = 'Move would create a cycle') {
    super(message);
    this.name = 'CycleError';
  }
}

export class AmbiguousIdError extends Error {
  constructor(
    public prefix: string,
    public matches: string[],
  ) {
    super(`Prefix "${prefix}" matches ${matches.length} tasks: ${matches.join(', ')}`);
    this.name = 'AmbiguousIdError';
  }
}

/**
 * Resolves a full or prefix task ID, scoped to the tasks accessible to ctx
 * (owned or shared in). Ambiguity across that set throws AmbiguousIdError.
 */
export async function resolveTaskId(ctx: Context, idOrPrefix: string): Promise<string> {
  if (idOrPrefix.length === 0) throw new NotFoundError(idOrPrefix);
  const db = getDb();
  const len = idOrPrefix.length;
  const accessibleIds = await getAccessibleTaskIds(ctx);
  if (accessibleIds.length === 0) throw new NotFoundError(idOrPrefix);
  // SUBSTR avoids LIKE wildcard collisions with nanoid's `_` and `-`.
  const prefixCondition = sql`substr(${tasks.id}, 1, ${len}) = ${idOrPrefix}`;
  const matches = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(inArray(tasks.id, accessibleIds), prefixCondition))
    .limit(5);

  if (matches.length === 0) throw new NotFoundError(idOrPrefix);
  if (matches.length === 1) return matches[0]!.id;
  throw new AmbiguousIdError(
    idOrPrefix,
    matches.map((m) => m.id),
  );
}

function now(): number {
  return Date.now();
}

async function nextPosition(ctx: Context, parentId: string | null): Promise<number> {
  const db = getDb();
  const parentCondition = parentId === null ? isNull(tasks.parentId) : eq(tasks.parentId, parentId);
  // For root tasks (parentId null) only the user's own roots count — there's
  // no shared "root" concept. For nested parents, all accessible siblings
  // (which under a shared subtree means everyone's contributions) participate.
  const accessibleIds = parentId === null ? null : await getAccessibleTaskIds(ctx);
  const scopeCondition =
    accessibleIds === null
      ? eq(tasks.userId, ctx.userId)
      : accessibleIds.length === 0
        ? sql`0 = 1`
        : inArray(tasks.id, accessibleIds);
  const rows = await db
    .select({ max: max(tasks.position) })
    .from(tasks)
    .where(and(scopeCondition, parentCondition));
  const current = rows[0]?.max;
  return (current ?? -1) + 1;
}

export async function listTasks(ctx: Context, filter: ListTasksFilter = {}): Promise<Task[]> {
  const db = getDb();
  const f = listTasksFilterSchema.parse(filter);
  const accessibleIds = await getAccessibleTaskIds(ctx);
  if (accessibleIds.length === 0) return [];
  const conditions = [inArray(tasks.id, accessibleIds)];
  if (f.parentId === null) {
    // "Top of my view" = real roots I own + tasks shared in (whose parent
    // isn't itself accessible to me). A shared task's parent lives in the
    // owner's tree but is invisible here, so it surfaces as a root.
    conditions.push(
      sql`(${tasks.parentId} IS NULL OR ${tasks.parentId} NOT IN ${accessibleIds})`,
    );
  } else if (f.parentId !== undefined) {
    conditions.push(eq(tasks.parentId, f.parentId));
  }
  if (f.status !== undefined) {
    conditions.push(eq(tasks.status, f.status));
  }
  if (f.excludeStatuses && f.excludeStatuses.length > 0) {
    conditions.push(notInArray(tasks.status, f.excludeStatuses));
  }
  if (f.kind !== undefined) {
    conditions.push(eq(tasks.kind, f.kind));
  }
  if (f.dueBefore !== undefined) {
    conditions.push(lte(tasks.dueAt, f.dueBefore));
  }
  if (f.assigneeId !== undefined) {
    conditions.push(
      f.assigneeId === null ? isNull(tasks.assigneeId) : eq(tasks.assigneeId, f.assigneeId),
    );
  }
  if (f.reviewerId !== undefined) {
    conditions.push(
      f.reviewerId === null ? isNull(tasks.reviewerId) : eq(tasks.reviewerId, f.reviewerId),
    );
  }
  if (f.tagId !== undefined) {
    const tagged = db
      .select({ taskId: taskTags.taskId })
      .from(taskTags)
      .where(and(eq(taskTags.userId, ctx.userId), eq(taskTags.tagId, f.tagId)));
    conditions.push(inArray(tasks.id, tagged));
  }
  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.position), asc(tasks.createdAt));
}

/**
 * Like listTasks, but each row also carries `childCount` — the number of
 * direct children. One round-trip instead of N+1.
 */
export async function listTasksWithChildCount(
  ctx: Context,
  filter: ListTasksFilter = {},
): Promise<TaskWithChildCount[]> {
  const db = getDb();
  const f = listTasksFilterSchema.parse(filter);
  const parentClause =
    f.parentId === undefined
      ? sql`1 = 1`
      : f.parentId === null
        ? sql`${tasks.parentId} IS NULL`
        : sql`${tasks.parentId} = ${f.parentId}`;
  const statusClause =
    f.status === undefined ? sql`1 = 1` : sql`${tasks.status} = ${f.status}`;
  const excludeStatusClause =
    !f.excludeStatuses || f.excludeStatuses.length === 0
      ? sql`1 = 1`
      : sql`${tasks.status} NOT IN ${f.excludeStatuses}`;
  const kindClause =
    f.kind === undefined ? sql`1 = 1` : sql`${tasks.kind} = ${f.kind}`;

  // "Top of my view" branch needs the parent-not-accessible relaxation that
  // listTasks() applies. Inline the recursive CTE once so the outer filter
  // and the child_count subquery share one accessibility computation.
  const rootishParentClause =
    f.parentId === null
      ? sql`(${tasks.parentId} IS NULL OR ${tasks.parentId} NOT IN (SELECT id FROM accessible))`
      : parentClause;

  const rows = await db.all<Task & { child_count: number }>(sql`
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
    SELECT ${tasks}.*, (
      SELECT COUNT(*) FROM ${tasks} AS c
       WHERE c.parent_id = ${tasks.id}
         AND c.id IN (SELECT id FROM accessible)
    ) AS child_count
    FROM ${tasks}
    WHERE ${tasks.id} IN (SELECT id FROM accessible)
      AND ${rootishParentClause}
      AND ${statusClause}
      AND ${excludeStatusClause}
      AND ${kindClause}
    ORDER BY ${tasks.position}, ${tasks.createdAt}
  `);

  // Raw SQL gives snake_case columns; map back to typed Task shape.
  return rows.map((r) => ({
    id: r.id,
    userId: (r as unknown as { user_id: string }).user_id,
    title: r.title,
    description: r.description,
    status: r.status,
    kind: r.kind,
    rules: r.rules,
    parentId: (r as unknown as { parent_id: string | null }).parent_id,
    position: r.position,
    source: r.source,
    dueAt: (r as unknown as { due_at: number | null }).due_at,
    assigneeId: (r as unknown as { assignee_id: string | null }).assignee_id,
    reviewerId: (r as unknown as { reviewer_id: string | null }).reviewer_id,
    recurrence: (r as unknown as { recurrence: string | null }).recurrence,
    priority: (r as unknown as { priority: number | null }).priority,
    createdAt: (r as unknown as { created_at: number }).created_at,
    updatedAt: (r as unknown as { updated_at: number }).updated_at,
    completedAt: (r as unknown as { completed_at: number | null }).completed_at,
    childCount: Number(r.child_count),
  }));
}

export type SearchTasksOptions = {
  kinds?: TaskKind[];
  excludeStatuses?: TaskStatus[];
  limit?: number;
};

/**
 * Substring search over title, description, and tag names — scoped to tasks
 * accessible to ctx. Exact ID match wins, then ID prefix, then title-prefix,
 * then title-substring, then the rest; ties break by recency. LIKE
 * metacharacters in the user query are escaped via `ESCAPE '!'` so a literal
 * `%` or `_` doesn't widen the match. ID matching uses SUBSTR rather than
 * LIKE so nanoid's `_` and `-` aren't treated as wildcards.
 */
export async function searchTasks(
  ctx: Context,
  query: string,
  options: SearchTasksOptions = {},
): Promise<Task[]> {
  const q = query.trim();
  if (q.length === 0) return [];
  const accessibleIds = await getAccessibleTaskIds(ctx);
  if (accessibleIds.length === 0) return [];

  const escaped = q.replace(/[!%_]/g, '!$&');
  const pattern = `%${escaped}%`;
  const prefixPattern = `${escaped}%`;
  const limit = options.limit ?? 50;

  // Treat the query as a possible nanoid (full or prefix) only when it's
  // plausibly one — short enough, long enough to not match nearly everything,
  // and made only of the nanoid alphabet.
  const idLike = q.length >= 3 && q.length <= 64 && /^[A-Za-z0-9_-]+$/.test(q);
  const idLen = q.length;

  const textOr = or(
    sql`LOWER(${tasks.title}) LIKE LOWER(${pattern}) ESCAPE '!'`,
    sql`LOWER(COALESCE(${tasks.description}, '')) LIKE LOWER(${pattern}) ESCAPE '!'`,
    sql`${tasks.id} IN (
      SELECT ${taskTags.taskId} FROM ${taskTags}
      INNER JOIN ${tags} ON ${tags.id} = ${taskTags.tagId}
      WHERE ${taskTags.userId} = ${ctx.userId}
        AND LOWER(${tags.name}) LIKE LOWER(${pattern}) ESCAPE '!'
    )`,
  );
  const matchCondition = idLike
    ? or(sql`substr(${tasks.id}, 1, ${idLen}) = ${q}`, textOr)
    : textOr;

  const conditions = [inArray(tasks.id, accessibleIds), matchCondition];
  if (options.kinds && options.kinds.length > 0) {
    conditions.push(inArray(tasks.kind, options.kinds));
  }
  if (options.excludeStatuses && options.excludeStatuses.length > 0) {
    conditions.push(notInArray(tasks.status, options.excludeStatuses));
  }

  const rankExpr = idLike
    ? sql`CASE
        WHEN ${tasks.id} = ${q} THEN 0
        WHEN substr(${tasks.id}, 1, ${idLen}) = ${q} THEN 1
        WHEN LOWER(${tasks.title}) LIKE LOWER(${prefixPattern}) ESCAPE '!' THEN 2
        WHEN LOWER(${tasks.title}) LIKE LOWER(${pattern}) ESCAPE '!' THEN 3
        ELSE 4
      END`
    : sql`CASE
        WHEN LOWER(${tasks.title}) LIKE LOWER(${prefixPattern}) ESCAPE '!' THEN 2
        WHEN LOWER(${tasks.title}) LIKE LOWER(${pattern}) ESCAPE '!' THEN 3
        ELSE 4
      END`;

  const db = getDb();
  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(rankExpr, desc(tasks.updatedAt))
    .limit(limit);
}

export async function getTask(ctx: Context, id: string): Promise<TaskWithChildren | null> {
  const db = getDb();
  const accessibleIds = await getAccessibleTaskIds(ctx);
  if (accessibleIds.length === 0) return null;
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), inArray(tasks.id, accessibleIds)));
  const row = rows[0];
  if (!row) return null;
  const [children, attachments, prompts] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(and(inArray(tasks.id, accessibleIds), eq(tasks.parentId, id)))
      .orderBy(asc(tasks.position), asc(tasks.createdAt)),
    listAttachments(ctx, id),
    listPromptsForTask(ctx, id),
  ]);
  return { ...row, children, attachments, prompts };
}

/**
 * Returns the task and all descendants as a nested tree.
 * Uses a recursive CTE for the descendant ID set, then re-fetches typed rows.
 * Depth is bounded only by SQLite's CTE limit (default 1000).
 */
export async function getSubtree(ctx: Context, id: string): Promise<TaskTree | null> {
  const ids = await collectDescendantIds(ctx, id);
  if (ids.length === 0) return null;

  const db = getDb();
  const rows = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.id, ids))
    .orderBy(asc(tasks.position), asc(tasks.createdAt));
  return assembleTree(rows, id);
}

async function collectDescendantIds(ctx: Context, rootId: string): Promise<string[]> {
  // Walk the tree from rootId, but only across rows accessible to ctx —
  // owned-by-me OR transitively reachable from a task_shares row for me.
  const db = getDb();
  const result = await db.all<{ id: string }>(sql`
    WITH RECURSIVE roots(id) AS (
      SELECT id FROM tasks WHERE user_id = ${ctx.userId}
      UNION
      SELECT task_id FROM task_shares WHERE user_id = ${ctx.userId}
    ),
    accessible(id) AS (
      SELECT id FROM roots
      UNION
      SELECT t.id FROM tasks t JOIN accessible a ON t.parent_id = a.id
    ),
    subtree(id) AS (
      SELECT id FROM ${tasks}
       WHERE ${tasks.id} = ${rootId}
         AND ${tasks.id} IN (SELECT id FROM accessible)
      UNION ALL
      SELECT t.id FROM ${tasks} t
        JOIN subtree s ON t.parent_id = s.id
       WHERE t.id IN (SELECT id FROM accessible)
    )
    SELECT id FROM subtree
  `);
  return result.map((r) => r.id);
}

function assembleTree(rows: Task[], rootId: string): TaskTree | null {
  const byId = new Map<string, TaskTree>();
  for (const row of rows) byId.set(row.id, { ...row, children: [] });
  let root: TaskTree | null = null;
  for (const row of rows) {
    const node = byId.get(row.id)!;
    if (row.id === rootId) {
      root = node;
      continue;
    }
    if (row.parentId && byId.has(row.parentId)) {
      byId.get(row.parentId)!.children.push(node);
    }
  }
  return root;
}

export async function createTask(ctx: Context, input: CreateTaskInput): Promise<Task> {
  const parsed = createTaskInputSchema.parse(input);
  const db = getDb();

  const parentId = parsed.parentId ?? null;
  // Inherited owner: a child of a parent shared with me lives in the
  // parent's owner's tree, so collaborators see each other's additions.
  let ownerId = ctx.userId;
  if (parentId !== null) {
    const parent = await assertAccessibleExists(ctx, parentId);
    ownerId = parent.userId;
  }

  const ts = now();
  const row: Task = {
    id: nanoid(12),
    userId: ownerId,
    title: parsed.title,
    description: parsed.description ?? null,
    rules: parsed.rules ?? null,
    status: parsed.status ?? 'open',
    kind: parsed.kind ?? 'task',
    parentId,
    position: parsed.position ?? (await nextPosition(ctx, parentId)),
    source: parsed.source ?? 'human',
    dueAt: parsed.dueAt ?? null,
    assigneeId: parsed.assigneeId ?? null,
    reviewerId: parsed.reviewerId ?? null,
    recurrence: parsed.recurrence ?? null,
    priority: null,
    createdAt: ts,
    updatedAt: ts,
    completedAt: null,
  };
  await db.insert(tasks).values(row);

  if (parsed.tagIds && parsed.tagIds.length > 0) {
    await db.insert(taskTags).values(
      parsed.tagIds.map((tagId) => ({
        userId: ctx.userId,
        taskId: row.id,
        tagId,
        createdAt: ts,
      })),
    );
  }

  return row;
}

export async function updateTask(
  ctx: Context,
  id: string,
  patch: UpdateTaskInput,
): Promise<Task> {
  const parsed = updateTaskInputSchema.parse(patch);
  const existing = await assertAccessibleExists(ctx, id);

  const db = getDb();
  const ts = now();
  const update: Partial<Task> = { updatedAt: ts };
  if (parsed.title !== undefined) update.title = parsed.title;
  if (parsed.description !== undefined) update.description = parsed.description;
  if (parsed.rules !== undefined) update.rules = parsed.rules;
  if (parsed.kind !== undefined) update.kind = parsed.kind;
  if (parsed.dueAt !== undefined) update.dueAt = parsed.dueAt;
  if (parsed.assigneeId !== undefined) update.assigneeId = parsed.assigneeId;
  if (parsed.reviewerId !== undefined) update.reviewerId = parsed.reviewerId;
  if (parsed.recurrence !== undefined) update.recurrence = parsed.recurrence;

  if (parsed.status !== undefined) {
    // Recurring tasks roll forward instead of completing: when marked 'done',
    // bump dueAt by the recurrence interval and stay 'open'. This is what
    // makes a heartbeat-style task work.
    if (parsed.status === 'done' && existing.recurrence) {
      const nextDue = advanceDueAt(existing.dueAt ?? ts, existing.recurrence);
      update.status = 'open';
      update.dueAt = nextDue;
      update.completedAt = null;
    } else {
      update.status = parsed.status;
      update.completedAt = parsed.status === 'done' ? ts : null;
    }
  }

  await db.update(tasks).set(update).where(eq(tasks.id, id));

  const rows = await db.select().from(tasks).where(eq(tasks.id, id));
  return rows[0]!;
}

/**
 * Adds a recurrence interval to a base timestamp.
 * Recurrence format: `<n>m|h|d|w|mo`. See recurrenceSchema in types.ts.
 */
export function advanceDueAt(baseMs: number, recurrence: string): number {
  const match = /^([1-9][0-9]*)(m|h|d|w|mo)$/.exec(recurrence);
  if (!match) return baseMs;
  const n = Number(match[1]);
  const unit = match[2];
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  switch (unit) {
    case 'm':
      return baseMs + n * minute;
    case 'h':
      return baseMs + n * hour;
    case 'd':
      return baseMs + n * day;
    case 'w':
      return baseMs + n * week;
    case 'mo': {
      // Calendar-month bump: set the date n months forward.
      const d = new Date(baseMs);
      d.setMonth(d.getMonth() + n);
      return d.getTime();
    }
  }
  return baseMs;
}

export async function deleteTask(
  ctx: Context,
  id: string,
): Promise<{ deletedIds: string[] }> {
  await assertAccessibleExists(ctx, id);
  const ids = await collectDescendantIds(ctx, id);
  if (ids.length === 0) return { deletedIds: [] };

  const db = getDb();
  await db.delete(taskTags).where(inArray(taskTags.taskId, ids));
  await db.delete(tasks).where(inArray(tasks.id, ids));
  return { deletedIds: ids };
}

export async function moveTask(
  ctx: Context,
  id: string,
  newParentId: string | null,
  position?: number,
): Promise<Task> {
  await assertAccessibleExists(ctx, id);
  if (newParentId !== null) {
    await assertAccessibleExists(ctx, newParentId);
    if (newParentId === id) throw new CycleError('Cannot parent a task to itself');
    const subtree = await getSubtree(ctx, id);
    if (subtree) {
      const ids = collectIds(subtree);
      if (ids.has(newParentId)) {
        throw new CycleError('Cannot move a task under one of its own descendants');
      }
    }
  }

  const db = getDb();
  const ts = now();
  const targetPos = position ?? (await nextPosition(ctx, newParentId));

  // Shift siblings at or after targetPos when inserting at a specific slot,
  // unless the task is already at that slot under that parent. Sibling shifts
  // span all accessible rows under the new parent — under a shared subtree,
  // every collaborator's contributions need to slide together.
  if (position !== undefined) {
    const parentCondition =
      newParentId === null ? isNull(tasks.parentId) : eq(tasks.parentId, newParentId);
    const accessibleIds = await getAccessibleTaskIds(ctx);
    const scopeCondition =
      newParentId === null
        ? eq(tasks.userId, ctx.userId)
        : accessibleIds.length === 0
          ? sql`0 = 1`
          : inArray(tasks.id, accessibleIds);
    await db
      .update(tasks)
      .set({ position: sql`${tasks.position} + 1`, updatedAt: ts })
      .where(
        and(
          scopeCondition,
          parentCondition,
          sql`${tasks.position} >= ${targetPos}`,
          sql`${tasks.id} != ${id}`,
        ),
      );
  }

  await db
    .update(tasks)
    .set({ parentId: newParentId, position: targetPos, updatedAt: ts })
    .where(eq(tasks.id, id));

  const rows = await db.select().from(tasks).where(eq(tasks.id, id));
  return rows[0]!;
}

function collectIds(tree: TaskTree, acc: Set<string> = new Set()): Set<string> {
  acc.add(tree.id);
  for (const child of tree.children) collectIds(child, acc);
  return acc;
}

/**
 * Renumber the `priority` column for the given task ids in order. Unlike
 * `reorderSiblings` this is parent-agnostic — it's used for cross-parent
 * views like Today where ordering doesn't follow the tree. Tasks not in the
 * list keep their existing priority. One SQL round-trip.
 */
export async function setPriority(ctx: Context, orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const accessibleIds = await getAccessibleTaskIds(ctx);
  if (accessibleIds.length === 0) return;
  const accessibleSet = new Set(accessibleIds);
  const eligible = orderedIds.filter((id) => accessibleSet.has(id));
  if (eligible.length === 0) return;
  const db = getDb();
  const ts = now();
  const cases = eligible.map((id, i) => sql`WHEN ${id} THEN ${i}`);
  const idList = sql.join(
    eligible.map((id) => sql`${id}`),
    sql`, `,
  );
  await db.run(sql`
    UPDATE ${tasks}
       SET priority = (CASE ${tasks.id} ${sql.join(cases, sql` `)} END),
           updated_at = ${ts}
     WHERE ${tasks.id} IN (${idList})
  `);
}

/**
 * List tasks due on or before `before`, ordered by user-set priority first
 * (NULLS LAST), then dueAt, then createdAt. Drives the Today view's drag
 * reorder + chronological fallback.
 */
export async function listDueTasks(
  ctx: Context,
  before: number,
  status?: Task['status'],
): Promise<Task[]> {
  const db = getDb();
  const accessibleIds = await getAccessibleTaskIds(ctx);
  if (accessibleIds.length === 0) return [];
  const conditions = [inArray(tasks.id, accessibleIds), lte(tasks.dueAt, before)];
  if (status !== undefined) conditions.push(eq(tasks.status, status));
  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(
      sql`CASE WHEN ${tasks.priority} IS NULL THEN 1 ELSE 0 END`,
      asc(tasks.priority),
      asc(tasks.dueAt),
      asc(tasks.createdAt),
    );
}

/**
 * Renumber a parent's children to match `orderedIds` exactly. The given list
 * must contain *all and only* the current siblings under `parentId`. Done in
 * one SQL round-trip via a CASE expression — important under embedded
 * replicas where each write is a remote round-trip.
 */
export async function reorderSiblings(
  ctx: Context,
  parentId: string | null,
  orderedIds: string[],
): Promise<void> {
  if (orderedIds.length === 0) return;

  const db = getDb();
  const parentClause = parentId === null ? isNull(tasks.parentId) : eq(tasks.parentId, parentId);
  const accessibleIds = await getAccessibleTaskIds(ctx);
  // Roots are owner-scoped (the user only renumbers their own top-level
  // tasks); nested parents include every accessible sibling under them.
  const scopeCondition =
    parentId === null
      ? eq(tasks.userId, ctx.userId)
      : accessibleIds.length === 0
        ? sql`0 = 1`
        : inArray(tasks.id, accessibleIds);
  const current = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(scopeCondition, parentClause));

  const currentIds = new Set(current.map((r) => r.id));
  if (currentIds.size !== orderedIds.length) {
    throw new Error(
      `reorder must list every sibling exactly once: have ${currentIds.size}, got ${orderedIds.length}`,
    );
  }
  for (const id of orderedIds) {
    if (!currentIds.has(id)) throw new NotFoundError(id);
  }

  const ts = now();
  const cases = orderedIds.map((id, i) => sql`WHEN ${id} THEN ${i}`);
  const idList = sql.join(
    orderedIds.map((id) => sql`${id}`),
    sql`, `,
  );
  await db.run(sql`
    UPDATE ${tasks}
       SET position = (CASE ${tasks.id} ${sql.join(cases, sql` `)} END),
           updated_at = ${ts}
     WHERE ${tasks.id} IN (${idList})
  `);
}
