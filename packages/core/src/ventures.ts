/**
 * The ventures floor (/office → 🏢 VENTURES). One plate per venture answering
 * a single question: is this thing running today? It is a heartbeat monitor,
 * not a task list — Joel's ask was "less about the tasks pending, more about
 * knowing that this is running and ongoing stuff is happening".
 *
 * A venture is an entity/project root that owns a `📕 … charter` child. That
 * marker already exists in the tree, so there is no registry to maintain and
 * personal/internal roots (Accounting, General, Examples…) self-exclude.
 *
 * Health ladder:
 *   motion on the subtree today                    → live
 *   no motion, but an owning agent stood up today  → warn  (alive, off-board)
 *   staffed and silent ≥2 days                     → crit
 *   no staffed function, by decision               → parked (grey, never nags)
 * The warn rung is the point: Jerry & Joel showed zero board motion for a week
 * while Newman clocked in daily — his output was landing somewhere else. That
 * is "attending" rather than "running", and it must not read the same as dead.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { agentPrompts, agentProfiles, taskComments, taskCompletions, tasks, users } from './schema.js';
import { DEFAULT_TZ } from './recurrence.js';
import { getFleetHeartbeats, heartbeatFor, startOfDayInTz } from './office.js';
import { setPriority, updateTask } from './tasks.js';

const DAY = 86_400_000;
/** Days of history behind each plate's sparkline. */
export const PULSE_DAYS = 7;

export type VentureHealth = 'live' | 'warn' | 'crit' | 'parked';

/** How urgently a health state deserves a look — crit (silent/stuck) first, parked last. */
const URGENCY: Record<VentureHealth, number> = { crit: 3, warn: 2, live: 1, parked: 0 };

export type VentureLane = {
  name: string;
  /** Owning agent as written in the charter, or null when the lane is a gap. */
  owner: string | null;
  /** Lane still waiting on a decision/owner (⏳ in the charter). */
  gap: boolean;
  /** Lane parked behind a dead box or blocked dependency (💤). */
  dormant: boolean;
};

export type VenturePulse = {
  entityId: string;
  title: string;
  charterTaskId: string | null;
  /** Parent venture when this is a sub-venture, else null. */
  parentId: string | null;
  /** Sub-ventures nested one level in; empty for leaves. */
  subVentures: VenturePulse[];
  /** Agent actions on the subtree today. */
  today: number;
  /** Oldest → newest, length PULSE_DAYS, last entry = today. */
  week: number[];
  /** Timestamp of the most recent agent action, or null. */
  last: number | null;
  staffedFunctions: number;
  gaps: number;
  /** Plate subtitle, e.g. "6 staffed · 2 gaps". */
  note: string;
  health: VentureHealth;
  /** Pending decisions on this venture's subtree — same "→ JOEL gate" count the room shows. */
  gateCount: number;
  /** The venture's top goal, if any is tracked — same derivation as the room. */
  goalTitle: string | null;
  goalPct: number | null;
  /** Manual control from the charter's `## Speed:` line — FULL if unset. */
  speed: VentureSpeed;
  /** User-set rank among top-level ventures (lower = higher). null = unranked, sorts last. */
  priority: number | null;
};

export type VentureSpeed = 'RUSH' | 'FULL' | 'CRUISE' | 'HOLD';

/** RUSH jumps the whole floor's queue, above even a crit venture — the only
 * Speed tier that changes sort order by itself (HOLD's demotion already
 * falls out of forcing health to 'parked', so it needs no separate rank). */
const SPEED_RANK: Record<VentureSpeed, number> = { RUSH: 1, FULL: 0, CRUISE: 0, HOLD: 0 };

/**
 * Manual override, not an activity signal — a human sets this to say "jump
 * the queue" (RUSH), "stop nagging me about this one" (HOLD), or dial it
 * back (CRUISE), independent of what the subtree is actually doing. Parses
 * `## Speed: RUSH|FULL|CRUISE|HOLD` — a heading, not a field, because
 * charters are markdown. Defaults FULL.
 */
export function parseVentureSpeed(description: string): VentureSpeed {
  const m = /^#{2,3}\s*Speed:\s*(RUSH|FULL|CRUISE|HOLD)\s*$/im.exec(description);
  return (m?.[1]?.toUpperCase() as VentureSpeed | undefined) ?? 'FULL';
}

/**
 * Sets the venture's Speed control by rewriting the `## Speed: …` line in
 * its charter (inserting one right after the North star section if the
 * charter never had one). This is the one place a human/agent can override
 * the otherwise fully-derived health ladder.
 */
