/**
 * Fractask Go — the simple surface, as a thin composition over the tree.
 *
 * Nothing here is a new concept. A venture is an entity with a 📕 charter
 * child (same as the Office). Its goal is the kind='goal' child; the route
 * to the goal is the goal's direct children (same as Focus Mode). Speed is
 * the charter's `## Speed:` line (same as the Office controls). Priority is
 * `tasks.priority`. Agents are agent users with a charter task and an
 * agent_profiles row (same as the fleet). This module only chooses defaults,
 * scopes everything to the signed-in user, and gives each thing one verb.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { agentProfiles, agentPrompts, cliTokens, taskShares, tasks, users, type Task } from './schema.js';
import { assertAccessibleExists } from './access.js';
import { createTask, listTasks, setPriority, updateTask } from './tasks.js';
import { createUser, createAgentCliToken, findUserById, listCliTokens, revokeCliToken } from './auth.js';
import { shareTaskWithUserId, unshareTask } from './shares.js';
import {
  getVentureGoal,
  parseVentureSpeed,
  setVentureSpeed,
  type GoalMilestone,
  type VentureGoal,
  type VentureSpeed,
} from './ventures.js';
import {
  AGENT_TEMPLATES,
  findAgentTemplate,
  renderAgentCharter,
  type AgentTemplate,
  type AgentTemplateKey,
} from './agent-templates.js';
import type { VenturePlan } from './staff-manager.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** The three controls the simple surface exposes. Cruise stays in the full app. */
export type GoPace = 'push' | 'go' | 'hold';

export function paceFromSpeed(speed: VentureSpeed): GoPace {
  if (speed === 'RUSH') return 'push';
  if (speed === 'HOLD') return 'hold';
  return 'go';
}
export function speedFromPace(pace: GoPace): VentureSpeed {
  if (pace === 'push') return 'RUSH';
  if (pace === 'hold') return 'HOLD';
  return 'FULL';
}

export type GoVentureCard = {
  entityId: string;
  title: string;
  concept: string;
  charterTaskId: string | null;
  pace: GoPace;
  /** 0-based rank among the user's ventures (lower = first). */
  rank: number;
  goal: VentureGoal | null;
  /** Milestone the venture is standing on: first not-done stop. */
  current: GoalMilestone | null;
  /** Things waiting on the human inside this venture (asks + reviews). */
  waiting: number;
  teamCount: number;
  /** Last touch anywhere in the subtree. */
  lastActivityAt: number | null;
};

export type GoMilestone = GoalMilestone & {
  state: 'done' | 'current' | 'locked';
  tasks: Task[];
  tasksDone: number;
  ownerName: string | null;
};

export type GoTeamMember = {
  agentId: string;
  name: string;
  roleLine: string;
  emoji: string;
  templateKey: AgentTemplateKey | null;
  charterTaskId: string | null;
  charterBody: string;
  lastSeenAt: number | null;
  tokenCount: number;
  tasksOpen: number;
  tasksDone: number;
};

export type GoMap = {
  entityId: string;
  title: string;
  concept: string;
  charterTaskId: string | null;
  pace: GoPace;
  rank: number;
  rankOf: number;
  goal: (Omit<VentureGoal, 'milestones'> & { milestones: GoMilestone[] }) | null;
  kpis: Task[];
  waiting: number;
  team: GoTeamMember[];
  /** Tasks under the entity that aren't on the route (loose work). */
  looseOpen: number;
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const CHARTER_MARK = '📕';

async function subtreeIds(rootId: string): Promise<string[]> {
  const rows = (await getDb().all(sql`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM tasks WHERE id = ${rootId}
      UNION
      SELECT t.id FROM tasks t JOIN tree tr ON t.parent_id = tr.id
    )
    SELECT id FROM tree
  `)) as { id: string }[];
  return rows.map((r) => r.id);
}

/** pending asks ∪ review tasks in a subtree, deduped (same rule as the Office gate). */
async function waitingCount(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const db = getDb();
  const promptRows = await db
    .select({ taskId: agentPrompts.taskId })
    .from(agentPrompts)
    .where(and(inArray(agentPrompts.taskId, ids), eq(agentPrompts.status, 'pending')));
  const reviewRows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(inArray(tasks.id, ids), eq(tasks.status, 'review')));
  return new Set([...promptRows.map((r) => r.taskId), ...reviewRows.map((r) => r.id)]).size;
}

