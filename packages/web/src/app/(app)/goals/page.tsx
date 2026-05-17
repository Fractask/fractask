import Link from 'next/link';
import {
  getTagsForTasks,
  getTask,
  listTasks,
  type Task,
} from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { TaskList } from '@/components/task-list';
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts';

export const dynamic = 'force-dynamic';

export default async function GoalsPage() {
  const ctx = await getRequestContext();

  const hidden: ('archived' | 'snoozed' | 'backlog')[] = ['archived', 'snoozed', 'backlog'];
  const [goals, kpis] = await Promise.all([
    listTasks(ctx, { kind: 'goal', excludeStatuses: hidden }),
    listTasks(ctx, { kind: 'kpi', excludeStatuses: hidden }),
  ]);

  const all = [...goals, ...kpis];
  const tagsByTask = await getTagsForTasks(ctx, all.map((t) => t.id));

  // Resolve each goal/KPI's parent title once for the breadcrumb chip.
  const parentIds = Array.from(
    new Set(all.map((t) => t.parentId).filter((id): id is string => id !== null)),
  );
  const parents = await Promise.all(parentIds.map((id) => getTask(ctx, id)));
  const parentTitleById = new Map<string, string>();
  for (const p of parents) {
    if (p) parentTitleById.set(p.id, p.title);
  }

  return (
    <div className="px-6 py-4 max-w-4xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-sm font-medium">Goals &amp; KPIs</h1>
          <p className="text-xs text-(--color-muted) mt-0.5">
            Every goal and KPI across all projects · {all.length}
          </p>
        </div>
      </header>

      <Section
        title="Goals"
        emptyMessage="No goals yet. Create one from a project's focus page."
        tasks={goals}
        tagsByTask={tagsByTask}
        parentTitleById={parentTitleById}
      />

      <div className="mt-6" />

      <Section
        title="KPIs"
        emptyMessage="No KPIs yet. Create one from a project's focus page (use a recurrence to make it a recurring check-in)."
        tasks={kpis}
        tagsByTask={tagsByTask}
        parentTitleById={parentTitleById}
      />

      <KeyboardShortcuts focusedId={null} />
    </div>
  );
}

function Section({
  title,
  emptyMessage,
  tasks,
  tagsByTask,
  parentTitleById,
}: {
  title: string;
  emptyMessage: string;
  tasks: Task[];
  tagsByTask: Awaited<ReturnType<typeof getTagsForTasks>>;
  parentTitleById: Map<string, string>;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[11px] uppercase tracking-wider text-(--color-muted) px-2">
        {title} <span className="font-mono-id">{tasks.length}</span>
      </h2>
      {tasks.length === 0 ? (
        <p className="text-sm text-(--color-muted) px-2 py-4">{emptyMessage}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <TaskList tasks={tasks} childCounts={{}} tagsByTask={tagsByTask} />
          <ParentLegend tasks={tasks} parentTitleById={parentTitleById} />
        </div>
      )}
    </section>
  );
}

// Renders a small "in <parent>" link under the list — clicking takes the user
// to that parent's focus page. We do not embed it per row to keep TaskRow lean.
function ParentLegend({
  tasks,
  parentTitleById,
}: {
  tasks: Task[];
  parentTitleById: Map<string, string>;
}) {
  const grouped = new Map<string | null, number>();
  for (const t of tasks) {
    const key = t.parentId;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  if (grouped.size === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2 text-[10px] text-(--color-muted)">
      <span>under:</span>
      {Array.from(grouped.entries()).map(([parentId, count]) => {
        const title = parentId ? parentTitleById.get(parentId) ?? '(deleted)' : 'root';
        return parentId ? (
          <Link
            key={parentId}
            href={`/${parentId}`}
            className="px-1.5 py-px rounded-full border border-(--color-border) hover:text-(--color-fg) hover:border-(--color-fg)/40"
          >
            {title} <span className="font-mono-id">{count}</span>
          </Link>
        ) : (
          <span
            key="root"
            className="px-1.5 py-px rounded-full border border-(--color-border)"
          >
            {title} <span className="font-mono-id">{count}</span>
          </span>
        );
      })}
    </div>
  );
}
