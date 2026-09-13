/**
 * The Office — org data for the 3D floor (/office). Everything renders from
 * the blob this module builds: agent_profiles rows joined onto live comment /
 * completion / prompt data. The shapes here ARE the engine's contract (the
 * approved mock's ORG blob); change them and the floor changes.
 *
 * Presence derivation:
 *   standup comment today on the charter        → live
 *   any activity within 2h                      → live
 *   activity within 24h (no standup)            → warn
 *   chartered (expected daily) and silent >24h  → crit
 *   activity within 3d                          → dorm
 *   otherwise                                   → off
 * Activity = comments authored by the agent (heartbeats are comments too) or
 * tasks it completed.
 *
 * Phase C hardens this with the Fleet Health heartbeats (task comments in the
 * form `HB host=<box> … agents=[a,b] auth=ok … at=<iso>`): for an agent whose
 * box heartbeats, a box silent >24h forces crit (Jibin's fleet rule), a
 * logged-out gateway caps presence at warn, and a healthy box softens
 * chartered-but-silent from crit to warn (the box is reachable, the agent is
 * merely idle).
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import {
  agentPrompts,
  agentProfiles,
  brainNotes,
  taskComments,
  taskCompletions,
  tasks,
  users,
  type AgentProfile,
  type Task,
} from './schema.js';
import { DEFAULT_TZ } from './recurrence.js';

export type OfficePresence = 'live' | 'warn' | 'crit' | 'dorm' | 'off';

export type OfficeAgent = {
  id: string;
  name: string;
  role: string;
  presence: OfficePresence;
  charter: boolean;
  /** Actions (comments + completions) in the last 7 days. */
  acts: number;
  /** Sub-agents in the same box; omitted when solo. */
  sub?: number;
  /** Short labels of things waiting on the human (floor pill = length). */
  waiting: string[];
};

export type OfficeOrg = {
  root: { name: string; role: string };
  manager: OfficeAgent | null;
  groups: { name: string; agents: OfficeAgent[] }[];
  generatedAt: number;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ═════════════════════ fleet heartbeats (phase C) ═════════════════════ */

/** The Fleet Health task every box posts heartbeat comments on. */
export const FLEET_HEALTH_TASK_ID =
  process.env.GETSHIT_FLEET_HEALTH_TASK_ID ?? 'EmHGcsv5zl3I';
const HEARTBEAT_LOOKBACK = 3 * DAY;

export type FleetHeartbeat = {
  /** Box hostname, lowercased. */
  host: string;
  /** Agent names running on the box, lowercased. */
  agents: string[];
  /** Gateway auth state — 'ok' or whatever the box reported ('loggedout'…). */
  auth: string;
  at: number;
};

/**
 * Parses one heartbeat comment. Primary format is what the fleet actually
 * posts (`HB host=<box> gw=… agents=[a,b] auth=ok errs4h=0 … at=<iso>`); the
 * `✅ <agent>@<host> <utc>` form from the Fleet Health task description is
 * accepted too. Anything else (Jibin's daily-check notes etc.) returns null.
 */
export function parseHeartbeat(body: string, fallbackAt: number): FleetHeartbeat | null {
  const line = body.trim();
  const hb = /^HB\s+host=(\S+)/.exec(line);
  if (hb) {
    const agents = /agents=\[([^\]]*)\]/.exec(line)?.[1] ?? '';
    const auth = /auth=(\S+)/.exec(line)?.[1] ?? 'ok';
    const atIso = /(?:^|\s)at=(\S+)/.exec(line)?.[1];
    const at = atIso ? Date.parse(atIso) : Number.NaN;
    return {
      host: hb[1]!.toLowerCase(),
      agents: agents
        .split(',')
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean),
      auth: auth.toLowerCase(),
      at: Number.isFinite(at) ? at : fallbackAt,
    };
  }
  const legacy = /^✅\s*(\S+)@(\S+)/.exec(line);
  if (legacy) {
    return {
      host: legacy[2]!.toLowerCase(),
      agents: [legacy[1]!.toLowerCase()],
      auth: 'ok',
      at: fallbackAt,
    };
  }
  return null;
}