async function charterOf(entityId: string): Promise<{ id: string; body: string } | null> {
  const rows = await getDb()
    .select({ id: tasks.id, description: tasks.description })
    .from(tasks)
    .where(and(eq(tasks.parentId, entityId), sql`${tasks.title} LIKE ${'%' + CHARTER_MARK + '%'}`))
    .orderBy(tasks.id)
    .limit(1);
  const c = rows[0];
  return c ? { id: c.id, body: c.description ?? '' } : null;
}

function conceptFrom(entity: Task, charterBody: string): string {
  const m = /^##\s*Concept\s*\n([\s\S]*?)(?:\n##|\s*$)/im.exec(charterBody);
  const c = m?.[1]?.trim();
  if (c) return c;
  return (entity.description ?? '').split('\n')[0]?.trim() ?? '';
}

function currentOf(goal: VentureGoal | null): GoalMilestone | null {
  if (!goal) return null;
  return goal.milestones.find((m) => !m.done) ?? null;
}

async function myVentureRoots(ctx: Context): Promise<Task[]> {
  const roots = await listTasks(ctx, { parentId: null, kind: 'entity', excludeStatuses: ['archived'] });
  return roots;
}

function rankSort(a: Task, b: Task): number {
  return (a.priority ?? Infinity) - (b.priority ?? Infinity) || a.createdAt - b.createdAt;
}

/* ------------------------------------------------------------------ */
/* Ventures                                                            */
/* ------------------------------------------------------------------ */

export async function listGoVentures(ctx: Context): Promise<GoVentureCard[]> {
  const roots = (await myVentureRoots(ctx)).sort(rankSort);
  const cards: GoVentureCard[] = [];
  for (const [rank, root] of roots.entries()) {
    const [charter, goal, ids] = await Promise.all([
      charterOf(root.id),
      getVentureGoal(root.id),
      subtreeIds(root.id),
    ]);
    const db = getDb();
    const [waiting, team, last] = await Promise.all([
      waitingCount(ids),
      db
        .select({ n: sql<number>`COUNT(*)` })
        .from(taskShares)
        .innerJoin(users, eq(users.id, taskShares.userId))
        .where(and(eq(taskShares.taskId, root.id), eq(users.kind, 'agent'))),
      db
        .select({ at: sql<number | null>`MAX(${tasks.updatedAt})` })
        .from(tasks)
        .where(inArray(tasks.id, ids)),
    ]);
    cards.push({
      entityId: root.id,
      title: root.title,
      concept: conceptFrom(root, charter?.body ?? ''),
      charterTaskId: charter?.id ?? null,
      pace: paceFromSpeed(parseVentureSpeed(charter?.body ?? '')),
      rank,
      goal,
      current: currentOf(goal),
      waiting,
      teamCount: Number(team[0]?.n ?? 0),
      lastActivityAt: last[0]?.at ?? null,
    });
  }
  return cards;
}

export type CreateGoVentureInput = { name: string; concept: string; goal: string };

/**
 * A venture is born with its charter (so the Office and Speed see it) and
 * its goal (so the map has somewhere to go). Nothing else.
 */
