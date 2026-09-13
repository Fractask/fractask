/**
 * Builds the Focus Mode card stack: every pending prompt on the user's tasks
 * becomes a prompt card, and the user's own due manual tasks become do-cards.
 * Each card carries its derived goal path (§4.3 — a goal's path nodes ARE its
 * direct children; node state is derived, never stored) and quest info (§3.5
 * — prompts whose tasks share a parent flow consecutively under that master's
 * banner). Ordering is the client's job (the sort toggle re-sorts locally);
 * cards are returned in deadline order as a sane default.
 */
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { tasks, users, type Task } from './schema.js';
import { listPendingPromptsForUser, listPromptsForTasks, type AgentPrompt } from './prompts.js';
import { listCommentsForTasks } from './comments.js';
import { getActiveSnoozes } from './focus.js';
import { DEFAULT_TZ } from './recurrence.js';

export type FocusGoalNode = {
  id: string;
  title: string;
  state: 'done' | 'current' | 'locked';
};

export type FocusGoalPath = {
  id: string;
  title: string;
  nodes: FocusGoalNode[];
  /** The node this card's task advances (milestone or containing child), if known. */
  activeNodeId: string | null;
  /** Nearest company / venture (kind=entity) ancestor — shown with the goal. */
  entity: { id: string; title: string } | null;
};

export type FocusQuestInfo = {
  masterId: string;
  masterTitle: string;
  /** First line of the master task's description. */
  context: string | null;
  step: number;
  of: number;
};

export type FocusVenture = { id: string; title: string; kind: 'entity' | 'project' };

export type FocusPromptCard = {
  kind: 'prompt';
  id: string;
  prompt: AgentPrompt;
  task: Task;
  askerName: string;
  askerIsAgent: boolean;
  goal: FocusGoalPath | null;
  quest: FocusQuestInfo | null;
  estSeconds: number;
  goalPriority: number | null;
  /** Entity ancestor chain, root venture first, nearest sub-venture last. */
  ventures: FocusVenture[];
};

export type FocusFrom = {
  id: string;
  name: string;
  isAgent: boolean;
};

export type FocusDoCard = {
  kind: 'do';
  id: string;
  task: Task;
  goal: FocusGoalPath | null;
  estSeconds: number;
  goalPriority: number | null;
  /** Who assigned or last asked on this task — so Focus can show "X asked you". */
  from: FocusFrom | null;
  /** Entity ancestor chain, root venture first, nearest sub-venture last. */
  ventures: FocusVenture[];
};

export type FocusReviewCard = {
  kind: 'review';
  id: string;
  task: Task;
  goal: FocusGoalPath | null;
  estSeconds: number;
  goalPriority: number | null;
  /** Who last touched this task before it landed in review, if knowable. */
  from: FocusFrom | null;
  /** Entity ancestor chain, root venture first, nearest sub-venture last. */
  ventures: FocusVenture[];
};

export type FocusCard = FocusPromptCard | FocusDoCard | FocusReviewCard;

export type FocusStack = {
  cards: FocusCard[];
  /** Cards parked by a short snooze (≤1h) — they rejoin the stack on expiry. */
  snoozed: { count: number; nextBackAt: number | null };
  generatedAt: number;
};

/** Legacy prompts carry no estimate; assume one minute. */
export const DEFAULT_PROMPT_EST_SECONDS = 60;
/** Manual tasks carry no estimate either; assume ten minutes. */
export const DEFAULT_DO_EST_SECONDS = 600;

const DAY = 86_400_000;

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

/**
 * Resolve every task's governing goal: the explicit goalId when set, else the
 * nearest ancestor with kind='goal' (implicit link inside a goal subtree).
 * Ancestors are fetched in batched waves, one query per tree level.
 */
async function resolveGoals(
  seed: Task[],
): Promise<{ goalIdByTask: Map<string, string | null>; taskById: Map<string, Task> }> {
  const db = getDb();
  const taskById = new Map<string, Task>();
  for (const t of seed) taskById.set(t.id, t);

  // Fetch ancestor chains breadth-first until every chain hits a root.
  let frontier = [
    ...new Set(
      seed
        .map((t) => t.parentId)
        .filter((p): p is string => p !== null && !taskById.has(p)),
    ),
  ];
  for (let depth = 0; depth < 50 && frontier.length > 0; depth++) {
    const rows = await db.select().from(tasks).where(inArray(tasks.id, frontier));
    for (const r of rows) taskById.set(r.id, r);
    frontier = [
      ...new Set(
        rows
          .map((r) => r.parentId)
          .filter((p): p is string => p !== null && !taskById.has(p)),
      ),
    ];
  }

  const goalIdByTask = new Map<string, string | null>();
  for (const t of seed) {
    if (t.goalId !== null) {
      goalIdByTask.set(t.id, t.goalId);
      continue;
    }
    // Walk up: a goal ancestor links implicitly, and an ancestor's explicit
    // goalId cascades too (a quest master linked cross-tree covers its steps).
    let goal: string | null = null;
    let cur: Task | undefined = t;
    for (let hops = 0; hops < 50 && cur; hops++) {
      if (cur.kind === 'goal' && cur.id !== t.id) {
        goal = cur.id;
        break;
      }
      if (cur.goalId !== null && cur.id !== t.id) {
        goal = cur.goalId;
        break;
      }
      cur = cur.parentId !== null ? taskById.get(cur.parentId) : undefined;
    }
    goalIdByTask.set(t.id, goal);
  }
  return { goalIdByTask, taskById };
}

