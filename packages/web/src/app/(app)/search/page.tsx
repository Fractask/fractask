import Link from 'next/link';
import { getTagsForTasks, searchTasks, type TaskKind } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { TaskList } from '@/components/task-list';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<TaskKind, string> = {
  entity: 'Entities',
  project: 'Projects',
  goal: 'Goals',
  kpi: 'KPIs',
  task: 'Tasks',
};
const KIND_ORDER: TaskKind[] = ['task', 'project', 'goal', 'kpi', 'entity'];
const VALID_KINDS = new Set<TaskKind>(KIND_ORDER);

function parseKind(raw: string | undefined): TaskKind | undefined {
  if (!raw) return undefined;
  return VALID_KINDS.has(raw as TaskKind) ? (raw as TaskKind) : undefined;
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kind?: string }>;
}) {
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const kind = parseKind(params.kind);

  const ctx = await getRequestContext();
  const tasks = query
    ? await searchTasks(ctx, query, {
        ...(kind ? { kinds: [kind] } : {}),
        limit: 200,
      })
    : [];
  const tagsByTask = await getTagsForTasks(ctx, tasks.map((t) => t.id));

  return (
    <div className="px-6 py-4 max-w-4xl mx-auto">
      <header className="mb-4">
        <h1 className="text-sm font-medium">
          {query ? <>Search: <span className="text-(--color-muted)">{query}</span></> : 'Search'}
        </h1>
        <p className="text-xs text-(--color-muted) mt-0.5">
          {query ? `${tasks.length} result${tasks.length === 1 ? '' : 's'}` : 'Type a query in the sidebar.'}
        </p>

        {query && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <KindChip current={kind} value={undefined} label="All" q={query} />
            {KIND_ORDER.map((k) => (
              <KindChip key={k} current={kind} value={k} label={KIND_LABEL[k]} q={query} />
            ))}
          </div>
        )}
      </header>

      {query && tasks.length === 0 && (
        <p className="text-sm text-(--color-muted) px-2 py-6 text-center">
          No matches for &ldquo;{query}&rdquo;.
        </p>
      )}

      {tasks.length > 0 && (
        <TaskList tasks={tasks} childCounts={{}} tagsByTask={tagsByTask} />
      )}
    </div>
  );
}

function KindChip({
  current,
  value,
  label,
  q,
}: {
  current: TaskKind | undefined;
  value: TaskKind | undefined;
  label: string;
  q: string;
}) {
  const active = current === value;
  const params = new URLSearchParams({ q });
  if (value) params.set('kind', value);
  const href = `/search?${params.toString()}`;
  return (
    <Link
      href={href}
      className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
        active
          ? 'bg-(--color-fg) text-(--color-bg) border-transparent'
          : 'border-(--color-border) text-(--color-muted) hover:text-(--color-fg) hover:border-(--color-fg)'
      }`}
    >
      {label}
    </Link>
  );
}