export async function createGoVenture(
  ctx: Context,
  input: CreateGoVentureInput,
): Promise<{ entityId: string; charterTaskId: string; goalId: string }> {
  const name = input.name.trim();
  const concept = input.concept.trim();
  const goal = input.goal.trim();
  if (!name) throw new Error('Give the venture a name.');
  if (!goal) throw new Error('Say what done looks like.');

  const entity = await createTask(ctx, {
    title: name,
    kind: 'entity',
    parentId: null,
    ...(concept ? { description: concept } : {}),
  });
  const charter = await createTask(ctx, {
    title: `${CHARTER_MARK} ${name} charter`,
    kind: 'project',
    parentId: entity.id,
    description: [
      `# ${name}`,
      '',
      '## North star',
      goal,
      '',
      '## Concept',
      concept || '(not written yet)',
      '',
      '## Speed: FULL',
      '',
      '## The production line',
      '',
    ].join('\n'),
  });
  const goalTask = await createTask(ctx, {
    title: goal,
    kind: 'goal',
    parentId: entity.id,
  });
  return { entityId: entity.id, charterTaskId: charter.id, goalId: goalTask.id };
}

export async function setGoPace(ctx: Context, entityId: string, pace: GoPace): Promise<void> {
  await assertAccessibleExists(ctx, entityId);
  await setVentureSpeed(ctx, entityId, speedFromPace(pace));
}

/** Reorder the user's ventures — every root the user can see, in the order given. */
export async function reorderGoVentures(ctx: Context, orderedIds: string[]): Promise<void> {
  const roots = (await myVentureRoots(ctx)).sort(rankSort);
  const known = new Set(roots.map((r) => r.id));
  const head = orderedIds.filter((id) => known.has(id));
  const tail = roots.map((r) => r.id).filter((id) => !head.includes(id));
  await setPriority(ctx, [...head, ...tail]);
}

export async function bumpGoVenture(ctx: Context, entityId: string, direction: 'up' | 'down'): Promise<void> {
  const ids = (await myVentureRoots(ctx)).sort(rankSort).map((r) => r.id);
  const i = ids.indexOf(entityId);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  await setPriority(ctx, ids);
}

/* ------------------------------------------------------------------ */
/* The map                                                             */
/* ------------------------------------------------------------------ */

export async function getGoMap(ctx: Context, entityId: string): Promise<GoMap | null> {
  const entity = await assertAccessibleExists(ctx, entityId);
  if (entity.kind !== 'entity') return null;
  const roots = (await myVentureRoots(ctx)).sort(rankSort);
  const rank = Math.max(0, roots.findIndex((r) => r.id === entityId));

  const [charter, goal, ids, kpis, team] = await Promise.all([
    charterOf(entityId),
    getVentureGoal(entityId),
    subtreeIds(entityId),
    listTasks(ctx, { parentId: entityId, kind: 'kpi', excludeStatuses: ['archived'] }),
    listGoTeam(ctx, entityId),
  ]);
  const waiting = await waitingCount(ids);

  let milestones: GoMilestone[] = [];
  if (goal) {
    let seenCurrent = false;
    milestones = await Promise.all(
      goal.milestones.map(async (m) => {
        const children = await listTasks(ctx, { parentId: m.id, excludeStatuses: ['archived'] });
        const state: GoMilestone['state'] = m.done ? 'done' : seenCurrent ? 'locked' : 'current';
        if (!m.done) seenCurrent = true;
        const owner = await ownerNameOf(m.id);
        return {
          ...m,
          why: m.why === 'waiting on Joel' ? 'waiting on you' : m.why,
          state,
          tasks: children,
          tasksDone: children.filter((c) => c.status === 'done').length,
          ownerName: owner,
        };
      }),
    );
  }

  // Loose work: open/doing tasks directly under the entity that aren't the charter/goal/kpis.
  const direct = await listTasks(ctx, { parentId: entityId, excludeStatuses: ['archived', 'done'] });
  const looseOpen = direct.filter(
    (t) => t.kind === 'task' || (t.kind === 'project' && !t.title.includes(CHARTER_MARK) && t.title !== 'Team'),
  ).length;

  return {
    entityId,
    title: entity.title,
    concept: conceptFrom(entity, charter?.body ?? ''),
    charterTaskId: charter?.id ?? null,
    pace: paceFromSpeed(parseVentureSpeed(charter?.body ?? '')),
    rank,
    rankOf: roots.length,
    goal: goal ? { ...goal, milestones } : null,
    kpis,
    waiting,
    team,
    looseOpen,
  };
}

