import { listAttachmentsForTasks, listTasks, type Task } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { CalendarView, type CalendarMedia } from '@/components/calendar-view';

export const dynamic = 'force-dynamic';

export default async function CalendarPage() {
  const ctx = await getRequestContext();
  // Calendar = every accessible task that has a due date. No new schema:
  // dueAt is the "planned for" date. Done stays visible (struck through),
  // archived/snoozed are hidden like everywhere else.
  const all: Task[] = await listTasks(ctx, { excludeStatuses: ['archived', 'snoozed'] });
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
      <CalendarView tasks={tasks} media={media} />
    </div>
  );
}
