import Link from 'next/link';
import { Building2, X } from 'lucide-react';
import {
  getSubtree,
  getTagsForTasks,
  getTag,
  listTasks,
  listTasksWithChildCount,
  type Tag,
  type Task,
  type TaskTree,
  type TaskWithChildCount,
} from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { TasksSection } from '@/components/tasks-section';
import { TaskDropZone } from '@/components/task-drop-zone';
import { ViewToggle } from '@/components/view-toggle';
import { HiddenToggle } from '@/components/hidden-toggle';
import { NewTaskForm } from '@/components/new-task-form';
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts';

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; tag?: string; hidden?: string }>;
}) {
  const params = await searchParams;
  const view = params.view === 'tree' ? 'tree' : 'list';
  const tagFilter = params.tag ?? null;
  const showHidden = params.hidden === '1';
  const ctx = await getRequestContext();

  if (tagFilter) {
    const [tag, tasks] = await Promise.all([
      getTag(ctx, tagFilter),
      listTasks(ctx, { tagId: tagFilter }),
    ]);
    const tagsByTask = await getTagsForTasks(ctx, tasks.map((t) => t.id));

    return (
      <div className="px-6 py-4 max-w-4xl mx-auto">
        <header className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-(--color-muted)">Filtered by tag</span>
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs border"
              style={{
                borderColor: tag?.color ?? 'var(--color-border)',
                backgroundColor: tag?.color ? `${tag.color}1A` : 'var(--color-surface)',
              }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: tag?.color ?? 'var(--color-muted)' }}
              />
              {tag?.name ?? tagFilter}
            </span>
            <Link
              href="/"
              title="Clear filter"
              className="p-1 rounded hover:bg-(--color-surface) text-(--color-muted) hover:text-(--color-fg)"
            >
              <X size={12} />
            </Link>
          </div>
          <p className="text-xs text-(--color-muted)">{tasks.length}</p>
        </header>

        <section className="flex flex-col gap-3">
          <TasksSection
            view="list"
            tasks={tasks}
            forest={[]}
            childCounts={{}}
            tagsByTask={tagsByTask}
          />
          <NewTaskForm />
        </section>

        <KeyboardShortcuts focusedId={null} />
      </div>
    );
  }

  // Fetch roots + every project (regardless of parent) so we can render:
  //   entity sections → their projects, then "Projects" for project-roots.
  // Archived and snoozed are hidden by default; ?hidden=1 surfaces them inline.
  const hidden: ('archived' | 'snoozed' | 'backlog')[] = ['archived', 'snoozed', 'backlog'];
  const excludeStatuses = showHidden ? [] : hidden;
  const [rootsWithCounts, projectsAnyParent] = await Promise.all([
    listTasksWithChildCount(ctx, { parentId: null, excludeStatuses }),
    listTasksWithChildCount(ctx, { kind: 'project', excludeStatuses }),
  ]);

  const entities = rootsWithCounts.filter((r) => r.kind === 'entity');
  const orphanRootProjects = rootsWithCounts.filter((r) => r.kind === 'project');
  const orphanRootTasks = rootsWithCounts.filter((r) => r.kind === 'task');

  const projectsByEntity = new Map<string, TaskWithChildCount[]>();
  for (const p of projectsAnyParent) {
    if (!p.parentId) continue;
    const arr = projectsByEntity.get(p.parentId) ?? [];
    arr.push(p);
    projectsByEntity.set(p.parentId, arr);
  }

  // For tree view, prefetch subtrees of every project we'll render.
  const allProjectsToRender: TaskWithChildCount[] = [
    ...entities.flatMap((e) => projectsByEntity.get(e.id) ?? []),
    ...orphanRootProjects,
    ...orphanRootTasks,
  ];
  let treesById: Map<string, TaskTree> = new Map();
  if (view === 'tree') {
    const trees = (
      await Promise.all(allProjectsToRender.map((p) => getSubtree(ctx, p.id)))
    ).filter((t): t is TaskTree => t !== null);
    treesById = new Map(trees.map((t) => [t.id, t]));
  }

  // Tags: collect all ids that will be rendered (projects + their descendants in tree mode).
  const tagIds: string[] =
    view === 'tree'
      ? collectIds(Array.from(treesById.values()))
      : allProjectsToRender.map((p) => p.id);
  const tagsByTask: Record<string, Tag[]> = await getTagsForTasks(ctx, tagIds);

  const renderProjects = (
    projects: TaskWithChildCount[],
    parentId: string | null,
  ) => {
    if (projects.length === 0) return null;
    const flat: Task[] = projects.map(({ childCount: _c, ...t }) => t);
    const childCounts: Record<string, number> = Object.fromEntries(
      projects.map((p) => [p.id, p.childCount]),
    );
    const forest: TaskTree[] =
      view === 'tree'
        ? projects
            .map((p) => treesById.get(p.id))
            .filter((t): t is TaskTree => t !== undefined)
        : [];
    return (
      <TasksSection
        view={view}
        tasks={flat}
        forest={forest}
        childCounts={childCounts}
        tagsByTask={tagsByTask}
        reorder={{ kind: 'siblings', parentId }}
      />
    );
  };

  return (
    <div className="px-6 py-4 max-w-4xl mx-auto">
      <header className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h1 className="text-sm font-medium">Tasks</h1>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <HiddenToggle />
          <ViewToggle />
        </div>
      </header>

      <div className="flex flex-col gap-6">
        {entities.map((e) => {
          const projects = projectsByEntity.get(e.id) ?? [];
          return (
            <section key={e.id} className="flex flex-col gap-2">
              <TaskDropZone targetId={e.id} targetTitle={e.title}>
                <Link
                  href={`/${e.id}`}
                  className="group flex items-center gap-2 text-[11px] uppercase tracking-wider text-(--color-muted) hover:text-(--color-fg) px-2"
                >
                  <Building2 size={12} />
                  <span className="font-medium">{e.title}</span>
                  <span className="font-mono-id">{projects.length}</span>
                </Link>
              </TaskDropZone>
              {renderProjects(projects, e.id) ?? (
                <p className="px-2 text-xs italic text-(--color-muted)">
                  No projects yet.
                </p>
              )}
              <div className="px-2">
                <NewTaskForm parentId={e.id} defaultKind="project" />
              </div>
            </section>
          );
        })}

        {orphanRootProjects.length > 0 && (
          <section className="flex flex-col gap-2">
            <TaskDropZone targetId={null} targetTitle="root">
              <h2 className="text-[11px] uppercase tracking-wider text-(--color-muted) px-2">
                {entities.length > 0 ? 'Projects (no entity)' : 'Projects'}
              </h2>
            </TaskDropZone>
            {renderProjects(orphanRootProjects, null)}
          </section>
        )}

        {orphanRootTasks.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-[11px] uppercase tracking-wider text-(--color-muted) px-2">
              Loose tasks
            </h2>
            {renderProjects(orphanRootTasks, null)}
          </section>
        )}

        <NewTaskForm />
      </div>

      <KeyboardShortcuts focusedId={null} />
    </div>
  );
}

function collectIds(trees: TaskTree[], acc: string[] = []): string[] {
  for (const t of trees) {
    acc.push(t.id);
    if (t.children.length > 0) collectIds(t.children, acc);
  }
  return acc;
}
