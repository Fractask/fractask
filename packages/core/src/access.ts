import { and, eq, sql } from 'drizzle-orm';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { tasks, type BrainNote, type Task } from './schema.js';

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`Task ${id} not found`);
    this.name = 'NotFoundError';
  }
}

/**
 * The one wording for "the row is there, you just can't reach it". Shared by
 * {@link NotSharedError} and get_task's `not_shared` response body so the two
 * can never drift — an agent must read the same sentence whichever tool it
 * happened to call.
 *
 * Built from one template rather than written twice: brain notes hit the exact
 * same failure and must not end up with a second, subtly different sentence.
 */
function notSharedMessage(noun: 'task' | 'note'): string {
  return (
    `This ${noun} exists but is not shared with you. ${NOT_MISSING_CLAUSE} ` +
    'Ask its owner to share it, or an admin to read it for you.'
  );
}

/**
 * The load-bearing half of every "not shared" sentence — the clause that stops
 * an agent recreating a row that is already there. Hoisted out of
 * {@link notSharedMessage} rather than repeated, because the scratchpad
 * variant below CANNOT be generated from that template: scratchpad entries
 * have no share mechanism at all, so "ask its owner to share it" would be a
 * remedy that does not exist. A template that produces a false instruction is
 * worse than a second sentence; a shared clause keeps the part that matters
 * from drifting anyway.
 */
const NOT_MISSING_CLAUSE = 'It is not missing — do not recreate it.';

export const NOT_SHARED_MESSAGE = notSharedMessage('task');
export const NOT_SHARED_NOTE_MESSAGE = notSharedMessage('note');

/**
 * Same failure, a third object type over: the scratchpad entry exists and
 * belongs to somebody else. Worded separately because the task/note remedy is
 * inapplicable here — see {@link NOT_MISSING_CLAUSE}.
 */
export const NOT_SHARED_SCRATCH_MESSAGE =
  `This scratchpad entry exists but belongs to another user. ${NOT_MISSING_CLAUSE} ` +
  'Only its owner or a workspace admin can read, file or dismiss it.';

/**
 * The row exists; this caller has no access to it.
 *
 * Deliberately a *subclass* of NotFoundError: every existing `instanceof
 * NotFoundError` handler (web server actions, the files route's 404 mapping,
 * `getNote`'s null-swallow) keeps behaving exactly as before, so this is a
 * refinement of the message rather than a new failure mode callers must learn.
 * Only the MCP error layer, which checks for it first, says anything new.
 */
export class NotSharedError extends NotFoundError {
  constructor(public readonly taskId: string) {
    super(taskId);
    this.name = 'NotSharedError';
    this.message = `Task ${taskId} not shared — ${NOT_SHARED_MESSAGE}`;
  }
}

/**
 * Same failure, one object type over: the brain note exists and this caller
 * cannot reach it.
 *
 * A *subclass of NotSharedError*, not a sibling, and that is the load-bearing
 * choice. Both MCP transports map the not_shared case with a single
 * `err instanceof NotSharedError` check placed above the NotFoundError check;
 * a sibling class would have needed that ordering rediscovered and re-asserted
 * in two more places, which is precisely the per-call-site drift this whole
 * card exists to remove. `taskId` is inherited and carries the *note* id here —
 * read `noteId` instead.
 */
export class NotSharedNoteError extends NotSharedError {
  constructor(public readonly noteId: string) {
    super(noteId);
    this.name = 'NotSharedNoteError';
    this.message = `Note ${noteId} not shared — ${NOT_SHARED_NOTE_MESSAGE}`;
  }
}

/**
 * Third object type, same rule. A *subclass of NotSharedError* for exactly the
 * reason {@link NotSharedNoteError} is: both MCP transports already test
 * `err instanceof NotSharedError` ahead of NotFoundError, so this needs no
 * third branch in either of them and cannot be missed by one and caught by the
 * other. `taskId` is inherited and carries the *scratch entry* id here — read
 * `entryId` instead.
 */
export class NotSharedScratchError extends NotSharedError {
  constructor(public readonly entryId: string) {
    super(entryId);
    this.name = 'NotSharedScratchError';
    this.message = `Scratch entry ${entryId} not shared — ${NOT_SHARED_SCRATCH_MESSAGE}`;
  }
}

