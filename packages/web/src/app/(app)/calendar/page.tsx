import {
  getSubtree,
  listAttachmentsForTasks,
  listTasks,
  type Task,
  type TaskTree,
} from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { CalendarView, type CalendarMedia } from '@/components/calendar-view';

export const dynamic = 'force-dynamic';

function flatten(node: TaskTree): Task[] {
  const { children, ...task } = node;
  return [task as Task, ...children.flatMap(flatten)];
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const { scope } = await searchParams;
  const ctx = await getRequestContext();

  // Calendar = every task that has a due date. No new schema: dueAt is the
  // "planned for" date. With ?scope=<taskId> only that subtree shows, so any
  // project doubles as its own planning calendar. Done stays visible (struck
  // through), archived/snoozed are hidden like everywhere else.
  let all: Task[];
  let scopeTitle: string | null = null;
  if (scope) {
    const tree = await getSubtree(ctx, scope);
    if (tree) {
      scopeTitle = tree.title;
      all = flatten(tree).filter((t) => t.status !== 'archived' && t.status !== 'snoozed');
    } else {
      all = [];
    }
  } else {
    all = await listTasks(ctx, { excludeStatuses: ['archived', 'snoozed'] });
  }
  const tasks = all.filter((t) => t.dueAt != null);

  // First image (else first video) attachment per task → cell thumbnail.
  const attachmentsByTask = await listAttachmentsForTasks(ctx, tasks.map((t) => t.id));
  const media: Record<string, CalendarMedia> = {};
  for (const [taskId, list] of attachmentsByTask) {
    const img = list.find((a) => a.mimeType.startsWith('image/'));
    const vid = img ? undefined : list.find((a) => a.mimeType.startsWith('video/'));
    const pick = img ?? vid;
    if (pick) {
      media[taskId] = { kind: img ? 'image' : 'video', url: `/api/files/${pick.id}` };
    }
  }

  return (
    <div className="px-6 py-4 max-w-5xl mx-auto">
      <CalendarView
        tasks={tasks}
        media={media}
        scope={scope && scopeTitle ? { id: scope, title: scopeTitle } : null}
      />
    </div>
  );
}