async function ownerNameOf(milestoneId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ assigneeId: tasks.assigneeId })
    .from(tasks)
    .where(eq(tasks.id, milestoneId));
  const assigneeId = rows[0]?.assigneeId;
  if (!assigneeId) return null;
  const u = await findUserById(assigneeId);
  return u?.name ?? null;
}

/* ------------------------------------------------------------------ */
/* Plan → tree                                                         */
/* ------------------------------------------------------------------ */

export type ApplyPlanResult = {
  milestoneIds: string[];
  kpiId: string | null;
  hired: HiredAgent[];
};

/**
 * Write an approved plan under the venture: milestones as the goal's direct
 * children, tasks under each milestone (linked with goalId/milestoneId so
 * Focus draws the route), the KPI as a weekly check-in, and one hire per
 * team entry. Milestones owned by a hired role are assigned to that agent.
 */
export async function applyVenturePlan(
  ctx: Context,
  entityId: string,
  plan: VenturePlan,
  opts: { hire?: boolean } = {},
): Promise<ApplyPlanResult> {
  const entity = await assertAccessibleExists(ctx, entityId);
  const goal = await getVentureGoal(entityId);
  if (!goal) throw new Error('This venture has no goal yet.');

  const hired: HiredAgent[] = [];
  const agentByTemplate = new Map<AgentTemplateKey, HiredAgent>();
  if (opts.hire !== false) {
    for (const t of plan.team) {
      const h = await hireGoAgent(ctx, entityId, { templateKey: t.template });
      hired.push(h);
      agentByTemplate.set(t.template, h);
    }
  }

  const milestoneIds: string[] = [];
  for (const m of plan.milestones) {
    const owner = m.owner ? agentByTemplate.get(m.owner) : undefined;
    const milestone = await createTask(ctx, {
      title: m.title,
      kind: 'project',
      parentId: goal.taskId,
      goalId: goal.taskId,
      ...(owner ? { assigneeId: owner.agentId } : {}),
    });
    milestoneIds.push(milestone.id);
    for (const title of m.tasks) {
      await createTask(ctx, {
        title,
        kind: 'task',
        parentId: milestone.id,
        goalId: goal.taskId,
        milestoneId: milestone.id,
        ...(owner ? { assigneeId: owner.agentId } : {}),
      });
    }
  }

  let kpiId: string | null = null;
  if (plan.kpi) {
    const kpi = await createTask(ctx, {
      title: plan.kpi,
      kind: 'kpi',
      parentId: entity.id,
      recurrence: '1w',
      recurrenceMode: 'checkbox',
    });
    kpiId = kpi.id;
  }

  return { milestoneIds, kpiId, hired };
}

/* ------------------------------------------------------------------ */
/* Team                                                                */
/* ------------------------------------------------------------------ */

export type HiredAgent = {
  agentId: string;
  name: string;
  roleLine: string;
  emoji: string;
  templateKey: AgentTemplateKey | null;
  charterTaskId: string;
  /** Raw bearer token — shown once. */
  token: string;
};

export type HireInput = {
  templateKey?: AgentTemplateKey | null;
  name?: string;
  roleLine?: string;
  owns?: string[];
  standingDuties?: string[];
  judgmentRules?: string[];
  kpis?: string[];
  lane?: string;
};

const TEAM_TITLE = 'Team';

