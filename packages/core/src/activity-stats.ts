import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { getAccessibleTaskIds } from './access.js';
import { agentPrompts, tasks, type Task } from './schema.js';

/**
 * Tasks that have a pending prompt raised by `agentId` — the "waiting on a
 * human" set behind the Waiting count in getAgentActivity. Scoped to what the
 * caller can see. Used by the Activity → Agents drill-down.
 */
export async function listTasksWaitingOnHuman(ctx: Context, agentId: string): Promise<Task[]> {
  const accessible = await getAccessibleTaskIds(ctx);
  if (accessible.length === 0) return [];
  const db = getDb();
  const promptTaskIds = await db
    .selectDistinct({ taskId: agentPrompts.taskId })
    .from(agentPrompts)
    .where(
      and(
        eq(agentPrompts.status, 'pending'),
        eq(agentPrompts.askedByUserId, agentId),
        inArray(agentPrompts.taskId, accessible),
      ),
    );
  const ids = promptTaskIds.map((r) => r.taskId);
  if (ids.length === 0) return [];
  return db.select().from(tasks).where(inArray(tasks.id, ids));
}

/**
 * Tasks assigned to `agentId` that were completed today (Israel time) — the
 * drill-down behind the "Done today" column. Scoped to what the caller sees.
 */
export async function listTasksCompletedToday(ctx: Context, agentId: string): Promise<Task[]> {
  const accessible = await getAccessibleTaskIds(ctx);
  if (accessible.length === 0) return [];
  const todayStart = startOfDayInTz(Date.now(), TZ);
  const db = getDb();
  return db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.id, accessible),
        eq(tasks.assigneeId, agentId),
        sql`${tasks.completedAt} >= ${todayStart}`,
      ),
    );
}

/**
 * Per-agent productivity snapshot for the Activity → Agents view. Everything is
 * scoped to the tasks the caller can see (owned + shared subtrees).
 *
 * Attribution note: getshit has no per-action audit log, so "what an agent did"
 * is reconstructed from the two signals that carry an agent identity —
 * `task_comments.author_user_id` (a timestamped action) and `tasks.completed_at`
 * on tasks assigned to the agent. The status snapshot and "waiting" count come
 * from `tasks.assignee_id` and pending `agent_prompts.asked_by_user_id`.
 */
export type AgentActivityRow = {
  id: string;
  name: string | null;
  /** Actions (agent comments + tasks completed) in each window. */
  today: number;
  yesterday: number;
  last7d: number;
  /** Tasks the agent completed today (subset of `today`), broken out on its own. */
  completedToday: number;
  /** Current snapshot of tasks assigned to this agent. */
  open: number;
  doing: number;
  review: number;
  /** Pending prompts this agent raised — it is blocked waiting on a human. */
  waiting: number;
};

export type ActivityStats = {
  /** Counts across all visible non-archived tasks, keyed by status. */
  overall: Record<string, number>;
  agents: AgentActivityRow[];
  generatedAt: number;
};

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
const TZ = 'Asia/Jerusalem';