function firstLine(text: string | null): string | null {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim() : null;
}

export async function buildFocusStack(
  ctx: Context,
  opts: {
    now?: number;
    tz?: string;
    /**
     * true = "all mine": every open/doing task assigned to the user becomes a
     * do-card regardless of due date, so regular tasks flow through the same
     * Focus cards. Default (false) keeps the original spec scope: due today.
     */
    allMine?: boolean;
  } = {},
): Promise<FocusStack> {
  const db = getDb();
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? DEFAULT_TZ;
  const todayEnd = startOfDayInTz(now, tz) + DAY;

  // --- prompt cards: every pending prompt on the user's own tasks ---
  const prompts = await listPendingPromptsForUser(ctx);
  const promptTaskIds = [...new Set(prompts.map((p) => p.taskId))];
  const promptTasks =
    promptTaskIds.length > 0
      ? await db.select().from(tasks).where(inArray(tasks.id, promptTaskIds))
      : [];
  const promptTaskById = new Map(promptTasks.map((t) => [t.id, t]));

  // --- do-cards: my own manual tasks with nothing pending on them ---
  const doTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.assigneeId, ctx.userId),
        eq(tasks.userId, ctx.userId),
        inArray(tasks.status, ['open', 'doing']),
        eq(tasks.kind, 'task'),
        ...(opts.allMine ? [] : [lte(tasks.dueAt, todayEnd - 1)]),
      ),
    );
  const withPendingPrompt = new Set(prompts.map((p) => p.taskId));
  const doable = doTasks.filter(
    (t) =>
      !withPendingPrompt.has(t.id) &&
      // deliverable templates spawn instances; the instance is the do-card
      !(t.recurrence !== null && t.recurrenceMode === 'deliverable'),
  );

  // --- review-cards: tasks parked in review with nothing pending on them.
  // A human can move any task to review freely (no ask_human required), and
  // an agent can too when the review_requires_prompt rule is off — those
  // tasks carry no prompt at all, so they'd otherwise be invisible to Focus
  // even though they're sitting in the human's "needs your input" queue.
  const reviewTasksRaw = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.reviewerId, ctx.userId), eq(tasks.status, 'review')));
  const reviewable = reviewTasksRaw.filter((t) => !withPendingPrompt.has(t.id));

  // --- goals for every card task ---
  const cardTasks = [
    ...promptTasks.filter((t) => t.status !== 'archived' && t.status !== 'done'),
    ...doable,
    ...reviewable,
  ];
  const { goalIdByTask, taskById } = await resolveGoals(cardTasks);

  const goalIds = [
    ...new Set([...goalIdByTask.values()].filter((g): g is string => g !== null)),
  ];
  const goalRows = goalIds.filter((id) => taskById.has(id)).map((id) => taskById.get(id)!);
  const missingGoalIds = goalIds.filter((id) => !taskById.has(id));
  if (missingGoalIds.length > 0) {
    const rows = await db.select().from(tasks).where(inArray(tasks.id, missingGoalIds));
    for (const r of rows) {
      taskById.set(r.id, r);
      goalRows.push(r);
    }
  }
  // Walk each goal's parents so the venture/entity banner has a name even
  // when the card task is linked via goalId instead of living in the subtree.
  let entityFrontier = [
    ...new Set(
      goalRows
        .map((g) => g.parentId)
        .filter((p): p is string => p !== null && !taskById.has(p)),
    ),
  ];
  for (let depth = 0; depth < 50 && entityFrontier.length > 0; depth++) {
    const rows = await db.select().from(tasks).where(inArray(tasks.id, entityFrontier));
    for (const r of rows) taskById.set(r.id, r);
    entityFrontier = [
      ...new Set(
        rows
          .map((r) => r.parentId)
          .filter((p): p is string => p !== null && !taskById.has(p)),
      ),
    ];
  }
  const nodeRows =
    goalIds.length > 0
      ? await db
          .select()
          .from(tasks)
          .where(inArray(tasks.parentId, goalIds))
          .orderBy(tasks.position, tasks.createdAt)
      : [];
  const nodesByGoal = new Map<string, Task[]>();
  for (const n of nodeRows) {
    const list = nodesByGoal.get(n.parentId!) ?? [];
    list.push(n);
    nodesByGoal.set(n.parentId!, list);
  }

  function goalPathFor(task: Task): FocusGoalPath | null {
    const goalId = goalIdByTask.get(task.id) ?? null;
    if (goalId === null) return null;
    const goal = taskById.get(goalId);
    if (!goal) return null;
    const children = nodesByGoal.get(goalId) ?? [];
    let currentSeen = false;
    const nodes: FocusGoalNode[] = children.map((c) => {
      const done = c.status === 'done' || c.status === 'archived';
      let state: FocusGoalNode['state'];
      if (done) state = 'done';
      else if (!currentSeen) {
        state = 'current';
        currentSeen = true;
      } else state = 'locked';
      return { id: c.id, title: c.title, state };
    });
    // Which node does this task advance? Explicit milestone wins; else the
    // direct child of the goal on this task's ancestor chain (itself included).
    let activeNodeId: string | null = task.milestoneId;
    if (activeNodeId === null) {
      let cur: Task | undefined = task;
      for (let hops = 0; hops < 50 && cur; hops++) {
        if (cur.parentId === goalId) {
          activeNodeId = cur.id;
          break;
        }
        cur = cur.parentId !== null ? taskById.get(cur.parentId) : undefined;
      }
    }
    function entityFrom(start: Task | undefined): { id: string; title: string } | null {
      let cur: Task | undefined = start;
      for (let hops = 0; hops < 50 && cur; hops++) {
        if (cur.kind === 'entity') return { id: cur.id, title: cur.title };
        cur = cur.parentId !== null ? taskById.get(cur.parentId) : undefined;
      }
      return null;
    }

    return {
      id: goal.id,
      title: goal.title,
      nodes,
      activeNodeId,
      entity: entityFrom(goal) ?? entityFrom(task),
    };
  }

  /**
   * Venture/project ancestor chain for a card, root venture first (entities
   * are ventures/sub-ventures; projects add one more pickable level). Same
   * precedence as the goal banner's entity: the goal's chain when it has one
   * (cross-tree goalId links live under the venture via the goal), else the
   * task's own.
   */
  function ventureChainFrom(start: Task | undefined): FocusVenture[] {
    const chain: FocusVenture[] = [];
    let cur: Task | undefined = start;
    for (let hops = 0; hops < 50 && cur; hops++) {
      if (cur.kind === 'entity' || cur.kind === 'project') {
        chain.push({ id: cur.id, title: cur.title, kind: cur.kind });
      }
      cur = cur.parentId !== null ? taskById.get(cur.parentId) : undefined;
    }
    return chain.reverse();
  }

  function venturesFor(task: Task): FocusVenture[] {
    const goalId = goalIdByTask.get(task.id) ?? null;
    const viaGoal = goalId !== null ? ventureChainFrom(taskById.get(goalId)) : [];
    return viaGoal.length > 0 ? viaGoal : ventureChainFrom(task);
  }

  // --- quests: prompt cards whose tasks share a parent flow as one group ---
  const promptCardsRaw = prompts
    .map((p) => ({ prompt: p, task: promptTaskById.get(p.taskId) }))
    .filter((x): x is { prompt: AgentPrompt; task: Task } => {
      return x.task !== undefined && x.task.status !== 'archived' && x.task.status !== 'done';
    });
  const byParent = new Map<string, { prompt: AgentPrompt; task: Task }[]>();
  for (const x of promptCardsRaw) {
    if (x.task.parentId === null) continue;
    const list = byParent.get(x.task.parentId) ?? [];
    list.push(x);
    byParent.set(x.task.parentId, list);
  }
  const masterIds = [...byParent.entries()].filter(([, v]) => v.length >= 2).map(([k]) => k);
  const masterById = new Map<string, Task>();
  for (const id of masterIds) {
    const known = taskById.get(id);
    if (known) masterById.set(id, known);
  }
  const unknownMasters = masterIds.filter((id) => !masterById.has(id));
  if (unknownMasters.length > 0) {
    const rows = await db.select().from(tasks).where(inArray(tasks.id, unknownMasters));
    for (const r of rows) masterById.set(r.id, r);
  }

  const questByPrompt = new Map<string, FocusQuestInfo>();
  for (const masterId of masterIds) {
    const master = masterById.get(masterId);
    if (!master) continue;
    // A quest is a deliberately SPLIT ask — its master is the task that was
    // split. Structural containers don't qualify: a goal, or a goal's direct
    // child (a path node), naturally collects unrelated sibling asks, and
    // banner-ing those as "Quest · step 1 of N" reads as nonsense.
    if (master.kind === 'goal') continue;
    const masterParent = master.parentId !== null ? taskById.get(master.parentId) : undefined;
    if (masterParent?.kind === 'goal') continue;
    const members = [...byParent.get(masterId)!].sort(
      (a, b) => a.task.position - b.task.position || a.task.createdAt - b.task.createdAt,
    );
    members.forEach((m, i) => {
      questByPrompt.set(m.prompt.id, {
        masterId,
        masterTitle: master.title,
        context: firstLine(master.description),
        step: i + 1,
        of: members.length,
      });
    });
  }

  // --- who asked: prompt askers + do-card/review-card origin (latest prompt or agent comment) ---
  const originIds = [...doable, ...reviewable].map((t) => t.id);
  const [commentsByTask, promptsOnOrigins] = await Promise.all([
    listCommentsForTasks(ctx, originIds),
    listPromptsForTasks(ctx, originIds),
  ]);

  const fromIdByDo = new Map<string, string>();
  for (const task of [...doable, ...reviewable]) {
    const history = promptsOnOrigins.get(task.id) ?? [];
    const latestAsk = [...history].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latestAsk) {
      fromIdByDo.set(task.id, latestAsk.askedByUserId);
      continue;
    }
    const comments = commentsByTask.get(task.id) ?? [];
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i]!.source === 'agent') {
        fromIdByDo.set(task.id, comments[i]!.authorUserId);
        break;
      }
    }
  }

  const askerIds = [
    ...new Set([
      ...prompts.map((p) => p.askedByUserId),
      ...fromIdByDo.values(),
    ]),
  ];
  const askerRows =
    askerIds.length > 0
      ? await db.select().from(users).where(inArray(users.id, askerIds))
      : [];
  const askerById = new Map(askerRows.map((u) => [u.id, u]));

  function fromOf(userId: string | undefined): FocusFrom | null {
    if (!userId) return null;
    const u = askerById.get(userId);
    if (!u) return { id: userId, name: 'someone', isAgent: false };
    return {
      id: u.id,
      name: u.name ?? u.email ?? 'someone',
      isAgent: u.kind === 'agent',
    };
  }

  const cards: FocusCard[] = [];
  for (const { prompt, task } of promptCardsRaw) {
    const goal = goalPathFor(task);
    const asker = askerById.get(prompt.askedByUserId);
    cards.push({
      kind: 'prompt',
      id: prompt.id,
      prompt,
      task,
      askerName: asker?.name ?? asker?.email ?? 'agent',
      askerIsAgent: asker?.kind === 'agent',
      goal,
      quest: questByPrompt.get(prompt.id) ?? null,
      estSeconds: prompt.estSeconds ?? DEFAULT_PROMPT_EST_SECONDS,
      goalPriority: goal ? (taskById.get(goal.id)?.priority ?? null) : null,
      ventures: venturesFor(task),
    });
  }
  for (const task of doable) {
    const goal = goalPathFor(task);
    cards.push({
      kind: 'do',
      id: task.id,
      task,
      goal,
      estSeconds: DEFAULT_DO_EST_SECONDS,
      goalPriority: goal ? (taskById.get(goal.id)?.priority ?? null) : null,
      from: fromOf(fromIdByDo.get(task.id)),
      ventures: venturesFor(task),
    });
  }
  for (const task of reviewable) {
    const goal = goalPathFor(task);
    cards.push({
      kind: 'review',
      id: task.id,
      task,
      goal,
      estSeconds: DEFAULT_PROMPT_EST_SECONDS,
      goalPriority: goal ? (taskById.get(goal.id)?.priority ?? null) : null,
      from: fromOf(fromIdByDo.get(task.id)),
      ventures: venturesFor(task),
    });
  }

  // Default order: deadline (nulls last), then oldest first — the client
  // re-sorts per the user's toggle and glues quest groups together.
  cards.sort((a, b) => {
    const da = a.task.dueAt ?? Number.MAX_SAFE_INTEGER;
    const db_ = b.task.dueAt ?? Number.MAX_SAFE_INTEGER;
    if (da !== db_) return da - db_;
    return a.task.createdAt - b.task.createdAt;
  });

  // Snoozed cards sit out until their (≤1h) timer expires.
  const snoozes = await getActiveSnoozes(ctx, now);
  const visible = cards.filter((c) => !snoozes.has(c.id));
  const parkedUntils = cards
    .filter((c) => snoozes.has(c.id))
    .map((c) => snoozes.get(c.id)!);

  return {
    cards: visible,
    snoozed: {
      count: parkedUntils.length,
      nextBackAt: parkedUntils.length > 0 ? Math.min(...parkedUntils) : null,
    },
    generatedAt: now,
  };
}