async function teamProjectOf(ctx: Context, entityId: string): Promise<Task> {
  const kids = await listTasks(ctx, { parentId: entityId, kind: 'project' });
  const found = kids.find((k) => k.title === TEAM_TITLE);
  if (found) return found;
  return createTask(ctx, {
    title: TEAM_TITLE,
    kind: 'project',
    parentId: entityId,
    description: 'Charters of the agents hired for this venture. Standups land as comments on each charter.',
  });
}

/** Name collisions across the workspace are fine, but two "Mason"s on one venture are confusing. */
async function uniqueNameOn(ctx: Context, entityId: string, base: string): Promise<string> {
  const team = await listGoTeam(ctx, entityId);
  const taken = new Set(team.map((m) => m.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now() % 1000}`;
}

/**
 * Hire = a user row of kind agent + a share on the venture root + a charter
 * task under Team + an agent_profiles row + a lane on the venture charter +
 * one minted token. Exactly what the fleet does by hand, in one verb.
 */
export async function hireGoAgent(ctx: Context, entityId: string, input: HireInput): Promise<HiredAgent> {
  const entity = await assertAccessibleExists(ctx, entityId);
  const template: AgentTemplate | null = input.templateKey ? findAgentTemplate(input.templateKey) : null;
  const goal = await getVentureGoal(entityId);
  const baseName = (input.name?.trim() || template?.name || 'Agent').slice(0, 60);
  const name = await uniqueNameOn(ctx, entityId, baseName);
  const roleLine = (input.roleLine?.trim() || template?.roleLine || 'Helps with the venture').slice(0, 120);
  const emoji = template?.emoji ?? '🤖';
  const lane = (input.lane?.trim() || template?.lane || roleLine.toUpperCase().slice(0, 24)).replace(/\s+/g, ' ');

  const agent = await createUser({ kind: 'agent', name });
  await shareTaskWithUserId(ctx, entityId, agent.id);

  const team = await teamProjectOf(ctx, entityId);
  const charterBody = renderAgentCharter({
    name,
    roleLine,
    ventureName: entity.title,
    goal: goal?.title ?? '(no goal set yet)',
    owns: input.owns ?? template?.owns ?? ['Whatever the human hands over'],
    standingDuties: input.standingDuties ?? template?.standingDuties ?? ['Pull the next open task and ship it.'],
    judgmentRules: input.judgmentRules ?? template?.judgmentRules ?? ['Ask before anything irreversible.'],
    kpis: input.kpis ?? template?.kpis ?? ['Tasks shipped per week'],
  });
  const charter = await createTask(ctx, {
    title: `${CHARTER_MARK} ${name} charter`,
    kind: 'project',
    parentId: team.id,
    description: charterBody,
    assigneeId: agent.id,
  });

  const db = getDb();
  const countRows = await db.select({ n: sql<number>`COUNT(*)` }).from(agentProfiles);
  await db.insert(agentProfiles).values({
    userId: agent.id,
    groupName: entity.title,
    roleLine,
    reportsTo: null,
    charterTaskId: charter.id,
    subAgents: 0,
    box: null,
    brainScopeTaskIds: JSON.stringify([entityId]),
    sort: Number(countRows[0]?.n ?? 0) + 1,
  });

  await addLane(ctx, entityId, lane, name, charter.id);
  const { token } = await createAgentCliToken(agent.id, `go:${entity.title}`);

  return {
    agentId: agent.id,
    name,
    roleLine,
    emoji,
    templateKey: template?.key ?? null,
    charterTaskId: charter.id,
    token,
  };
}

async function addLane(ctx: Context, entityId: string, lane: string, owner: string, charterId: string) {
  const charter = await charterOf(entityId);
  if (!charter) return;
  const line = `- **${lane}** — ${owner} (\`${charterId}\`)`;
  const body = charter.body;
  const heading = /^##\s+The production line.*$/im.exec(body);
  let next: string;
  if (heading) {
    const at = heading.index + heading[0].length;
    next = `${body.slice(0, at)}\n${line}${body.slice(at)}`;
  } else {
    next = `${body.trimEnd()}\n\n## The production line\n${line}\n`;
  }
  await updateTask(ctx, charter.id, { description: next });
}

async function removeLane(ctx: Context, entityId: string, charterId: string) {
  const charter = await charterOf(entityId);
  if (!charter) return;
  const lines = charter.body.split('\n').filter((l) => !l.includes(`\`${charterId}\``));
  await updateTask(ctx, charter.id, { description: lines.join('\n') });
}

export async function listGoTeam(ctx: Context, entityId: string): Promise<GoTeamMember[]> {
  await assertAccessibleExists(ctx, entityId);
  const db = getDb();
  const rows = await db
    .select({ user: users, profile: agentProfiles })
    .from(taskShares)
    .innerJoin(users, eq(users.id, taskShares.userId))
    .leftJoin(agentProfiles, eq(agentProfiles.userId, users.id))
    .where(and(eq(taskShares.taskId, entityId), eq(users.kind, 'agent')));
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.user.id);
  const [tokens, work] = await Promise.all([
    db
      .select({ userId: cliTokens.userId, last: sql<number | null>`MAX(${cliTokens.lastUsedAt})`, n: sql<number>`COUNT(*)` })
      .from(cliTokens)
      .where(inArray(cliTokens.userId, ids))
      .groupBy(cliTokens.userId),
    db
      .select({
        assigneeId: tasks.assigneeId,
        open: sql<number>`SUM(CASE WHEN ${tasks.status} IN ('open','doing','review') THEN 1 ELSE 0 END)`,
        done: sql<number>`SUM(CASE WHEN ${tasks.status} = 'done' THEN 1 ELSE 0 END)`,
      })
      .from(tasks)
      .where(and(inArray(tasks.assigneeId, ids), sql`${tasks.title} NOT LIKE ${'%' + CHARTER_MARK + '%'}`))
      .groupBy(tasks.assigneeId),
  ]);
  const tokenBy = new Map(tokens.map((t) => [t.userId, t]));
  const workBy = new Map(work.map((w) => [w.assigneeId, w]));

  const charterIds = rows.map((r) => r.profile?.charterTaskId).filter((x): x is string => !!x);
  const charters = charterIds.length
    ? await db.select({ id: tasks.id, description: tasks.description }).from(tasks).where(inArray(tasks.id, charterIds))
    : [];
  const charterBy = new Map(charters.map((c) => [c.id, c.description ?? '']));

  return rows
    .map((r) => {
      const body = r.profile?.charterTaskId ? charterBy.get(r.profile.charterTaskId) ?? '' : '';
      const template = templateFromCharter(body, r.profile?.roleLine ?? null);
      return {
        agentId: r.user.id,
        name: r.user.name ?? 'Agent',
        roleLine: r.profile?.roleLine ?? 'Agent',
        emoji: template?.emoji ?? '🤖',
        templateKey: template?.key ?? null,
        charterTaskId: r.profile?.charterTaskId ?? null,
        charterBody: body,
        lastSeenAt: tokenBy.get(r.user.id)?.last ?? null,
        tokenCount: Number(tokenBy.get(r.user.id)?.n ?? 0),
        tasksOpen: Number(workBy.get(r.user.id)?.open ?? 0),
        tasksDone: Number(workBy.get(r.user.id)?.done ?? 0),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function templateFromCharter(body: string, roleLine: string | null): AgentTemplate | null {
  const byRole = roleLine ? AGENT_TEMPLATES.find((t) => t.roleLine === roleLine) : null;
  if (byRole) return byRole;
  const first = body.split('\n')[0] ?? '';
  return AGENT_TEMPLATES.find((t) => first.includes(t.roleLine)) ?? null;
}

async function assertOnTeam(ctx: Context, entityId: string, agentId: string): Promise<GoTeamMember> {
  const team = await listGoTeam(ctx, entityId);
  const m = team.find((t) => t.agentId === agentId);
  if (!m) throw new Error('That agent is not on this venture.');
  return m;
}

/** Fire = revoke tokens, drop the share, archive the charter, forget the profile and the lane. */
export async function fireGoAgent(ctx: Context, entityId: string, agentId: string): Promise<void> {
  const m = await assertOnTeam(ctx, entityId, agentId);
  const tokens = await listCliTokens(agentId);
  for (const t of tokens) await revokeCliToken(agentId, t.id);
  if (m.charterTaskId) {
    await removeLane(ctx, entityId, m.charterTaskId);
    await updateTask(ctx, m.charterTaskId, { status: 'archived' });
  }
  await getDb().delete(agentProfiles).where(eq(agentProfiles.userId, agentId));
  await unshareTask(ctx, entityId, agentId);
}

export async function updateGoAgent(
  ctx: Context,
  entityId: string,
  agentId: string,
  patch: { name?: string; roleLine?: string; charterBody?: string },
): Promise<void> {
  const m = await assertOnTeam(ctx, entityId, agentId);
  const db = getDb();
  if (patch.name?.trim()) {
    await db.update(users).set({ name: patch.name.trim().slice(0, 60) }).where(eq(users.id, agentId));
  }
  if (patch.roleLine?.trim()) {
    await db
      .update(agentProfiles)
      .set({ roleLine: patch.roleLine.trim().slice(0, 120) })
      .where(eq(agentProfiles.userId, agentId));
  }
  if (patch.charterBody !== undefined && m.charterTaskId) {
    await updateTask(ctx, m.charterTaskId, { description: patch.charterBody });
  }
}

/** A fresh token for an agent on this venture — the old ones keep working. */
export async function mintGoAgentToken(ctx: Context, entityId: string, agentId: string): Promise<string> {
  const m = await assertOnTeam(ctx, entityId, agentId);
  const entity = await assertAccessibleExists(ctx, entityId);
  const { token } = await createAgentCliToken(m.agentId, `go:${entity.title}`);
  return token;
}

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

export type GoConnection = {
  /** Any token of the human or of an agent on their ventures used in the last 10 minutes. */
  live: boolean;
  lastSeenAt: number | null;
  tokens: { id: string; label: string | null; lastUsedAt: number | null; createdAt: number }[];
};

export async function getGoConnection(ctx: Context): Promise<GoConnection> {
  const mine = await listCliTokens(ctx.userId);
  const roots = await myVentureRoots(ctx);
  const db = getDb();
  let agentLast: number | null = null;
  if (roots.length > 0) {
    const rows = await db
      .select({ last: sql<number | null>`MAX(${cliTokens.lastUsedAt})` })
      .from(cliTokens)
      .innerJoin(taskShares, eq(taskShares.userId, cliTokens.userId))
      .where(inArray(taskShares.taskId, roots.map((r) => r.id)));
    agentLast = rows[0]?.last ?? null;
  }
  const mineLast = mine.reduce<number | null>((acc, t) => Math.max(acc ?? 0, t.lastUsedAt ?? 0) || acc, null);
  const lastSeenAt = Math.max(mineLast ?? 0, agentLast ?? 0) || null;
  return {
    live: lastSeenAt !== null && Date.now() - lastSeenAt < 10 * 60 * 1000,
    lastSeenAt,
    tokens: mine.map((t) => ({ id: t.id, label: t.label, lastUsedAt: t.lastUsedAt, createdAt: t.createdAt })),
  };
}

/** The last time a specific token was used — the connect page polls this. */
export async function tokenLastUsed(tokenId: string): Promise<number | null> {
  const rows = await getDb()
    .select({ last: cliTokens.lastUsedAt })
    .from(cliTokens)
    .where(eq(cliTokens.id, tokenId))
    .orderBy(desc(cliTokens.createdAt))
    .limit(1);
  return rows[0]?.last ?? null;
}

export function listAgentLibrary(): AgentTemplate[] {
  return AGENT_TEMPLATES;
}
