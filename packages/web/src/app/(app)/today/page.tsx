import { getTagsForTasks, listDueTasks, type Task } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { TaskList } from '@/components/task-list';
import { NewTaskForm } from '@/components/new-task-form';
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts';

export const dynamic = 'force-dynamic';

function startOfTomorrow(): number {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export default async function TodayPage() {
  const ctx = await getRequestContext();
  const tasks: Task[] = await listDueTasks(ctx, startOfTomorrow(), 'open');
  const tagsByTask = await getTagsForTasks(ctx, tasks.map((t) => t.id));

  return (
    <div className="px-6 py-4 max-w-4xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-sm font-medium">Today</h1>
          <p className="text-xs text-(--color-muted) mt-0.5">
            Open tasks due today or earlier · {tasks.length} · drag to reorder priority
          </p>
        </div>
      </header>

      <section className="flex flex-col gap-3">
        {tasks.length === 0 ? (
          <p className="text-sm text-(--color-muted) px-2 py-6 text-center">
            Nothing due today. Set a due date on a task to see it here.
          </p>
        ) : (
          <TaskList
            tasks={tasks}
            childCounts={{}}
            tagsByTask={tagsByTask}
            reorder={{ kind: 'priority' }}
          />
        )}
        <NewTaskForm />
      </section>

      <KeyboardShortcuts focusedId={null} />
    </div>
  );
}
