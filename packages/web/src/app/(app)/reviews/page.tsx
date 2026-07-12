import {
  ensureSelfAssignee,
  getTagsForTasks,
  listAttachmentsForTasks,
  listPromptsForTasks,
  listTasks,
  type Task,
} from '@getshit/core';
import Link from 'next/link';
import { getRequestContext } from '@/lib/auth';
import { TaskList } from '@/components/task-list';
import { ReviewCards, type ReviewItem } from '@/components/review-cards';

export const dynamic = 'force-dynamic';

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const asList = view === 'list';

  const ctx = await getRequestContext();
  // Reviewer = me. Self-assignee row is the canonical "me" id, generated lazily
  // on first list of /assignees. Ensure it exists so this page works zero-config.
  const me = await ensureSelfAssignee(ctx);
  const tasks: Task[] = await listTasks(ctx, { reviewerId: me.id, status: 'review' });
  const ids = tasks.map((t) => t.id);

  const [tagsByTask, promptsByTask, attByTask] = await Promise.all([
    getTagsForTasks(ctx, ids),
    listPromptsForTasks(ctx, ids),
    listAttachmentsForTasks(ctx, ids),
  ]);

  const items: ReviewItem[] = tasks.map((task) => ({
    task,
    prompts: (promptsByTask.get(task.id) ?? []).filter((p) => p.status === 'pending'),
    attachments: attByTask.get(task.id) ?? [],
  }));

  return (
    <div className="px-6 py-4 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-sm font-medium">Needs your input</h1>
          <p className="text-xs text-(--color-muted) mt-0.5">
            Approvals, agent questions, decisions · {tasks.length}
          </p>
        </div>
        <ViewToggle asList={asList} />
      </header>

      {tasks.length === 0 ? (
        <p className="text-sm text-(--color-muted) px-2 py-6 text-center">
          Nothing needs your attention right now.
        </p>
      ) : asList ? (
        <section className="flex flex-col gap-3">
          <TaskList tasks={tasks} childCounts={{}} tagsByTask={tagsByTask} showDate="updatedAt" />
        </section>
      ) : (
        <ReviewCards items={items} />
      )}
    </div>
  );
}

function ViewToggle({ asList }: { asList: boolean }) {
  const base =
    'px-2.5 py-1 text-xs cursor-pointer transition-colors';
  const on = 'bg-(--color-surface-2) text-(--color-fg)';
  const off = 'text-(--color-muted) hover:text-(--color-fg)';
  return (
    <div className="inline-flex rounded-md border border-(--color-border) overflow-hidden">
      <Link href="/reviews" className={`${base} ${asList ? off : on}`}>
        Cards
      </Link>
      <Link href="/reviews?view=list" className={`${base} ${asList ? on : off}`}>
        List
      </Link>
    </div>
  );
}