/** Latest heartbeat per box from the Fleet Health task (3-day lookback). */
export async function getFleetHeartbeats(
  opts: { now?: number; fleetTaskId?: string } = {},
): Promise<FleetHeartbeat[]> {
  const db = getDb();
  const now = opts.now ?? Date.now();
  const rows = await db
    .select({ body: taskComments.body, createdAt: taskComments.createdAt })
    .from(taskComments)
    .where(
      and(
        eq(taskComments.taskId, opts.fleetTaskId ?? FLEET_HEALTH_TASK_ID),
        gte(taskComments.createdAt, now - HEARTBEAT_LOOKBACK),
      ),
    )
    .orderBy(desc(taskComments.createdAt))
    .limit(400);
  const byHost = new Map<string, FleetHeartbeat>();
  for (const r of rows) {
    const hb = parseHeartbeat(r.body, r.createdAt);
    if (hb && !byHost.has(hb.host)) byHost.set(hb.host, hb);
  }
  return [...byHost.values()];
}

/**
 * The heartbeat covering an agent — its profile box by hostname, or any box
 * whose agents list names it. Fresh beats (≤24h) win over stale ones, and
 * among fresh ones an auth=ok box wins (an agent listed on several boxes is
 * judged by the one it can actually work from).
 */
export function heartbeatFor(
  beats: FleetHeartbeat[],
  agent: { box: string | null; name: string | null },
  now: number,
): FleetHeartbeat | null {
  const box = agent.box?.toLowerCase() ?? null;
  const name = agent.name?.toLowerCase() ?? null;
  const covering = beats.filter(
    (b) => (box !== null && b.host === box) || (name !== null && b.agents.includes(name)),
  );
  if (covering.length === 0) return null;
  const rank = (b: FleetHeartbeat) =>
    (now - b.at <= DAY ? 2 : 0) + (b.auth === 'ok' ? 1 : 0);
  return covering.sort((a, b) => rank(b) - rank(a) || b.at - a.at)[0]!;
}