export async function getAgentActivity(
  ctx: Context,
  opts: { now?: number } = {},
): Promise<ActivityStats> {
  const now = opts.now ?? Date.now();
  const todayStart = startOfDayInTz(now, TZ);
  const yesterdayStart = startOfDayInTz(todayStart - 1, TZ);
  const sevenStart = startOfDayInTz(now - 6 * DAY, TZ); // last 7 calendar days incl. today

  const ids = await getAccessibleTaskIds(ctx);
  if (ids.length === 0) return { overall: {}, agents: [], generatedAt: now };
  const db = getDb();
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

  // Agent identities.
  const agentRows = await db.all<{ id: string; name: string | null }>(
    sql`SELECT id, name FROM users WHERE kind = 'agent'`,
  );
  const agentIds = new Set(agentRows.map((a) => a.id));
  const nameById = new Map(agentRows.map((a) => [a.id, a.name]));

  // Every visible task, minimal columns — cheap to aggregate in JS.
  const taskRows = await db.all<{
    status: string;
    assignee_id: string | null;
    completed_at: number | null;
  }>(sql`SELECT status, assignee_id, completed_at FROM tasks WHERE id IN (${idList})`);

  // Agent comments in the last 7 days (each row = one timestamped action).
  const commentRows = await db.all<{ aid: string; created_at: number }>(
    sql`SELECT author_user_id AS aid, created_at FROM task_comments
        WHERE source = 'agent' AND created_at >= ${sevenStart} AND task_id IN (${idList})`,
  );

  // Pending prompts an agent raised → it is waiting on a human answer.
  const promptRows = await db.all<{ aid: string; n: number }>(
    sql`SELECT asked_by_user_id AS aid, COUNT(*) AS n FROM agent_prompts
        WHERE status = 'pending' AND task_id IN (${idList})
        GROUP BY asked_by_user_id`,
  );

  // Checkbox-recurring completions (task rolled forward, so no completed_at on
  // the task) come from the completion log — count them like real completions.
  const completionRows = await db.all<{ aid: string; completed_at: number }>(
    sql`SELECT completed_by_user_id AS aid, completed_at FROM task_completions
        WHERE completed_at >= ${sevenStart} AND task_id IN (${idList})`,
  );

  const overall: Record<string, number> = {};
  type Acc = AgentActivityRow;
  const rowFor = new Map<string, Acc>();
  const ensure = (id: string): Acc => {
    let r = rowFor.get(id);
    if (!r) {
      r = { id, name: nameById.get(id) ?? null, today: 0, yesterday: 0, last7d: 0, completedToday: 0, open: 0, doing: 0, review: 0, waiting: 0 };
      rowFor.set(id, r);
    }
    return r;
  };

  for (const t of taskRows) {
    if (t.status !== 'archived') overall[t.status] = (overall[t.status] ?? 0) + 1;
    const aid = t.assignee_id;
    if (aid && agentIds.has(aid)) {
      const r = ensure(aid);
      if (t.status === 'open') r.open++;
      else if (t.status === 'doing') r.doing++;
      else if (t.status === 'review') r.review++;
      // Completions count as an action in their window.
      if (t.completed_at != null) {
        if (t.completed_at >= todayStart) { r.today++; r.last7d++; r.completedToday++; }
        else if (t.completed_at >= yesterdayStart) { r.yesterday++; r.last7d++; }
        else if (t.completed_at >= sevenStart) { r.last7d++; }
      }
    }
  }

  for (const c of commentRows) {
    if (!agentIds.has(c.aid)) continue;
    const r = ensure(c.aid);
    if (c.created_at >= todayStart) { r.today++; r.last7d++; }
    else if (c.created_at >= yesterdayStart) { r.yesterday++; r.last7d++; }
    else if (c.created_at >= sevenStart) { r.last7d++; }
  }

  for (const c of completionRows) {
    if (!agentIds.has(c.aid)) continue;
    const r = ensure(c.aid);
    if (c.completed_at >= todayStart) { r.today++; r.last7d++; r.completedToday++; }
    else if (c.completed_at >= yesterdayStart) { r.yesterday++; r.last7d++; }
    else if (c.completed_at >= sevenStart) { r.last7d++; }
  }

  for (const p of promptRows) {
    if (!agentIds.has(p.aid)) continue;
    ensure(p.aid).waiting = Number(p.n);
  }

  const agents = [...rowFor.values()]
    .filter((r) => r.last7d + r.open + r.doing + r.review + r.waiting > 0)
    .sort((a, b) => b.last7d - a.last7d || b.open + b.doing - (a.open + a.doing) || (a.name ?? '').localeCompare(b.name ?? ''));

  return { overall, agents, generatedAt: now };
}
