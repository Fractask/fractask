import { ensureSelfAssignee, getTagsForTasks, listTasks, type Task } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { TaskList } from '@/components/task-list';

export const dynamic = 'force-dynamic';

export default async function ReviewsPage() {
  const ctx = await getRequestContext();
  // Reviewer = me. Self-assignee row is the canonical "me" id, generated lazily
  // on first list of /assignees. Ensure it exists so this page works zero-config.
  const me = await ensureSelfAssignee(ctx);
  const tasks: Task[] = await listTasks(ctx, { reviewerId: me.id, status: 'review' });
  const tagsByTask = await getTagsForTasks(ctx, tasks.map((t) => t.id));

  return (
    <div className="px-6 py-4 max-w-4xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-sm font-medium">Needs your input</h1>
          <p className="text-xs text-(--color-muted) mt-0.5">
            Tasks waiting on you — approvals, agent questions, decisions · {tasks.length}
          </p>
        </div>
      </header>

      <section className="flex flex-col gap-3">
        {tasks.length === 0 ? (
          <p className="text-sm text-(--color-muted) px-2 py-6 text-center">
            Nothing needs your attention right now.
          </p>
        ) : (
          <TaskList
            tasks={tasks}
            childCounts={{}}
            tagsByTask={tagsByTask}
            showDate="updatedAt"
          />
        )}
      </section>
    </div>
  );
}