export function startOfDayInTz(ts: number, tz: string): number {
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

function derivePresence(opts: {
  standupToday: boolean;
  lastActivity: number | null;
  chartered: boolean;
  now: number;
  hb?: FleetHeartbeat | null;
}): OfficePresence {
  const { standupToday, lastActivity, chartered, now } = opts;
  const hb = opts.hb ?? null;
  const age = lastActivity === null ? Number.POSITIVE_INFINITY : now - lastActivity;
  // A covered box silent >24h is crit — unless the agent shows life through
  // another path (working from a different box), which caps at warn instead.
  if (hb && now - hb.at > DAY) return standupToday || age <= DAY ? 'warn' : 'crit';
  const cap = hb !== null && hb.auth !== 'ok';
  if (standupToday) return cap ? 'warn' : 'live';
  if (age <= 2 * HOUR) return cap ? 'warn' : 'live';
  if (age <= DAY) return 'warn';
  if (chartered) return hb ? 'warn' : 'crit';
  if (age <= 3 * DAY) return 'dorm';
  return 'off';
}

/**
 * The full ORG blob for the floor. Cheap enough to poll every 60s: five
 * grouped queries regardless of fleet size. Not access-scoped — the /office
 * routes gate on workspace admin before calling this.
 */
export async function getOfficeOrg(
  ctx: Context,
  opts: { now?: number; tz?: string; fleetTaskId?: string } = {},
): Promise<OfficeOrg> {
  void ctx; // admin gating happens at the route; ctx kept for future scoping
  const db = getDb();
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? DEFAULT_TZ;
  const todayStart = startOfDayInTz(now, tz);
  const week = now - 7 * DAY;

  // LEFT JOIN on purpose: a profile whose user is missing (or points at a
  // human) must show as a red "unlinked" desk, never silently shrink the floor.
  const rows = await db
    .select({ profile: agentProfiles, user: users })
    .from(agentProfiles)
    .leftJoin(users, eq(users.id, agentProfiles.userId));
  if (rows.length === 0) {
    return {
      root: { name: 'Joel', role: 'CEO · decisions land in /focus' },
      manager: null,
      groups: [],
      generatedAt: now,
    };
  }
  const agentIds = rows.map((r) => r.profile.userId);
  const charterByAgent = new Map<string, string>();
  for (const r of rows) {
    if (r.profile.charterTaskId) charterByAgent.set(r.profile.userId, r.profile.charterTaskId);
  }

  // Latest comment per agent + 7d comment counts (heartbeats are comments too).
  const commentAgg = await db
    .select({
      author: taskComments.authorUserId,
      last: sql<number>`MAX(${taskComments.createdAt})`,
      week: sql<number>`SUM(CASE WHEN ${taskComments.createdAt} >= ${week} THEN 1 ELSE 0 END)`,
    })
    .from(taskComments)
    .where(inArray(taskComments.authorUserId, agentIds))
    .groupBy(taskComments.authorUserId);
  const commentsByAgent = new Map(commentAgg.map((r) => [r.author, r]));

  // Standups: agent-authored comments on their own charter task today.
  const charterIds = [...new Set(charterByAgent.values())];
  const standupRows =
    charterIds.length > 0
      ? await db
          .select({
            author: taskComments.authorUserId,
            taskId: taskComments.taskId,
          })
          .from(taskComments)
          .where(
            and(
              inArray(taskComments.taskId, charterIds),
              inArray(taskComments.authorUserId, agentIds),
              gte(taskComments.createdAt, todayStart),
            ),
          )
      : [];
  const standupToday = new Set(
    standupRows
      .filter((r) => charterByAgent.get(r.author) === r.taskId)
      .map((r) => r.author),
  );

  // Completions per agent: latest + 7d count.
  const completionAgg = await db
    .select({
      by: taskCompletions.completedByUserId,
      last: sql<number>`MAX(${taskCompletions.completedAt})`,
      week: sql<number>`SUM(CASE WHEN ${taskCompletions.completedAt} >= ${week} THEN 1 ELSE 0 END)`,
    })
    .from(taskCompletions)
    .where(inArray(taskCompletions.completedByUserId, agentIds))
    .groupBy(taskCompletions.completedByUserId);
  const completionsByAgent = new Map(completionAgg.map((r) => [r.by, r]));

  // Waiting on the human: pending prompts the agent raised…
  const promptRows = await db
    .select({
      asker: agentPrompts.askedByUserId,
      taskId: agentPrompts.taskId,
      prompt: agentPrompts.prompt,
    })
    .from(agentPrompts)
    .where(eq(agentPrompts.status, 'pending'))
    .orderBy(desc(agentPrompts.createdAt));
  // …plus tasks assigned to the agent sitting in review. A review task whose
  // pending prompt already counts (that's WHY it's in review) is skipped so
  // one ask never shows as two pills.
  const promptedTaskIds = new Set(promptRows.map((p) => p.taskId));
  const reviewRows = await db
    .select({ id: tasks.id, assignee: tasks.assigneeId, title: tasks.title })
    .from(tasks)
    .where(and(inArray(tasks.assigneeId, agentIds), eq(tasks.status, 'review')));

  const agentIdSet = new Set(agentIds);
  const waitingByAgent = new Map<string, string[]>();
  const pushWait = (id: string | null, label: string) => {
    if (!id || !agentIdSet.has(id)) return;
    const list = waitingByAgent.get(id) ?? [];
    if (list.length < 8) list.push(label.length > 90 ? `${label.slice(0, 87)}…` : label);
    waitingByAgent.set(id, list);
  };
  for (const p of promptRows) pushWait(p.asker, p.prompt);
  for (const t of reviewRows) {
    if (!promptedTaskIds.has(t.id)) pushWait(t.assignee, t.title);
  }

  const beats = await getFleetHeartbeats({ now, ...(opts.fleetTaskId !== undefined ? { fleetTaskId: opts.fleetTaskId } : {}) });

  function toAgent(profile: AgentProfile, user: { name: string | null; kind: string } | null): OfficeAgent {
    if (!user || user.kind !== 'agent') {
      // Unlinked desk — a seed/data bug made visible instead of a silent drop.
      return {
        id: profile.userId,
        name: `⚠ ${profile.userId}`,
        role: `unlinked desk — no agent user (${profile.roleLine})`,
        presence: 'crit',
        charter: false,
        acts: 0,
        waiting: [],
      };
    }
    const comments = commentsByAgent.get(profile.userId);
    const completions = completionsByAgent.get(profile.userId);
    const lastActivity = Math.max(comments?.last ?? 0, completions?.last ?? 0) || null;
    return {
      id: profile.userId,
      name: user.name ?? profile.userId,
      role: profile.roleLine,
      presence: derivePresence({
        standupToday: standupToday.has(profile.userId),
        lastActivity,
        chartered: profile.charterTaskId !== null,
        now,
        hb: heartbeatFor(beats, { box: profile.box, name: user.name }, now),
      }),
      charter: profile.charterTaskId !== null,
      acts: Number(comments?.week ?? 0) + Number(completions?.week ?? 0),
      ...(profile.subAgents > 0 ? { sub: profile.subAgents } : {}),
      waiting: waitingByAgent.get(profile.userId) ?? [],
    };
  }

  // reportsTo NULL = the manager card (reports straight to the human).
  const managerRow =
    [...rows].sort((a, b) => a.profile.sort - b.profile.sort).find((r) => r.profile.reportsTo === null) ??
    null;
  const manager = managerRow ? toAgent(managerRow.profile, managerRow.user) : null;

  const groupMap = new Map<string, { minSort: number; agents: { sort: number; agent: OfficeAgent }[] }>();
  for (const r of rows) {
    if (managerRow && r.profile.userId === managerRow.profile.userId) continue;
    const g = groupMap.get(r.profile.groupName) ?? { minSort: Number.MAX_SAFE_INTEGER, agents: [] };
    g.minSort = Math.min(g.minSort, r.profile.sort);
    g.agents.push({ sort: r.profile.sort, agent: toAgent(r.profile, r.user) });
    groupMap.set(r.profile.groupName, g);
  }
  const groups = [...groupMap.entries()]
    .sort((a, b) => a[1].minSort - b[1].minSort)
    .map(([name, g]) => ({
      name,
      agents: g.agents.sort((a, b) => a.sort - b.sort).map((a) => a.agent),
    }));

  return {
    root: { name: 'Joel', role: 'CEO · decisions land in /focus' },
    manager,
    groups,
    generatedAt: now,
  };
}

/* ═══════════════════════ station payload (phase B) ═══════════════════════ */

/** Station payload — the shapes the engine's station scene renders from. */
export type OfficeStation = {
  id: string;
  name: string;
  role: string;
  presence: OfficePresence;
  charter: boolean;
  /** Charter "## Owns" + "## Standing duties" bullets. */
  resp: string[];
  /** Charter "## Judgment rules" + "## KPIs" bullets. */
  know: string[];
  /** Things waiting on the human (panel rows; the panel itself links to /focus). */
  waiting: string[];
  standup: { stamp: string; y: string; t: string; b: string } | null;
  /** Console tail — recent activity rendered as terminal lines. */
  screen: string[];
  /** Lines the live ticker can replay. */
  ticks: string[];
  /** Fallback line when there is no screen activity. */
  flat: string;
  /** Queue rows: [status, title, taskId]. */
  tasks: [string, string, string][];
  /** Recent rows: [status, title, when-note, bodyLines, taskId]. */
  recent: [string, string, string, string[], string][];
  /** Brain docs (charter first), body inline. */
  docs: { t: string; date: string; body: string[]; noteId?: string }[];
};

/**
 * Parses a charter description's markdown into panel bullet lists. Sections
 * are `## Heading` blocks with `- ` bullets; unknown sections are ignored so
 * charters can carry extra prose without breaking the panels.
 */
export function parseCharterSections(description: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of description.split('\n')) {
    const line = raw.trim();
    const h = /^#{2,3}\s+(.+)$/.exec(line);
    if (h) {
      current = h[1]!.trim().toLowerCase();
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    if (current && (line.startsWith('- ') || line.startsWith('* '))) {
      out.get(current)!.push(line.slice(2).trim());
    }
  }
  return out;
}

/**
 * Parses a standup comment into Y/T/B. Accepts lines led by Y/T/B (or
 * yesterday/today/blockers) with any of `—`, `-`, `:` as separator; anything
 * unparsed lands in `y` so free-form standups still display.
 */
export function parseStandup(body: string): { y: string; t: string; b: string } {
  const out = { y: '', t: '', b: '' };
  const leftover: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(y|t|b|yesterday|today|blockers?)\s*[—:-]\s*(.+)$/i.exec(line);
    if (m) {
      const key = m[1]!.toLowerCase().startsWith('y')
        ? 'y'
        : m[1]!.toLowerCase().startsWith('t')
          ? 't'
          : 'b';
      out[key] = out[key] ? `${out[key]} · ${m[2]!.trim()}` : m[2]!.trim();
    } else {
      leftover.push(line);
    }
  }
  if (!out.y && !out.t && !out.b && leftover.length > 0) {
    out.y = leftover.join(' · ').slice(0, 300);
  }
  return out;
}