export class ForbiddenError extends Error {
  // `noun` defaults to 'Task' so every pre-existing call site reads exactly as
  // before. It exists because this error is now thrown for comment ids and
  // scratch-entry ids too, and "Task <a comment id> requires owner permission"
  // is wrong on the noun — the same residual NotFoundError still carries.
  constructor(id: string, noun = 'Task') {
    super(`${noun} ${id} requires owner permission`);
    this.name = 'ForbiddenError';
  }
}

/**
 * THE access rule, in one place. Every task/note query in the codebase builds
 * its visibility from this fragment — never hand-roll the CTE again.
 *
 * A user reaches a task if they are its owner, hold a `task_shares` row for
 * it, are its assignee, or are its reviewer — plus, transitively, everything
 * under any of those. Ancestors are NOT reachable: being assigned one leaf
 * does not open up the rest of the owner's tree, it surfaces that leaf (and
 * its subtasks) as a root of your view.
 *
 * Assignee/reviewer access is *derived*, not stored: reassigning a task
 * revokes the old assignee immediately, with no share rows to clean up.
 *
 * COORDINATOR SCOPE: a user with `users.is_admin` reaches every task. This is
 * what makes a coordinator (chief-of-staff agent, operator) able to *write* to
 * any task, not just see it in an admin dashboard. Without it, admin-only
 * read tools like `office_pulse` could surface a task that `update_task` /
 * `create_comment` then rejected with NotFound — the split that stalled a
 * human answer for four days. Expressed as an EXISTS against `users` so it
 * costs no extra round-trip and every caller of this fragment (tasks and
 * notes, reads and writes) inherits it automatically.
 *
 * Emits the `roots` and `<name>` CTE bodies, without the `WITH RECURSIVE`
 * keyword, so callers can append further CTEs after it.
 */
export function accessibleTasksCte(userId: string, name = 'accessible') {
  const n = sql.raw(name);
  return sql`
    roots(id) AS (
      SELECT id FROM tasks WHERE user_id = ${userId}
      UNION
      SELECT task_id FROM task_shares WHERE user_id = ${userId}
      UNION
      SELECT id FROM tasks WHERE assignee_id = ${userId}
      UNION
      SELECT id FROM tasks WHERE reviewer_id = ${userId}
      UNION
      SELECT id FROM tasks
       WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = ${userId} AND u.is_admin = 1)
    ),
    ${n}(id) AS (
      SELECT id FROM roots
      UNION
      SELECT t.id FROM tasks t JOIN ${n} a ON t.parent_id = a.id
    )`;
}

/**
 * Returns task IDs accessible to ctx.userId. One round-trip via a recursive
 * CTE. See {@link accessibleTasksCte} for the rule.
 */
export async function getAccessibleTaskIds(ctx: Context): Promise<string[]> {
  const db = getDb();
  const rows = await db.all<{ id: string }>(sql`
    WITH RECURSIVE ${accessibleTasksCte(ctx.userId)}
    SELECT DISTINCT id FROM accessible
  `);
  return rows.map((r) => r.id);
}

/**
 * Asserts that `id` is accessible to ctx.userId, returns the row.
 *
 * Throws {@link NotSharedError} when the row exists but this caller cannot
 * reach it, and plain {@link NotFoundError} when there is no such row. Both
 * are NotFoundError to `instanceof`, so callers that only care "the read
 * failed" are unaffected; the MCP layer keys on the subclass to tell an agent
 * *which* failure it hit. Same reasoning as {@link taskVisibility}: the
 * distinction is only ever computed for an id the caller already handed us, so
 * it leaks nothing that guessing ids could exploit.
 *
 * Still one round-trip — the existence check and the access check share the CTE.
 */
export async function assertAccessibleExists(ctx: Context, id: string): Promise<Task> {
  const db = getDb();
  const rows = await db.all<Record<string, unknown>>(sql`
    WITH RECURSIVE ${accessibleTasksCte(ctx.userId)}
    SELECT t.*, (t.id IN (SELECT id FROM accessible)) AS __accessible
      FROM tasks t
     WHERE t.id = ${id}
  `);
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  if (!row['__accessible']) throw new NotSharedError(id);
  return rowToTask(row);
}

/** Why a task read came back empty. See {@link taskVisibility}. */
export type TaskVisibility =
  /** Accessible — a normal read will return it. */
  | 'visible'
  /** The row exists, but this user cannot reach it. */
  | 'hidden'
  /** No such id anywhere in the table. */
  | 'missing';