export async function setVentureSpeed(ctx: Context, entityId: string, speed: VentureSpeed): Promise<void> {
  const ventures = await listVentures();
  const venture = ventures.find((v) => v.entityId === entityId);
  if (!venture || !venture.charterTaskId) {
    throw new Error(`"${entityId}" is not a venture with a charter — nothing to set Speed on.`);
  }
  const line = `## Speed: ${speed}`;
  const body = venture.charterBody;
  const next = /^#{2,3}\s*Speed:\s*(RUSH|FULL|CRUISE|HOLD)\s*$/im.test(body)
    ? body.replace(/^#{2,3}\s*Speed:\s*(RUSH|FULL|CRUISE|HOLD)\s*$/im, line)
    : `${body.trimEnd()}\n\n${line}\n`;
  await updateTask(ctx, venture.charterTaskId, { description: next });
}

/**
 * Nudges a venture's priority rank up or down relative to its siblings (top-
 * level ventures compete with each other; a sub-venture competes only with
 * its own siblings under the same department). Reuses `setPriority` — the
 * same renumber-in-order primitive Today's drag-reorder already uses — so
 * this is the general task-priority column, not a new venture-only field.
 * A no-op at either end of the list.
 */
export async function bumpVenturePriority(
  ctx: Context,
  entityId: string,
  direction: 'up' | 'down',
): Promise<void> {
  const ventures = await listVentures();
  const target = ventures.find((v) => v.entityId === entityId);
  if (!target) throw new Error(`"${entityId}" is not a venture.`);
  const siblings = ventures.filter((v) => v.parentId === target.parentId);
  const ids = siblings
    .slice()
    .sort(
      (a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity) || a.title.localeCompare(b.title),
    )
    .map((v) => v.entityId);
  const idx = ids.indexOf(entityId);
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= ids.length) return;
  [ids[idx], ids[swapWith]] = [ids[swapWith]!, ids[idx]!];
  await setPriority(ctx, ids);
}

/**
 * Lanes from a venture charter. Accepts both section names in use — the
 * staffed ventures write "## The production line …", the ones still being
 * defined write "## Function map" — and matches on prefix because the real
 * headings carry trailing notes ("— lanes + standing WORK ORDERS", dates…).
 *
 * Lane grammar: `- **NAME** — owner (\`charterId\`): detail`, where an owner of
 * `⏳ …` means the lane is a declared gap awaiting Joel.
 */