function fmtStamp(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(ts))
    .replace(',', ' ·');
}

function firstLineOf(text: string, max = 88): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Direct line: the Office chat bar posts a comment on the agent's charter
 * task, authored as the human. Durable, picked up on the agent's next runner
 * poll of its charter. Throws when the agent has no charter to write on.
 */
export async function postOfficeMessage(
  ctx: Context,
  agentUserId: string,
  text: string,
): Promise<{ taskId: string; commentId: string }> {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 4000) {
    throw new Error('Message must be 1–4000 characters');
  }
  const db = getDb();
  const rows = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.userId, agentUserId));
  const profile = rows[0];
  if (!profile) throw new Error('No profile for this agent');
  if (!profile.charterTaskId) {
    throw new Error('This agent has no charter task yet — nothing durable to write on');
  }
  const { createComment } = await import('./comments.js');
  const comment = await createComment(ctx, {
    taskId: profile.charterTaskId,
    body: `📨 from the Office: ${trimmed}`,
    source: 'human',
  });
  return { taskId: profile.charterTaskId, commentId: comment.id };
}

/**
 * Wake-now: logs a durable 🔔 comment on the agent's charter and forwards the
 * request to the ops-owned webhook when `OFFICE_WAKE_WEBHOOK_URL` is set (the
 * delivery mechanism — Jibin box vs WhatsApp Cloud API — stays an ops
 * decision; this side only POSTs JSON at whatever endpoint ops points here).
 */