/**
 * Distinguish "you can't see this" from "this does not exist".
 *
 * Every read path deliberately collapses both cases to null/NotFound so that a
 * probe can't be used to enumerate other people's task ids. That is right for
 * the security boundary and wrong for the agent reading the answer: a bare null
 * is indistinguishable from a deleted task, so an agent sweeping a tree it is
 * only partially shared into concludes the missing pieces were never created —
 * and then "fixes" that by creating duplicates. That failure mode was observed
 * twice: a coordinator sweep nearly filed ~20 false goal-chain violations, and
 * `list_tasks(assigneeId=me)` reading `[]` made an agent believe it was idle.
 *
 * So the distinction is computed only where a *caller who already holds the id*
 * asks for it explicitly. Knowing that an id you were handed exists leaks
 * nothing you did not already have; guessing ids is still uniformly opaque
 * because every other path keeps returning NotFound.
 *
 * One round-trip: the existence check and the access check share the CTE.
 */
export async function taskVisibility(ctx: Context, id: string): Promise<TaskVisibility> {
  const db = getDb();
  const rows = await db.all<{ visible: number }>(sql`
    WITH RECURSIVE ${accessibleTasksCte(ctx.userId)}
    SELECT (t.id IN (SELECT id FROM accessible)) AS visible
      FROM tasks t
     WHERE t.id = ${id}
  `);
  const row = rows[0];
  if (!row) return 'missing';
  return row.visible ? 'visible' : 'hidden';
}

/**
 * The COLLECTION half of the not_shared rule — for tools whose answer is a
 * list, not a row.
 *
 * `assertAccessibleExists` protects tools whose *subject* is one object: they
 * fail, so there is an error to name. A list tool cannot fail that way — it
 * answers `[]`, and `[]` is the SUCCESS shape. `list_tasks(parentId=X)` gave
 * one answer to three different worlds:
 *
 * ```
 *   parentId = a task that exists, is not shared, and HAS children   ->  []
 *   parentId = an id that was never real                             ->  []
 *   parentId = a task I own that genuinely has no children           ->  []
 * ```
 *
 * The middle and last rows are honest. The first is the exact wrong conclusion
 * this whole card exists to stop — worse than `not_found: Task X not found`,
 * because it does not even report a failure: it reports *"here are the
 * children: none."* An agent reads that as "the subtree is empty" and fills it.
 *
 * Call this only AFTER the query has come back EMPTY. That ordering is
 * load-bearing, not an optimisation:
 *
 *  - Ancestors are not reachable (see {@link accessibleTasksCte}), so a caller
 *    assigned a single child of someone else's task legitimately gets rows back
 *    from `list_tasks(parentId=<that hidden parent>)` today. Guarding on the
 *    *argument* would turn that working query into an error. Guarding on the
 *    *empty result* cannot: every call that returns rows today still does.
 *  - The extra round-trip is then paid only on the answer that was about to be
 *    uninformative anyway.
 *
 * A `missing` id is deliberately left alone: it keeps returning `[]`. The
 * defect being fixed is "not shared read as not there", and after this the two
 * are distinguishable. Making an absent filter id throw would also change the
 * contract for every caller that lists the children of a just-deleted task,
 * which is a different question and not this one.
 *
 * ## ⚠️ What this guard does NOT cover, stated where it will be read
 *
 * It fires on an EMPTY result. A **filtered-but-non-empty** list stays silent —
 * by design, per the first bullet above — so the share-scoped omission is still
 * invisible on every call that returns rows. That is not a hole to plug here:
 * the point of share-scoping is that the caller cannot see the row, so there is
 * no row-level signal to emit. It is a hole in how the RESULT gets read.
 *
 * Measured 2026-09-14, by the agent writing this card's own census:
 *
 * ```
 *   list_tasks(status="review") through the MCP    11 rows
 *   select … from tasks where status='review'      12 rows
 *   omitted: one task with assigneeId = null, never shared with the caller
 * ```
 *
 * The 11 was then published as a denominator — *"11 cards sit in review"* — as
 * the argument for a decision. Same shape as the `[]` defect above and one step
 * worse to catch: `[]` at least looks like nothing, whereas a short list looks
 * like an answer. The mitigation is documentation at the call site, not code:
 * see the COUNTING paragraph on `list_tasks` in `mcp-tools.ts`, pinned by
 * "a NON-EMPTY share-scoped list omits rows silently" in `tasks.test.ts`.
 */
