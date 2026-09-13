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
  agentPrompts,
  tags,
  tasks,
  taskTags,
  taskCompletions,
  type Task,
  type TaskAttachment,
  type TaskKind,
  type TaskStatus,
} from './schema.js';
import { listAttachments } from './attachments.js';
import { nextOccurrence } from './recurrence.js';
import { hasPendingPrompt, listPromptsForTask, type AgentPrompt } from './prompts.js';
import { findUserById, isAgentCall } from './auth.js';
import { isAgentRuleEnabled } from './settings.js';
import { listCommentsForTask } from './comments.js';
import type { TaskComment } from './schema.js';
import {
  createTaskInputSchema,
  listTasksFilterSchema,
  updateTaskInputSchema,
  type CreateTaskInput,
  type ListTasksFilter,
  type UpdateTaskInput,
} from './types.js';
import {
  accessibleTasksCte,
  assertAccessibleExists,
  assertFilterIdNotHidden,
  getAccessibleTaskIds,
  NotFoundError,
} from './access.js';

export { NotFoundError, NotSharedError, ForbiddenError, NOT_SHARED_MESSAGE } from './access.js';

export type TaskWithChildren = Task & {
  children: Task[];
  attachments: TaskAttachment[];
  prompts: AgentPrompt[];
  comments: TaskComment[];
};
export type TaskTree = Task & { children: TaskTree[] };
export type TaskWithChildCount = Task & { childCount: number };

export class CycleError extends Error {
  constructor(message = 'Move would create a cycle') {
    super(message);
    this.name = 'CycleError';
  }
}

/**
 * Thrown when an agent tries to park a task in `review` with nothing for the
 * human to answer. See `assertMayEnterReview`.
 */
export class ReviewWithoutPromptError extends Error {
  constructor(
    message = 'status="review" is the human\'s needs-input queue and needs a question to answer. ' +
      'Call ask_human(...) — it moves the task to review for you — or, if you are only reporting ' +
      'progress or handing off finished work, use post_comment(...) and leave the task at ' +
      'status="doing" (or "done" if it is complete).',
  ) {
    super(message);
    this.name = 'ReviewWithoutPromptError';
  }
}

/**
 * Thrown when something enters `review` with no pending prompt AND nothing
 * for the human to act on — no description, no comment. See
 * `assertMayEnterReview`.
 */
export class ReviewWithoutContextError extends Error {
  constructor(
    message = 'status="review" is the human\'s needs-input queue and needs something for them to ' +
      'act on — this task has no pending question, no description, and no comment explaining why ' +
      'it needs a look. Call ask_human(...) for a real question, or give it context first: set a ' +
      'description of what to check, or post_comment(...) with the reason, then move it to review.',
  ) {
    super(message);
    this.name = 'ReviewWithoutContextError';
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
  if (f.deep && (f.parentId === null || f.parentId === undefined)) {
    // Deep query: no parent constraint at all, so the other filters match
    // anywhere in the accessible tree. `accessibleIds` still bounds it, so
    // this widens depth, never visibility.
  } else if (f.parentId === null) {
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
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.position), asc(tasks.createdAt));
  // An empty list is the SUCCESS shape, so a hidden parentId reads as "that
  // subtree is empty" rather than as a failure. Checked only when the answer is
  // already empty — a caller assigned a child of an unreachable parent still
  // gets its rows, exactly as before. See assertFilterIdNotHidden.
  if (rows.length === 0 && typeof f.parentId === 'string') {
    await assertFilterIdNotHidden(ctx, f.parentId);
  }
  return rows;
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
    WITH RECURSIVE ${accessibleTasksCte(ctx.userId)}
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
    recurrenceMode: (r as unknown as { recurrence_mode: Task['recurrenceMode'] }).recurrence_mode,
    goalId: (r as unknown as { goal_id: string | null }).goal_id,
    milestoneId: (r as unknown as { milestone_id: string | null }).milestone_id,
    progressPct: (r as unknown as { progress_pct: number | null }).progress_pct,
    occurrenceDate: (r as unknown as { occurrence_date: number | null }).occurrence_date,
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
  const [children, attachments, prompts, comments] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(and(inArray(tasks.id, accessibleIds), eq(tasks.parentId, id)))
      .orderBy(asc(tasks.position), asc(tasks.createdAt)),
    listAttachments(ctx, id),
    listPromptsForTask(ctx, id),
    listCommentsForTask(ctx, id),
  ]);
  return { ...row, children, attachments, prompts, comments };
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
  // Walk the tree from rootId, but only across rows accessible to ctx.
  const db = getDb();
  const result = await db.all<{ id: string }>(sql`
    WITH RECURSIVE ${accessibleTasksCte(ctx.userId)},
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

/**
 * Validates a Focus goal link before it's written. `goalId` must be an
 * accessible task with kind='goal'; `milestoneId` must be a direct child of
 * that goal (a goal's path nodes ARE its direct children, in sibling order —
 * node state is derived, never stored). Null links are always valid: a task
 * with no goal is a "specific" task, which is a legitimate state.
 */
async function assertValidGoalLink(
  ctx: Context,
  goalId: string | null,
  milestoneId: string | null,
): Promise<void> {
  if (goalId !== null) {
    const goal = await assertAccessibleExists(ctx, goalId);
    if (goal.kind !== 'goal') {
      throw new Error(
        `goalId must reference a task with kind="goal" — "${goal.title}" is kind="${goal.kind}".`,
      );
    }
  }
  if (milestoneId !== null) {
    if (goalId === null) {
      throw new Error('milestoneId requires goalId — a milestone is a direct child of the goal.');
    }
    const milestone = await assertAccessibleExists(ctx, milestoneId);
    if (milestone.parentId !== goalId) {
      throw new Error(
        `milestoneId must be a DIRECT child of the goal task (the goal's path nodes are its direct children) — "${milestone.title}" is not a direct child of ${goalId}.`,
      );
    }
  }
}