export async function requestOfficeWake(
  ctx: Context,
  agentUserId: string,
): Promise<{ commented: boolean; taskId: string | null; delivered: boolean; note: string }> {
  const db = getDb();
  const rows = await db
    .select({ profile: agentProfiles, user: users })
    .from(agentProfiles)
    .leftJoin(users, eq(users.id, agentProfiles.userId))
    .where(eq(agentProfiles.userId, agentUserId));
  const row = rows[0];
  if (!row) throw new Error('No profile for this agent');
  const { profile, user } = row;

  let commented = false;
  if (profile.charterTaskId) {
    const { createComment } = await import('./comments.js');
    await createComment(ctx, {
      taskId: profile.charterTaskId,
      body: '🔔 Wake requested from the Office',
      source: 'human',
    });
    commented = true;
  }

  const url = process.env.OFFICE_WAKE_WEBHOOK_URL;
  let delivered = false;
  let note: string;
  if (!url) {
    note = 'wake logged on the charter — no wake webhook configured yet';
  } else {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'wake',
          agentId: profile.userId,
          agent: user?.name ?? profile.userId,
          box: profile.box,
          charterTaskId: profile.charterTaskId,
          at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5_000),
      });
      delivered = res.ok;
      note = res.ok ? 'wake webhook delivered' : `wake webhook answered ${res.status}`;
    } catch {
      note = 'wake webhook unreachable';
    }
  }
  return { commented, taskId: profile.charterTaskId, delivered, note };
}