export function parseVentureLanes(description: string): VentureLane[] {
  const lines = description.split('\n');
  let inSection = false;
  const lanes: VentureLane[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^#{2,3}\s+(.+)$/.exec(line);
    if (heading) {
      const h = heading[1]!.toLowerCase();
      inSection = h.startsWith('the production line') || h.startsWith('function map');
      continue;
    }
    if (!inSection) continue;
    if (!line.startsWith('- ')) continue;
    const body = line.slice(2).trim();
    const nameMatch = /^\*\*(.+?)\*\*/.exec(body);
    if (!nameMatch) continue;
    // Strip a leading "Support: " style qualifier from the label.
    const name = nameMatch[1]!.replace(/^[^A-Za-z0-9]+/, '').trim();
    const rest = body.slice(nameMatch[0].length);
    const gap = rest.includes('⏳');
    const dormant = rest.includes('💤');
    let owner: string | null = null;
    if (!gap) {
      // "— owner (`id`): detail" → owner
      const own = /^\s*[—–-]\s*([^(:]+)/.exec(rest);
      const candidate = own?.[1]?.trim() ?? '';
      owner = candidate.length > 0 && !candidate.startsWith('⏳') ? candidate : null;
    }
    lanes.push({ name, owner, gap, dormant });
  }
  return lanes;
}

export type VentureNode = {
  entityId: string;
  title: string;
  charterTaskId: string | null;
  charterBody: string;
  /** Parent venture id when nested under another entity. */
  parentId: string | null;
  /** User-set rank (lower = higher priority), same column/semantics as any other task — see `setPriority`. */
  priority: number | null;
};

/**
 * Every venture node, flat.
 *
 * Two ways to qualify, because the two levels are named differently in the
 * tree:
 *  - a **top-level venture** owns a `📕 … charter` child (department or
 *    venture charter) and sits at the root;
 *  - a **sub-venture** is simply an `entity` nested inside another venture —
 *    a charter is optional, because a venture idea earns its charter later.
 *
 * That is the whole definition of a sub-entity: kind=entity whose parent is
 * also an entity. Nothing new stored, and personal/internal roots stay out
 * because they carry no charter.
 */
export async function listVentures(): Promise<VentureNode[]> {
  const db = getDb();
  const charters = await db
    .select({ id: tasks.id, parentId: tasks.parentId, description: tasks.description })
    .from(tasks)
    .where(sql`${tasks.title} LIKE '%📕%' AND ${tasks.parentId} IS NOT NULL`);

  // One charter per venture — a root carrying duplicates (mvps did) renders once.
  const charterByRoot = new Map<string, { id: string; description: string | null }>();
  for (const c of [...charters].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!charterByRoot.has(c.parentId!)) {
      charterByRoot.set(c.parentId!, { id: c.id, description: c.description });
    }
  }

  const entities = await db
    .select({ id: tasks.id, title: tasks.title, parentId: tasks.parentId, priority: tasks.priority })
    .from(tasks)
    .where(eq(tasks.kind, 'entity'));
  const entityIds = new Set(entities.map((e) => e.id));

  const nodes: VentureNode[] = [];
  for (const e of entities) {
    const nested = e.parentId !== null && entityIds.has(e.parentId);
    const charter = charterByRoot.get(e.id);
    // Top level must be chartered; nested entities qualify on nesting alone.
    if (!nested && !charter) continue;
    nodes.push({
      entityId: e.id,
      title: e.title,
      charterTaskId: charter?.id ?? null,
      charterBody: charter?.description ?? '',
      parentId: nested ? e.parentId : null,
      priority: e.priority,
    });
  }
  return nodes.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * The whole ventures floor. Two subtree-tagged recursive CTEs regardless of
 * venture count, so this stays cheap enough for the engine's 60s poll.
 */
export async function getVenturePulse(
  ctx: Context,
  opts: { now?: number; tz?: string } = {},
): Promise<VenturePulse[]> {
  void ctx; // admin-gated at the route
  const db = getDb();
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? DEFAULT_TZ;
  const todayStart = startOfDayInTz(now, tz);
  const windowStart = todayStart - (PULSE_DAYS - 1) * DAY;

  const ventures = await listVentures();
  if (ventures.length === 0) return [];
  const rootIds = ventures.map((v) => v.entityId);

  // Motion = actions by AGENT users on the venture's subtree. Joel's own
  // clicks are not the venture running; they are him attending to it.
  const rootList = sql.join(
    rootIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const subtree = sql`
    WITH RECURSIVE tree(id, root) AS (
      SELECT id, id FROM tasks WHERE id IN (${rootList})
      UNION
      SELECT t.id, tr.root FROM tasks t JOIN tree tr ON t.parent_id = tr.id
    )`;

  const commentRows = (await db.all(sql`
    ${subtree}
    SELECT tr.root AS root, c.created_at AS at
    FROM task_comments c
    JOIN tree tr ON tr.id = c.task_id
    JOIN users u ON u.id = c.author_user_id
    WHERE u.kind = 'agent' AND c.created_at >= ${windowStart}
  `)) as { root: string; at: number }[];

  const completionRows = (await db.all(sql`
    ${subtree}
    SELECT tr.root AS root, tc.completed_at AS at
    FROM task_completions tc
    JOIN tree tr ON tr.id = tc.task_id
    JOIN users u ON u.id = tc.completed_by_user_id
    WHERE u.kind = 'agent' AND tc.completed_at >= ${windowStart}
  `)) as { root: string; at: number }[];

  // Last action can predate the window — needed to separate "quiet since
  // yesterday" (warn) from "silent for days" (crit).
  const lastRows = (await db.all(sql`
    ${subtree}
    SELECT tr.root AS root, MAX(c.created_at) AS at
    FROM task_comments c
    JOIN tree tr ON tr.id = c.task_id
    JOIN users u ON u.id = c.author_user_id
    WHERE u.kind = 'agent'
    GROUP BY tr.root
  `)) as { root: string; at: number | null }[];
  const lastByRoot = new Map(lastRows.map((r) => [r.root, r.at ?? null]));

  const buckets = new Map<string, number[]>();
  for (const id of rootIds) buckets.set(id, new Array(PULSE_DAYS).fill(0));
  const bump = (root: string, at: number) => {
    const arr = buckets.get(root);
    if (!arr) return;
    const idx = Math.floor((at - windowStart) / DAY);
    if (idx >= 0 && idx < PULSE_DAYS) arr[idx]! += 1;
    const prev = lastByRoot.get(root) ?? 0;
    if (at > prev) lastByRoot.set(root, at);
  };
  for (const r of commentRows) bump(r.root, r.at);
  for (const r of completionRows) bump(r.root, r.at);

  // Owners alive: agents scoped to this venture that posted on their own
  // charter today (the standup signal getOfficeOrg already relies on).
  const profiles = await db
    .select({ profile: agentProfiles, user: users })
    .from(agentProfiles)
    .innerJoin(users, eq(users.id, agentProfiles.userId));
  const scopedAgents = new Map<string, string[]>(); // entityId → agent ids
  for (const { profile } of profiles) {
    let scopes: string[] = [];
    try {
      scopes = profile.brainScopeTaskIds ? (JSON.parse(profile.brainScopeTaskIds) as string[]) : [];
    } catch {
      scopes = [];
    }
    for (const s of scopes) {
      if (!rootIds.includes(s)) continue;
      const list = scopedAgents.get(s) ?? [];
      list.push(profile.userId);
      scopedAgents.set(s, list);
    }
  }
  const charterByAgent = new Map(
    profiles.filter((p) => p.profile.charterTaskId).map((p) => [p.profile.userId, p.profile.charterTaskId!]),
  );
  const charterIds = [...new Set(charterByAgent.values())];
  const standupRows =
    charterIds.length > 0
      ? await db
          .select({ author: taskComments.authorUserId, taskId: taskComments.taskId })
          .from(taskComments)
          .where(
            and(
              inArray(taskComments.taskId, charterIds),
              gte(taskComments.createdAt, todayStart),
            ),
          )
      : [];
  const stoodUpToday = new Set(
    standupRows.filter((r) => charterByAgent.get(r.author) === r.taskId).map((r) => r.author),
  );

  // Gate — pending prompts ∪ review tasks per venture subtree, same dedupe as
  // the room's gateCount, batched across all ventures in two queries.
  const gatePromptRows = (await db.all(sql`
    ${subtree}
    SELECT tr.root AS root, ap.task_id AS taskId
    FROM agent_prompts ap
    JOIN tree tr ON tr.id = ap.task_id
    WHERE ap.status = 'pending'
  `)) as { root: string; taskId: string }[];
  const gateReviewRows = (await db.all(sql`
    ${subtree}
    SELECT tr.root AS root, t.id AS taskId
    FROM tasks t
    JOIN tree tr ON tr.id = t.id
    WHERE t.status = 'review'
  `)) as { root: string; taskId: string }[];
  const gateSetByRoot = new Map<string, Set<string>>();
  for (const r of [...gatePromptRows, ...gateReviewRows]) {
    const s = gateSetByRoot.get(r.root) ?? new Set<string>();
    s.add(r.taskId);
    gateSetByRoot.set(r.root, s);
  }

  // Goal — top goal per venture (most recently touched), progress from
  // milestones when it has any, else its own manual estimate. Same rule as
  // getVentureGoal, batched here instead of one call per venture.
  const goalRows = await db
    .select({
      id: tasks.id,
      parentId: tasks.parentId,
      title: tasks.title,
      progressPct: tasks.progressPct,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(inArray(tasks.parentId, rootIds), eq(tasks.kind, 'goal')));
  const goalByRoot = new Map<string, (typeof goalRows)[number]>();
  for (const g of goalRows) {
    const existing = goalByRoot.get(g.parentId!);
    if (!existing || g.updatedAt > existing.updatedAt) goalByRoot.set(g.parentId!, g);
  }
  const goalIds = [...goalByRoot.values()].map((g) => g.id);
  const milestoneRows =
    goalIds.length > 0
      ? await db.select({ parentId: tasks.parentId, status: tasks.status }).from(tasks).where(inArray(tasks.parentId, goalIds))
      : [];
  const milestonesByGoal = new Map<string, { done: number; total: number }>();
  for (const m of milestoneRows) {
    const s = milestonesByGoal.get(m.parentId!) ?? { done: 0, total: 0 };
    s.total += 1;
    if (m.status === 'done') s.done += 1;
    milestonesByGoal.set(m.parentId!, s);
  }

  const flat = ventures.map((v) => {
    const week = buckets.get(v.entityId) ?? new Array(PULSE_DAYS).fill(0);
    const today = week[PULSE_DAYS - 1] ?? 0;
    const last = lastByRoot.get(v.entityId) ?? null;
    const lanes = parseVentureLanes(v.charterBody);
    const staffedFunctions = lanes.filter((l) => !l.gap && l.owner !== null).length;
    const gaps = lanes.filter((l) => l.gap || l.owner === null).length;
    const ownersAlive = (scopedAgents.get(v.entityId) ?? []).some((id) => stoodUpToday.has(id));
    const speed = parseVentureSpeed(v.charterBody);

    let health: VentureHealth;
    // Motion outranks staffing: an idea-stage sub-venture carries no charter,
    // so it has no "staffed functions" — but if work is landing on it today it
    // is running, and must never render as parked.
    if (today > 0) health = 'live';
    else if (staffedFunctions === 0) health = 'parked';
    else if (ownersAlive) health = 'warn';
    else if (last === null || now - last >= 2 * DAY) health = 'crit';
    else health = 'warn';
    // A human said HOLD — that's a decision, not a signal, and it outranks
    // everything computed above (this venture never nags while held).
    if (speed === 'HOLD') health = 'parked';

    const noteParts = [`${staffedFunctions} staffed`];
    if (gaps > 0) noteParts.push(`${gaps} gap${gaps === 1 ? '' : 's'}`);
    if (lanes.length === 0) noteParts.length = 0;
    const note =
      speed === 'HOLD'
        ? 'held — ' + (lanes.length === 0 ? 'no production line defined yet' : noteParts.join(' · '))
        : lanes.length === 0
          ? 'no production line defined yet'
          : health === 'warn' && today === 0 && ownersAlive
            ? `${noteParts.join(' · ')} · owners in, board silent`
            : noteParts.join(' · ');

    const gateCount = gateSetByRoot.get(v.entityId)?.size ?? 0;
    const goal = goalByRoot.get(v.entityId) ?? null;
    const goalMilestones = goal ? milestonesByGoal.get(goal.id) : undefined;
    const goalPct = goal
      ? goalMilestones && goalMilestones.total > 0
        ? Math.round((goalMilestones.done / goalMilestones.total) * 100)
        : goal.progressPct
      : null;

    return {
      entityId: v.entityId,
      title: v.title,
      charterTaskId: v.charterTaskId,
      parentId: v.parentId,
      subVentures: [] as VenturePulse[],
      today,
      week,
      last,
      staffedFunctions,
      gaps,
      note,
      health,
      gateCount,
      goalTitle: goal?.title ?? null,
      goalPct,
      speed,
      priority: v.priority,
    };
  });

  // Nest one level: sub-ventures hang off their parent plate, which is the
  // zoom target. A sub-venture whose parent isn't itself a venture (its
  // parent lost its charter, say) is surfaced at the top rather than lost.
  const byId = new Map(flat.map((v) => [v.entityId, v]));
  const top: VenturePulse[] = [];
  for (const v of flat) {
    const parent = v.parentId !== null ? byId.get(v.parentId) : undefined;
    if (parent) parent.subVentures.push(v);
    else top.push(v);
  }
  // Priority order across the floor: things that need YOU first (crit, then
  // warn), then decision-pressure (gateCount), then the human's own ranking
  // (priority — same column/semantics `setPriority` already uses elsewhere),
  // alphabetical as the final tiebreak. Manual priority is a tiebreaker, not
  // an override — a silent/stuck venture never hides behind a "low priority"
  // stamp someone forgot to update.
  const byPriority = (a: VenturePulse, b: VenturePulse) =>
    SPEED_RANK[b.speed] - SPEED_RANK[a.speed] ||
    URGENCY[b.health] - URGENCY[a.health] ||
    b.gateCount - a.gateCount ||
    (a.priority ?? Infinity) - (b.priority ?? Infinity) ||
    a.title.localeCompare(b.title);
  for (const v of top) {
    v.subVentures.sort(byPriority);
    // A parked department that holds live ideas isn't parked — inherit the
    // best news from the floor below so the top plate never under-reports.
    if (v.subVentures.length > 0) {
      const rank = { live: 3, warn: 2, crit: 1, parked: 0 } as const;
      const best = v.subVentures.reduce<VentureHealth>(
        (acc, s) => (rank[s.health] > rank[acc] ? s.health : acc),
        v.health,
      );
      if (rank[best] > rank[v.health]) v.health = best;
      const n = v.subVentures.length;
      v.note = v.note === 'no production line defined yet'
        ? `${n} venture${n === 1 ? '' : 's'} inside`
        : `${v.note} · ${n} inside`;
    }
  }
  top.sort(byPriority);
  return top;
}

/** Prompts default to this estimate until an agent's askers calibrate a real one. */
const DEFAULT_PROMPT_EST_SECONDS = 60;

/**
 * The Saturation Law gauge, with the two numbers that stop it lying.
 *
 * `hours` alone is a load figure, and load is not the same as backlog. Measured
 * on the live workspace 2026-09-03 18:37 UTC: **7 pending asks totalling 435 s =
 * 0.12 h** against an 8–10 h target — a gauge reading 1.5% saturated, i.e. "the
 * human is idle, send more" — while the oldest of those decisions had been
 * waiting **27.9 hours** and was blocking a lane the whole time. Every asker had
 * obeyed the ≤120 s packaging rule, so the number was *correct* and useless.
 *
 * So the shape carries three things, not one:
 *  - `hours`  — the Saturation Law input proper (answer time, not wait time)
 *  - `items`  — the denominator. A gauge that prints 0 h should have to say
 *               whether that is "nothing waiting" or "nothing estimated".
 *  - `oldestAgeHours` — the number `hours` structurally cannot see. An ask can
 *               be 45 seconds of work and still be a day-long blockage.
 *  - `imputed` — how many rows had no `estSeconds` and were filled with the
 *               default. When this approaches `items`, `hours` is a guess.
 *
 * 2026-09-04: `oldestAgeHours` turned out to have the same blind spot one level
 * down, and it was found the same way — by measuring rather than re-reading the
 * gauge. `age` is time since `createdAt`, so it cannot tell these two apart:
 *
 *   BHhiQpHLr6A5  pending 21.5 h  openedAt = null          never served to the human
 *   UscZWokYxW3i  pending  7.8 h  openedAt = 07:50 UTC     served, read, put down
 *
 * Both print as "pending, N hours". They are opposite problems: the first is a
 * delivery failure (routing, queue depth, ordering) and is fixed by getting the
 * card in front of the human; the second is a *card* failure — too heavy to
 * answer in place, or an action masquerading as a decision — and re-delivering
 * it changes nothing. On the one answered row measured that day, openedAt →
 * answeredAt was **34 seconds**, so a card opened hours ago and still pending is
 * a deliberate deferral, not a card in flight.
 *
 *  - `seen`  — pending rows the human's queue has actually rendered
 *              (`openedAt` set; see `openPrompt` in prompts.ts, which stamps it
 *              once on first render). `items - seen` is the unseen backlog.
 *  - `oldestSeenAgeHours` — time since *open*, not since creation, for the
 *              oldest seen-and-still-unanswered row. This is the number that
 *              says "the human has looked at this and it is still here."
 *
 * Workspace-wide, like `getVenturePulse` — admin-gated at the route rather than
 * scoped to the caller. The queue this measures is the human's, and an agent's
 * own ctx.userId never matches the owner of the tasks it is asking about, so a
 * per-caller scope would return ~0 h for every agent and read permanently green.
 */
export type ReviewQueueLoad = {
  hours: number;
  items: number;
  oldestAgeHours: number;
  imputed: number;
  seen: number;
  oldestSeenAgeHours: number;
};

export async function getReviewQueueLoad(opts: { now?: number } = {}): Promise<ReviewQueueLoad> {
  const now = opts.now ?? Date.now();
  const db = getDb();
  const rows = await db
    .select({
      estSeconds: agentPrompts.estSeconds,
      createdAt: agentPrompts.createdAt,
      openedAt: agentPrompts.openedAt,
    })
    .from(agentPrompts)
    .where(eq(agentPrompts.status, 'pending'));

  let totalSeconds = 0;
  let imputed = 0;
  let seen = 0;
  let oldestCreatedAt = now;
  let oldestOpenedAt = now;
  for (const r of rows) {
    if (r.estSeconds === null || r.estSeconds === undefined) imputed++;
    totalSeconds += r.estSeconds ?? DEFAULT_PROMPT_EST_SECONDS;
    if (r.createdAt < oldestCreatedAt) oldestCreatedAt = r.createdAt;
    if (r.openedAt !== null && r.openedAt !== undefined) {
      seen++;
      if (r.openedAt < oldestOpenedAt) oldestOpenedAt = r.openedAt;
    }
  }
  return {
    hours: totalSeconds / 3600,
    items: rows.length,
    // Empty queue: no oldest item, so 0 rather than a spurious age.
    oldestAgeHours: rows.length === 0 ? 0 : (now - oldestCreatedAt) / 3_600_000,
    imputed,
    seen,
    // Same convention: no seen row means no age to report, not an age of "now".
    // Clamped because a clock skew between writer and reader must not turn a
    // freshly-opened card into a negative — a gauge that can go negative gets
    // read as broken and then ignored.
    oldestSeenAgeHours: seen === 0 ? 0 : Math.max(0, (now - oldestOpenedAt) / 3_600_000),
  };
}

/**
 * Back-compat scalar: `GET /api/office/pulse` and the web gauge already consume
 * this shape. Kept as the one-number form so adding the richer load figure is
 * additive rather than a breaking change.
 */
export async function getReviewQueueHours(): Promise<number> {
  return (await getReviewQueueLoad()).hours;
}

/* ═════════════ venture room — the factory line behind a plate ═════════════
 * D3: one machine per charter lane. State reuses the exact signals D1's
 * plate health already computes (agent action today, standup-today, box
 * heartbeat) plus the WAITING/STUCK signal getOfficeStation already uses —
 * no new derivation machinery, just applied per lane instead of per venture.
 */

export type LaneState = 'run' | 'idle' | 'stuck' | 'off';

export type VentureLaneStatus = VentureLane & {
  state: LaneState;
  /** Mandatory on every non-run state — "every non-RUN station renders its why". */
  why: string | null;
  /** Resolved via a name match against agent_profiles/users, for lane→agent nav (D4). */
  agentUserId: string | null;
  /** Agent actions (comments + completions) on this venture's subtree today. */
  today: number;
  blockedTask: { id: string; title: string } | null;
};

/** One stop on the route to a goal — a milestone is a direct child of the
 * goal task (same convention Focus Mode's goalId/milestoneId already use). */
export type GoalMilestone = {
  id: string;
  title: string;
  status: string;
  done: boolean;
  /** Blocked — a pending ask or sitting in review. The route's "stopper". */
  stopper: boolean;
  why: string | null;
};

export type VentureGoal = {
  taskId: string;
  title: string;
  /** null = nothing to compute from (no milestones, no manual estimate set). */
  progressPct: number | null;
  /** 'milestones' when derived from done/total; 'manual' from progressPct on the goal itself. */
  source: 'milestones' | 'manual' | 'none';
  milestones: GoalMilestone[];
};

export type VentureRoom = {
  entityId: string;
  title: string;
  charterTaskId: string | null;
  lanes: VentureLaneStatus[];
  gate: { count: number };
  goal: VentureGoal | null;
  speed: VentureSpeed;
  priority: number | null;
};

/**
 * The venture's top goal — a kind='goal' task sitting as a direct child of
 * the venture entity (same level as the 📕 charter). If several exist, the
 * most recently touched one wins; none is a valid, honest state (no goal
 * tracked yet), same as an empty production line.
 *
 * A goal's direct children ARE its milestones (the route) by the same
 * convention Focus Mode's goalId/milestoneId already uses. progress is
 * done/total when milestones exist; otherwise the goal's own progressPct
 * (an agent/MCP-set 0-100 estimate) when the human/agent bothered to set one.
 */
export async function getVentureGoal(entityId: string): Promise<VentureGoal | null> {
  const db = getDb();
  const goalRows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.parentId, entityId), eq(tasks.kind, 'goal')))
    .orderBy(desc(tasks.updatedAt))
    .limit(1);
  const goal = goalRows[0];
  if (!goal) return null;

  const children = await db
    .select()
    .from(tasks)
    .where(eq(tasks.parentId, goal.id))
    .orderBy(tasks.position, tasks.createdAt);

  if (children.length === 0) {
    return {
      taskId: goal.id,
      title: goal.title,
      progressPct: goal.progressPct,
      source: goal.progressPct === null ? 'none' : 'manual',
      milestones: [],
    };
  }

  const childIds = children.map((c) => c.id);
  const pending = await db
    .select({ taskId: agentPrompts.taskId, prompt: agentPrompts.prompt })
    .from(agentPrompts)
    .where(and(inArray(agentPrompts.taskId, childIds), eq(agentPrompts.status, 'pending')));
  const promptByTask = new Map(pending.map((p) => [p.taskId, p.prompt.split('\n')[0]!.slice(0, 90)]));

  const milestones: GoalMilestone[] = children.map((c) => {
    const why = promptByTask.get(c.id) ?? (c.status === 'review' ? 'waiting on Joel' : null);
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      done: c.status === 'done',
      stopper: why !== null,
      why,
    };
  });
  const doneCount = milestones.filter((m) => m.done).length;

  return {
    taskId: goal.id,
    title: goal.title,
    progressPct: Math.round((doneCount / milestones.length) * 100),
    source: 'milestones',
    milestones,
  };
}

