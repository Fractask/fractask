import { getTagsForTasks, listTasks, type Task } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { TaskList } from '@/components/task-list';
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts';

export const dynamic = 'force-dynamic';

export default async function ArchivedPage() {
  const ctx = await getRequestContext();
  const tasks: Task[] = await listTasks(ctx, { status: 'archived' });
  const tagsByTask = await getTagsForTasks(ctx, tasks.map((t) => t.id));

  return (
    <div className="px-6 py-4 max-w-4xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-sm font-medium">Archived</h1>
          <p className="text-xs text-(--color-muted) mt-0.5">
            Hidden from the All view and sidebar · {tasks.length} · click the status icon on a row to restore
          </p>
        </div>
      </header>

      <section className="flex flex-col gap-3">
        {tasks.length === 0 ? (
          <p className="text-sm text-(--color-muted) px-2 py-6 text-center">
            Nothing archived. Use the row's archive button to send a task here.
          </p>
        ) : (
          <TaskList tasks={tasks} childCounts={{}} tagsByTask={tagsByTask} />
        )}
      </section>

      <KeyboardShortcuts focusedId={null} />
    </div>
  );
}
