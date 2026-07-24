import {
  getSubtree,
  listAssignees,
  listAttachmentsForTasks,
  listCommentsForTasks,
  listTasks,
  type Task,
  type TaskTree,
} from '@getshit/core';
import Link from 'next/link';
import { getRequestContext } from '@/lib/auth';
import { ActivityFeed, type ActivityEvent, type ActivityMedia } from '@/components/activity-feed';
import { ViewToggle } from '@/components/view-toggle';

export const dynamic = 'force-dynamic';

const MAX_EVENTS = 250;
// Two events on the same task within this window are the same edit — don't emit
// a bare "worked on" row on top of the comment/attachment that caused the bump.
const DEDUP_MS = 5_000;

function flatten(node: TaskTree): Task[] {
  const { children, ...task } = node;
  return [task as Task, ...children.flatMap(flatten)];
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const { scope } = await searchParams;
  const ctx = await getRequestContext();

  // Global feed = everything you can see; scoped feed = a project's whole
  // subtree. Archived tasks drop out so the board stays about live work.
  let tasks: Task[];
  let scopeTitle: string | null = null;
  if (scope) {
    const tree = await getSubtree(ctx, scope);
    if (tree) {
      scopeTitle = tree.title;
      tasks = flatten(tree).filter((t) => t.status !== 'archived');
    } else {
      tasks = [];
    }
  } else {
    tasks = await listTasks(ctx, { excludeStatuses: ['archived'] });
  }

  const ids = tasks.map((t) => t.id);
  const [commentsByTask, attByTask, assignees] = await Promise.all([
    listCommentsForTasks(ctx, ids),
    listAttachmentsForTasks(ctx, ids),
    listAssignees(ctx),
  ]);

  const nameById = new Map(assignees.map((a) => [a.id, { name: a.name, kind: a.kind }]));
  const titleById = new Map(tasks.map((t) => [t.id, t.title]));
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));

  const actorForTask = (t: Task): { name: string; kind: 'person' | 'agent' } => {
    const a = t.assigneeId ? nameById.get(t.assigneeId) : undefined;
    if (a) return a;
    return t.source === 'agent'
      ? { name: 'An agent', kind: 'agent' }
      : { name: 'You', kind: 'person' };
  };

  const events: ActivityEvent[] = [];

  for (const t of tasks) {
    const actor = actorForTask(t);
    // Timestamps already covered by a concrete event, so the coarse updatedAt
    // bump isn't shown twice.
    const covered: number[] = [t.createdAt];

    events.push({
      id: `${t.id}:created`,
      type: 'created',
      at: t.createdAt,
      taskId: t.id,
      taskTitle: t.title,
      taskStatus: t.status,
      actorName: actor.name,
      actorKind: actor.kind,
    });

    if (t.completedAt) {
      covered.push(t.completedAt);
      events.push({
        id: `${t.id}:completed`,
        type: 'completed',
        at: t.completedAt,
        taskId: t.id,
        taskTitle: t.title,
        taskStatus: t.status,
        actorName: actor.name,
        actorKind: actor.kind,
      });
    }

    // A generic "worked on" event only when the last touch isn't already
    // explained by creation, completion, or a comment/attachment below.
    const commentTimes = (commentsByTask.get(t.id) ?? []).map((c) => c.createdAt);
    const attTimes = (attByTask.get(t.id) ?? []).map((a) => a.createdAt);
    const nearby = [...covered, ...commentTimes, ...attTimes];
    const explained = nearby.some((ts) => Math.abs(ts - t.updatedAt) <= DEDUP_MS);
    if (!explained) {
      events.push({
        id: `${t.id}:updated`,
        type: 'updated',
        at: t.updatedAt,
        taskId: t.id,
        taskTitle: t.title,
        taskStatus: t.status,
        actorName: actor.name,
        actorKind: actor.kind,
      });
    }
  }

  for (const [taskId, list] of commentsByTask) {
    for (const c of list) {
      const who = nameById.get(c.authorUserId);
      events.push({
        id: `comment:${c.id}`,
        type: 'comment',
        at: c.createdAt,
        taskId,
        taskTitle: titleById.get(taskId) ?? '',
        taskStatus: statusById.get(taskId) ?? 'open',
        actorName: who?.name ?? (c.source === 'agent' ? 'An agent' : 'Someone'),
        actorKind: who?.kind ?? (c.source === 'agent' ? 'agent' : 'person'),
        body: c.body,
      });
    }
  }

  // Group attachments added to the same task in the same minute into one event
  // (a batch upload reads as one action, not ten rows).
  for (const [taskId, list] of attByTask) {
    const buckets = new Map<number, typeof list>();
    for (const a of list) {
      const isImage = a.mimeType.startsWith('image/');
      const isVideo = a.mimeType.startsWith('video/');
      if (!isImage && !isVideo) continue;
      const bucket = Math.floor(a.createdAt / 60_000);
      const arr = buckets.get(bucket) ?? [];
      arr.push(a);
      buckets.set(bucket, arr);
    }
    for (const [bucket, arr] of buckets) {
      const media: ActivityMedia[] = arr.map((a) => ({
        id: a.id,
        kind: a.mimeType.startsWith('image/') ? 'image' : 'video',
        url: `/api/files/${a.id}`,
        filename: a.filename,
      }));
      const at = Math.max(...arr.map((a) => a.createdAt));
      const agentAdded = arr.some((a) => a.source === 'agent');
      events.push({
        id: `att:${taskId}:${bucket}`,
        type: 'attachment',
        at,
        taskId,
        taskTitle: titleById.get(taskId) ?? '',
        taskStatus: statusById.get(taskId) ?? 'open',
        actorName: agentAdded ? 'An agent' : 'You',
        actorKind: agentAdded ? 'agent' : 'person',
        media,
      });
    }
  }

  events.sort((a, b) => b.at - a.at);
  const now = Date.now();
  const shown = events.slice(0, MAX_EVENTS);

  return (
    <div className="px-6 py-4 max-w-3xl mx-auto">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-sm font-medium whitespace-nowrap">Activity</h1>
          <span className="text-xs text-(--color-muted) tabular-nums">{shown.length}</span>
          {scope && scopeTitle && (
            <span className="flex items-baseline gap-1.5 min-w-0 text-xs text-(--color-muted)">
              ·
              <Link href={`/${scope}`} className="truncate hover:text-(--color-fg)" title={scopeTitle}>
                {scopeTitle}
              </Link>
              <Link href="/activity" className="whitespace-nowrap hover:text-(--color-fg)">
                (show all)
              </Link>
            </span>
          )}
        </div>
        <ViewToggle />
      </div>

      <ActivityFeed events={shown} now={now} />
    </div>
  );
}
