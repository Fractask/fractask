import { getTagsForTasks, listTasks, type Task } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { TaskList } from '@/components/task-list';
import { NewTaskForm } from '@/components/new-task-form';
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const ctx = await getRequestContext();
  // "Inbox" = root-level open tasks (no parent project assigned).
  const tasks: Task[] = await listTasks(ctx, { parentId: null, status: 'open' });
  const tagsByTask = await getTagsForTasks(ctx, tasks.map((t) => t.id));

  return (
    <div className="px-6 py-4 max-w-4xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-sm font-medium">Inbox</h1>
          <p className="text-xs text-(--color-muted) mt-0.5">
            Top-level open tasks · {tasks.length}
          </p>
        </div>
      </header>

      <section className="flex flex-col gap-3">
        {tasks.length === 0 ? (
          <p className="text-sm text-(--color-muted) px-2 py-6 text-center">
            Inbox empty. Add a task below.
          </p>
        ) : (
          <TaskList tasks={tasks} childCounts={{}} tagsByTask={tagsByTask} />
        )}
        <NewTaskForm />
      </section>

      <KeyboardShortcuts focusedId={null} />
    </div>
  );
}