export async function createTask(ctx: Context, input: CreateTaskInput): Promise<Task> {
  const parsed = createTaskInputSchema.parse(input);
  const db = getDb();

  // A brand-new task can't have a pending prompt or a comment yet, so an
  // agent can NEVER satisfy the prompt rule on the create path: a task born
  // in review is by construction the prompt-less parking `updateTask` blocks.
  // The description is not a substitute here — a finished-deliverable report
  // always has one, and that is exactly the card this rule exists to keep out
  // of the queue. (Measured on prod 2026-09-09: create_task(status="review")
  // with a description was accepted while the identical update_task was
  // rejected.) Humans and rule-off agents are held to the context floor only:
  // created straight into review, a task's only possible context is its own
  // description. Same floor as assertMayEnterReview: no context in, no review.
  if (parsed.status === 'review') {
    const caller = await findUserById(ctx.userId);
    if (isAgentCall(ctx, caller) && (await isAgentRuleEnabled('review_requires_prompt'))) {
      throw new ReviewWithoutPromptError();
    }
    const description = parsed.description ?? null;
    if (description === null || description.trim().length === 0) {
      throw new ReviewWithoutContextError();
    }
  }

  const parentId = parsed.parentId ?? null;
  // Inherited owner: a child of a parent shared with me lives in the
  // parent's owner's tree, so collaborators see each other's additions.
  let ownerId = ctx.userId;
  if (parentId !== null) {
    const parent = await assertAccessibleExists(ctx, parentId);
    ownerId = parent.userId;
  }

  if (parsed.goalId !== undefined || parsed.milestoneId !== undefined) {
    await assertValidGoalLink(ctx, parsed.goalId ?? null, parsed.milestoneId ?? null);
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
    recurrenceMode: parsed.recurrenceMode ?? 'checkbox',
    goalId: parsed.goalId ?? null,
    milestoneId: parsed.milestoneId ?? null,
    progressPct: parsed.progressPct ?? null,
    occurrenceDate: null,
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

/**
 * Guards the transition into `review`, the human's unified "needs your input"
 * queue (surfaced as a worked card in Focus). Agents were setting it
 * directly to park finished deliverables and status notes there, so most of
 * the queue had nothing to answer (19 of 28 review tasks on one sampled
 * day). An agent now reaches review through `ask_human`, which posts a real
 * question and moves the task itself — unless `review_requires_prompt` is
 * turned off, in which case an agent can still enter review directly.
 *
 * Either way, entering without a pending prompt still needs SOME context —
 * a description or at least one existing comment — for both agents (rule
 * off) and humans (moving something to review from the web UI with nothing
 * on it). A bare task with nothing attached isn't "needs your input", it's
 * an accident: it lands as a Focus card with no question and no way to know
 * why it's there.
 */
async function assertMayEnterReview(
  ctx: Context,
  taskId: string,
  patch: Pick<UpdateTaskInput, 'description'>,
  existing: Task,
): Promise<void> {
  if (await hasPendingPrompt(taskId)) return;

  const caller = await findUserById(ctx.userId);
  if (isAgentCall(ctx, caller) && (await isAgentRuleEnabled('review_requires_prompt'))) {
    throw new ReviewWithoutPromptError();
  }

  const description = patch.description !== undefined ? patch.description : existing.description;
  if (description !== null && description.trim().length > 0) return;
  const comments = await listCommentsForTask(ctx, taskId);
  if (comments.length > 0) return;
  throw new ReviewWithoutContextError();
}

/**
 * Thrown when an agent tries to complete a task whose human gate it skipped:
 * either its own question is still pending (the human hasn't spoken), or its
 * last question was withdrawn by the agent itself via cancel_prompt. Guards
 * the exit side of review the way ReviewWithoutPromptError guards the entry.
 */
export class HumanGateSkippedError extends Error {
  constructor(
    message = 'This task cannot be marked done by you: your question to the human was never ' +
      'answered (it is still pending, or you cancelled it yourself). Wait for the answer, ' +
      're-ask with ask_human(...), or leave the task at status="doing" with a post_comment(...) ' +
      'so the human can close it.',
  ) {
    super(message);
    this.name = 'HumanGateSkippedError';
  }
}

async function assertAgentMayComplete(ctx: Context, taskId: string): Promise<void> {
  const caller = await findUserById(ctx.userId);
  if (!isAgentCall(ctx, caller)) return;
  const db = getDb();
  const asked = await db
    .select({
      status: agentPrompts.status,
      answeredByUserId: agentPrompts.answeredByUserId,
      createdAt: agentPrompts.createdAt,
    })
    .from(agentPrompts)
    .where(and(eq(agentPrompts.taskId, taskId), eq(agentPrompts.askedByUserId, ctx.userId)))
    .orderBy(desc(agentPrompts.createdAt))
    .limit(1);
  const last = asked[0];
  if (!last) return;
  // Pending: the human hasn't answered. Cancelled by the asker itself: the
  // withdrawal path (cancelPrompt) — either way, no human resolved the ask.
  if (last.status === 'pending') throw new HumanGateSkippedError();
  if (last.status === 'cancelled' && last.answeredByUserId === ctx.userId) {
    throw new HumanGateSkippedError();
  }
}

export async function updateTask(
  ctx: Context,
  id: string,
  patch: UpdateTaskInput,
): Promise<Task> {
  const parsed = updateTaskInputSchema.parse(patch);
  const existing = await assertAccessibleExists(ctx, id);

  // Only the transition into review is guarded: a task already sitting in
  // review can still be patched (title, notes, assignee) without re-proving
  // it has a pending question.
  if (parsed.status === 'review' && existing.status !== 'review') {
    await assertMayEnterReview(ctx, id, parsed, existing);
  }

  // The mirror-image guard on the way out: an agent may not complete a task
  // whose human ask it left pending or withdrew itself.
  if (parsed.status === 'done' && existing.status !== 'done') {
    await assertAgentMayComplete(ctx, id);
  }

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

  if (parsed.recurrenceMode !== undefined) update.recurrenceMode = parsed.recurrenceMode;
  if (parsed.progressPct !== undefined) update.progressPct = parsed.progressPct;

  if (parsed.goalId !== undefined || parsed.milestoneId !== undefined) {
    const nextGoalId = parsed.goalId !== undefined ? parsed.goalId : existing.goalId;
    const nextMilestoneId =
      parsed.milestoneId !== undefined
        ? parsed.milestoneId
        : // Re-linking or clearing the goal invalidates a milestone that wasn't
          // re-stated — drop it rather than leave it dangling under the old goal.
          nextGoalId === existing.goalId
          ? existing.milestoneId
          : null;
    await assertValidGoalLink(ctx, nextGoalId, nextMilestoneId);
    update.goalId = nextGoalId;
    update.milestoneId = nextMilestoneId;
  }

  if (parsed.status !== undefined) {
    // Checkbox recurring tasks roll forward instead of completing: when marked
    // 'done', log the completion (so history survives the roll) then bump dueAt
    // to the next occurrence and stay 'open'. Deliverable templates aren't
    // completed directly (their spawned instances are), so they complete
    // normally if ever ticked.
    if (
      parsed.status === 'done' &&
      existing.recurrence &&
      existing.recurrenceMode !== 'deliverable'
    ) {
      await db.insert(taskCompletions).values({
        id: nanoid(12),
        taskId: id,
        userId: existing.userId,
        completedByUserId: ctx.userId,
        occurrenceAt: existing.dueAt ?? ts,
        completedAt: ts,
        source: existing.source,
      });
      const nextDue = nextOccurrence(existing.dueAt ?? ts, existing.recurrence);
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