/** Full station payload for one agent. Admin-gated at the route. */
export async function getOfficeStation(
  ctx: Context,
  agentUserId: string,
  opts: { now?: number; tz?: string; fleetTaskId?: string } = {},
): Promise<OfficeStation | null> {
  void ctx;
  const db = getDb();
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? DEFAULT_TZ;
  const todayStart = startOfDayInTz(now, tz);

  const rows = await db
    .select({ profile: agentProfiles, user: users })
    .from(agentProfiles)
    .leftJoin(users, eq(users.id, agentProfiles.userId))
    .where(eq(agentProfiles.userId, agentUserId));
  const row = rows[0];
  if (!row) return null;
  const { profile, user } = row;
  const userName = user?.name ?? null;

  // Charter + its parsed panels.
  let charterTask: Task | null = null;
  if (profile.charterTaskId) {
    const t = await db.select().from(tasks).where(eq(tasks.id, profile.charterTaskId));
    charterTask = t[0] ?? null;
  }
  const sections = charterTask?.description
    ? parseCharterSections(charterTask.description)
    : new Map<string, string[]>();
  const resp = [...(sections.get('owns') ?? []), ...(sections.get('standing duties') ?? [])];
  const know = [...(sections.get('judgment rules') ?? []), ...(sections.get('kpis') ?? [])];

  // Today's standup = agent's latest comment on the charter today.
  let standup: OfficeStation['standup'] = null;
  if (charterTask) {
    const su = await db
      .select()
      .from(taskComments)
      .where(
        and(
          eq(taskComments.taskId, charterTask.id),
          eq(taskComments.authorUserId, agentUserId),
          gte(taskComments.createdAt, todayStart),
        ),
      )
      .orderBy(desc(taskComments.createdAt))
      .limit(1);
    if (su[0]) {
      standup = { stamp: fmtStamp(su[0].createdAt, tz), ...parseStandup(su[0].body) };
    }
  }

  // Waiting on the human (same rule as the floor pill, titles only).
  const pending = await db
    .select({ prompt: agentPrompts.prompt, taskId: agentPrompts.taskId })
    .from(agentPrompts)
    .where(and(eq(agentPrompts.askedByUserId, agentUserId), eq(agentPrompts.status, 'pending')))
    .orderBy(desc(agentPrompts.createdAt))
    .limit(8);
  const promptedIds = new Set(pending.map((p) => p.taskId));
  const inReview = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.assigneeId, agentUserId), eq(tasks.status, 'review')))
    .limit(8);
  const waiting = [
    ...pending.map((p) => firstLineOf(p.prompt)),
    ...inReview.filter((t) => !promptedIds.has(t.id)).map((t) => firstLineOf(t.title)),
  ].slice(0, 8);

  // Screen = activity tail: recent comments + completions as console lines.
  const recentComments = await db
    .select({ body: taskComments.body, createdAt: taskComments.createdAt, taskId: taskComments.taskId })
    .from(taskComments)
    .where(eq(taskComments.authorUserId, agentUserId))
    .orderBy(desc(taskComments.createdAt))
    .limit(10);
  const recentCompletions = await db
    .select({ completedAt: taskCompletions.completedAt, taskId: taskCompletions.taskId })
    .from(taskCompletions)
    .where(eq(taskCompletions.completedByUserId, agentUserId))
    .orderBy(desc(taskCompletions.completedAt))
    .limit(5);
  const titleIds = [
    ...new Set([...recentComments.map((c) => c.taskId), ...recentCompletions.map((c) => c.taskId)]),
  ];
  const titleRows =
    titleIds.length > 0
      ? await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(inArray(tasks.id, titleIds))
      : [];
  const titleById = new Map(titleRows.map((t) => [t.id, t.title]));
  const screenEvents = [
    ...recentComments.map((c) => ({
      at: c.createdAt,
      line: `$ ${firstLineOf(c.body, 64)}`,
    })),
    ...recentCompletions.map((c) => ({
      at: c.completedAt,
      line: `✓ completed — ${firstLineOf(titleById.get(c.taskId) ?? c.taskId, 56)}`,
    })),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(-8);
  const screen = screenEvents.map((e) => e.line);

  // Box status from the fleet heartbeats, as the console's last line.
  const beats = await getFleetHeartbeats({ now, ...(opts.fleetTaskId !== undefined ? { fleetTaskId: opts.fleetTaskId } : {}) });
  const hb = heartbeatFor(beats, { box: profile.box, name: userName }, now);
  if (hb) {
    const ageMs = now - hb.at;
    const ageLabel = ageMs < HOUR ? `${Math.max(1, Math.round(ageMs / 60_000))}m` : `${Math.round(ageMs / HOUR)}h`;
    screen.push(
      `▣ box ${hb.host} · hb ${ageLabel} ago · auth ${hb.auth}${ageMs > DAY ? ' — BOX SILENT' : ''}`,
    );
  }

  // Queue + recent shipped.
  const queueRows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.assigneeId, agentUserId), inArray(tasks.status, ['open', 'doing', 'review'])))
    .orderBy(desc(tasks.updatedAt))
    .limit(12);
  const doneRows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.assigneeId, agentUserId), inArray(tasks.status, ['done', 'archived'])))
    .orderBy(desc(sql`COALESCE(${tasks.completedAt}, ${tasks.updatedAt})`))
    .limit(6);

  // Brain docs: the charter first, then notes in the profile's scopes.
  const docs: OfficeStation['docs'] = [];
  if (charterTask?.description) {
    docs.push({
      t: `Charter — ${userName ?? 'agent'}`,
      date: 'charter task',
      body: charterTask.description
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, 40),
    });
  }
  let scopeIds: string[] = [];
  try {
    scopeIds = profile.brainScopeTaskIds ? (JSON.parse(profile.brainScopeTaskIds) as string[]) : [];
  } catch {
    scopeIds = [];
  }
  if (scopeIds.length > 0) {
    const notes = await db
      .select()
      .from(brainNotes)
      .where(inArray(brainNotes.scopeTaskId, scopeIds))
      .orderBy(desc(brainNotes.updatedAt))
      .limit(12);
    for (const n of notes) {
      docs.push({
        t: n.title,
        date: `brain note · ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'short', day: 'numeric' }).format(new Date(n.updatedAt))}`,
        body: n.contentText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .slice(0, 40),
        noteId: n.id,
      });
    }
  }

  // Presence, consistent with the floor.
  const lastComment = recentComments[0]?.createdAt ?? 0;
  const lastCompletion = recentCompletions[0]?.completedAt ?? 0;
  const lastActivity = Math.max(lastComment, lastCompletion) || null;
  const presence = derivePresence({
    standupToday: standup !== null,
    lastActivity,
    chartered: profile.charterTaskId !== null,
    now,
    hb,
  });

  return {
    id: profile.userId,
    name: userName ?? profile.userId,
    role: profile.roleLine,
    presence,
    charter: profile.charterTaskId !== null,
    resp,
    know,
    waiting,
    standup,
    screen,
    ticks: screen.slice(-4),
    flat:
      screen.length > 0
        ? ''
        : presence === 'off'
          ? 'no session — quiet by design'
          : 'no recent activity on record',
    tasks: queueRows.map((t) => [t.status, firstLineOf(t.title, 60), t.id]),
    recent: doneRows.map((t) => [
      t.status,
      firstLineOf(t.title, 60),
      t.completedAt
        ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'short', day: 'numeric' }).format(new Date(t.completedAt))
        : 'archived',
      t.description ? [firstLineOf(t.description, 120)] : [],
      t.id,
    ]),
    docs,
  };
}