/** All task ids in a subtree, root included. */
async function subtreeIds(rootId: string): Promise<string[]> {
  const db = getDb();
  const rows = (await db.all(sql`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM tasks WHERE id = ${rootId}
      UNION
      SELECT t.id FROM tasks t JOIN tree tr ON t.parent_id = tr.id
    )
    SELECT id FROM tree
  `)) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * pending prompts ∪ review tasks scoped to a set of task ids, deduped so one
 * ask (a review task that's IN review because of its own pending prompt)
 * never double-counts — same dedupe `getOfficeOrg`'s gold pill already uses.
 */
async function gateCount(taskIds: string[]): Promise<number> {
  if (taskIds.length === 0) return 0;
  const db = getDb();
  const promptRows = await db
    .select({ taskId: agentPrompts.taskId })
    .from(agentPrompts)
    .where(and(inArray(agentPrompts.taskId, taskIds), eq(agentPrompts.status, 'pending')));
  const reviewRows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(inArray(tasks.id, taskIds), eq(tasks.status, 'review')));
  return new Set([...promptRows.map((r) => r.taskId), ...reviewRows.map((r) => r.id)]).size;
}

export async function getVentureRoom(
  ctx: Context,
  entityId: string,
  opts: { now?: number; tz?: string } = {},
): Promise<VentureRoom | null> {
  void ctx; // admin-gated at the route
  const db = getDb();
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? DEFAULT_TZ;
  const todayStart = startOfDayInTz(now, tz);

  const ventures = await listVentures();
  const venture = ventures.find((v) => v.entityId === entityId);
  if (!venture) return null;

  const lanes = parseVentureLanes(venture.charterBody);
  const speed = parseVentureSpeed(venture.charterBody);
  const ids = await subtreeIds(entityId);
  const gate = { count: await gateCount(ids) };
  if (lanes.length === 0) {
    const goal = await getVentureGoal(entityId);
    return { entityId, title: venture.title, charterTaskId: venture.charterTaskId, lanes: [], gate, goal, speed, priority: venture.priority };
  }

  // Resolve each lane's free-text owner to a real agent — same exact-name
  // match the seed script uses against live users, so a lane owner label
  // must read verbatim as the agent's display name to link up.
  const owners = [...new Set(lanes.filter((l) => l.owner).map((l) => l.owner!))];
  const agentRows =
    owners.length > 0
      ? await db
          .select({ profile: agentProfiles, user: users })
          .from(agentProfiles)
          .innerJoin(users, eq(users.id, agentProfiles.userId))
      : [];
  const byLowerName = new Map(agentRows.map((r) => [(r.user.name ?? '').toLowerCase(), r]));

  const resolvedIds = [...new Set(agentRows.map((r) => r.profile.userId))].filter((id) =>
    owners.some((o) => byLowerName.get(o.toLowerCase())?.profile.userId === id),
  );

  const commentAgg =
    resolvedIds.length > 0
      ? await db
          .select({
            author: taskComments.authorUserId,
            todayCount: sql<number>`SUM(CASE WHEN ${taskComments.createdAt} >= ${todayStart} THEN 1 ELSE 0 END)`,
          })
          .from(taskComments)
          .where(and(inArray(taskComments.authorUserId, resolvedIds), inArray(taskComments.taskId, ids)))
          .groupBy(taskComments.authorUserId)
      : [];
  const completionAgg =
    resolvedIds.length > 0
      ? await db
          .select({
            by: taskCompletions.completedByUserId,
            todayCount: sql<number>`SUM(CASE WHEN ${taskCompletions.completedAt} >= ${todayStart} THEN 1 ELSE 0 END)`,
          })
          .from(taskCompletions)
          .where(and(inArray(taskCompletions.completedByUserId, resolvedIds), inArray(taskCompletions.taskId, ids)))
          .groupBy(taskCompletions.completedByUserId)
      : [];
  const todayByAgent = new Map<string, number>();
  for (const r of commentAgg) todayByAgent.set(r.author, Number(r.todayCount ?? 0));
  for (const r of completionAgg) {
    todayByAgent.set(r.by, (todayByAgent.get(r.by) ?? 0) + Number(r.todayCount ?? 0));
  }

  const charterByAgent = new Map(
    agentRows.filter((r) => r.profile.charterTaskId).map((r) => [r.profile.userId, r.profile.charterTaskId!]),
  );
  const charterIds = [...new Set(charterByAgent.values())];
  const standupRows =
    charterIds.length > 0
      ? await db
          .select({ author: taskComments.authorUserId, taskId: taskComments.taskId })
          .from(taskComments)
          .where(and(inArray(taskComments.taskId, charterIds), gte(taskComments.createdAt, todayStart)))
      : [];
  const stoodUpToday = new Set(
    standupRows.filter((r) => charterByAgent.get(r.author) === r.taskId).map((r) => r.author),
  );

  // STUCK: the owner has an open/doing task in this subtree with a pending
  // ask, or a task here sitting in review — the same WAITING signal a
  // station panel already shows for that agent, just subtree-scoped.
  const blockedByAgent = new Map<string, { id: string; title: string }>();
  if (resolvedIds.length > 0) {
    const pending = await db
      .select({ asker: agentPrompts.askedByUserId, taskId: agentPrompts.taskId, prompt: agentPrompts.prompt })
      .from(agentPrompts)
      .where(
        and(
          inArray(agentPrompts.askedByUserId, resolvedIds),
          inArray(agentPrompts.taskId, ids),
          eq(agentPrompts.status, 'pending'),
        ),
      )
      .orderBy(desc(agentPrompts.createdAt));
    for (const p of pending) {
      if (!blockedByAgent.has(p.asker)) {
        blockedByAgent.set(p.asker, { id: p.taskId, title: p.prompt.split('\n')[0]!.slice(0, 90) });
      }
    }
    const reviewing = await db
      .select({ id: tasks.id, assignee: tasks.assigneeId, title: tasks.title })
      .from(tasks)
      .where(and(inArray(tasks.assigneeId, resolvedIds), inArray(tasks.id, ids), eq(tasks.status, 'review')));
    for (const t of reviewing) {
      if (t.assignee && !blockedByAgent.has(t.assignee)) {
        blockedByAgent.set(t.assignee, { id: t.id, title: t.title });
      }
    }
  }

  const beats = await getFleetHeartbeats({ now });

  const laneStatuses: VentureLaneStatus[] = lanes.map((lane) => {
    const resolved = lane.owner ? byLowerName.get(lane.owner.toLowerCase()) : undefined;
    const agentUserId = resolved?.profile.userId ?? null;

    if (lane.dormant || lane.gap || !agentUserId || !resolved) {
      return {
        ...lane,
        state: 'off',
        why: lane.gap ? '⏳ awaiting owner' : lane.dormant ? '💤 dormant' : 'owner not on the fleet roster',
        agentUserId,
        today: 0,
        blockedTask: null,
      };
    }

    const hb = heartbeatFor(beats, { box: resolved.profile.box, name: resolved.user.name }, now);
    if (hb && now - hb.at > 24 * 3_600_000) {
      return {
        ...lane,
        state: 'off',
        why: `box ${hb.host} silent — box down`,
        agentUserId,
        today: 0,
        blockedTask: null,
      };
    }

    const today = todayByAgent.get(agentUserId) ?? 0;
    if (today > 0) {
      return { ...lane, state: 'run', why: null, agentUserId, today, blockedTask: null };
    }

    const blocked = blockedByAgent.get(agentUserId) ?? null;
    if (blocked) {
      return {
        ...lane,
        state: 'stuck',
        why: blocked.title,
        agentUserId,
        today,
        blockedTask: blocked,
      };
    }

    if (stoodUpToday.has(agentUserId)) {
      return { ...lane, state: 'idle', why: 'no output today', agentUserId, today, blockedTask: null };
    }

    return { ...lane, state: 'idle', why: 'no standup today', agentUserId, today, blockedTask: null };
  });

  const goal = await getVentureGoal(entityId);
  return { entityId, title: venture.title, charterTaskId: venture.charterTaskId, lanes: laneStatuses, gate, goal, speed, priority: venture.priority };
}