export async function assertFilterIdNotHidden(ctx: Context, id: string): Promise<void> {
  if ((await taskVisibility(ctx, id)) === 'hidden') throw new NotSharedError(id);
}

/** Note-side mirror of {@link assertFilterIdNotHidden}. Same empty-result-only contract. */
export async function assertNoteFilterIdNotHidden(ctx: Context, id: string): Promise<void> {
  if ((await noteVisibility(ctx, id)) === 'hidden') throw new NotSharedNoteError(id);
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

/**
 * Returns brain note IDs accessible to ctx.userId. Personal notes
 * (scope_task_id IS NULL) require ownership; scoped notes ride the task_shares
 * subtree closure of their scope task (an entity or project).
 */
export async function getAccessibleNoteIds(ctx: Context): Promise<string[]> {
  const db = getDb();
  const rows = await db.all<{ id: string }>(sql`
    WITH RECURSIVE ${accessibleTasksCte(ctx.userId)}
    SELECT id FROM brain_notes
     WHERE (scope_task_id IS NULL AND user_id = ${ctx.userId})
        OR scope_task_id IN (SELECT id FROM accessible)
  `);
  return rows.map((r) => r.id);
}

/**
 * Note-side mirror of {@link assertAccessibleExists}.
 *
 * Throws {@link NotSharedNoteError} when the note exists but this caller cannot
 * reach it, and plain {@link NotFoundError} when there is no such row.
 *
 * The old form filtered on accessibility *inside the WHERE clause*, so both
 * cases produced zero rows and it was structurally incapable of telling them
 * apart — the same defect get_task was fixed for, one object type over. The
 * accessibility predicate is now a selected column instead, which keeps this to
 * one round-trip while making the two cases distinguishable.
 */
export async function assertAccessibleNoteExists(
  ctx: Context,
  id: string,
): Promise<BrainNote> {
  const db = getDb();
  const rows = await db.all<Record<string, unknown>>(sql`
    WITH RECURSIVE ${accessibleTasksCte(ctx.userId)}
    SELECT n.*,
           ((n.scope_task_id IS NULL AND n.user_id = ${ctx.userId})
            OR n.scope_task_id IN (SELECT id FROM accessible)) AS __accessible
      FROM brain_notes n
     WHERE n.id = ${id}
  `);
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  if (!row['__accessible']) throw new NotSharedNoteError(id);
  return rowToBrainNote(row);
}

/**
 * Why a note read came back empty. Note-side mirror of {@link taskVisibility},
 * and the same reasoning applies about what it does and does not leak: it is
 * only ever computed for an id the caller already handed us.
 */
export async function noteVisibility(ctx: Context, id: string): Promise<TaskVisibility> {
  const db = getDb();
  const rows = await db.all<{ visible: number }>(sql`
    WITH RECURSIVE ${accessibleTasksCte(ctx.userId)}
    SELECT ((n.scope_task_id IS NULL AND n.user_id = ${ctx.userId})
            OR n.scope_task_id IN (SELECT id FROM accessible)) AS visible
      FROM brain_notes n
     WHERE n.id = ${id}
  `);
  const row = rows[0];
  if (!row) return 'missing';
  return row.visible ? 'visible' : 'hidden';
}

function rowToBrainNote(r: Record<string, unknown>): BrainNote {
  return {
    id: r['id'] as string,
    userId: r['user_id'] as string,
    scopeTaskId: (r['scope_task_id'] as string | null) ?? null,
    parentNoteId: (r['parent_note_id'] as string | null) ?? null,
    title: r['title'] as string,
    icon: (r['icon'] as string | null) ?? null,
    contentJson: r['content_json'] as string,
    contentText: r['content_text'] as string,
    position: r['position'] as number,
    source: r['source'] as BrainNote['source'],
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
  };
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
    recurrenceMode: (r['recurrence_mode'] as Task['recurrenceMode']) ?? 'checkbox',
    goalId: (r['goal_id'] as string | null) ?? null,
    milestoneId: (r['milestone_id'] as string | null) ?? null,
    progressPct: (r['progress_pct'] as number | null) ?? null,
    occurrenceDate: (r['occurrence_date'] as number | null) ?? null,
    priority: (r['priority'] as number | null) ?? null,
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
    completedAt: (r['completed_at'] as number | null) ?? null,
  };
}
