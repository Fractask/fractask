import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getSubtree,
  getTask,
  getTagsForTask,
  getTagsForTasks,
  listAssignees,
  listTags,
  listTasksWithChildCount,
  type Task,
  type TaskTree,
} from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { TasksSection, FocusDecomposeButton } from '@/components/tasks-section';
import { TaskDropZone } from '@/components/task-drop-zone';
import { StatusBanner } from '@/components/status-banner';
import { ViewToggle } from '@/components/view-toggle';
import { HiddenToggle } from '@/components/hidden-toggle';
import { NewTaskForm } from '@/components/new-task-form';
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts';
import { StatusPicker } from '@/components/status-picker';
import { EditableHeading } from '@/components/editable-title';
import { NotesEditor } from '@/components/notes-editor';
import { RulesEditor } from '@/components/rules-editor';
import { KindPicker } from '@/components/kind-picker';
import { TaskTagsPicker } from '@/components/task-tags-picker';
import { TaskMetaBar } from '@/components/task-meta-bar';
import { ShareButton } from '@/components/share-button';
import { TaskPrompts } from '@/components/task-prompts';
import { TaskAttachments } from '@/components/task-attachments';
import { ReviewActions } from '@/components/review-actions';
import { BacklogSection } from '@/components/backlog-section';
import { SortPicker } from '@/components/sort-picker';
import { dateFieldForSort, parseSortKey, sortTasks } from '@/lib/sort';

export const dynamic = 'force-dynamic';

export default async function FocusPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string; hidden?: string; sort?: string; backlogSort?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const view = sp.view === 'tree' ? 'tree' : 'list';
  const showHidden = sp.hidden === '1';
  const sortKey = parseSortKey(sp.sort);
  const backlogSortKey = parseSortKey(sp.backlogSort);
  const showDate = dateFieldForSort(sortKey);
  const backlogShowDate = dateFieldForSort(backlogSortKey);

  const ctx = await getRequestContext();
  const fetched = await getTask(ctx, id);
  if (!fetched) notFound();

  // Hide archived/snoozed/backlog children from the main Subtasks view by
  // default; ?hidden=1 surfaces archived/snoozed inline. Backlog has its own
  // dedicated section regardless so it's never in the active subtask list.
  // The focused task itself always loads so the user can restore it even
  // when it's archived/snoozed.
  const backlogChildren = fetched.children.filter((c) => c.status === 'backlog');
  const focused = {
    ...fetched,
    children: showHidden
      ? fetched.children.filter((c) => c.status !== 'backlog')
      : fetched.children.filter(
          (c) => c.status !== 'archived' && c.status !== 'snoozed' && c.status !== 'backlog',
        ),
  };

  const trail: Task[] = [];
  let cursor: string | null = focused.parentId;
  while (cursor) {
    const parent = await getTask(ctx, cursor);
    if (!parent) break;
    trail.unshift(parent);
    cursor = parent.parentId;
  }
  trail.push(focused);

  const hidden: ('archived' | 'snoozed' | 'backlog')[] = ['archived', 'snoozed', 'backlog'];
  const excludeStatuses = showHidden ? [] : hidden;
  const [childrenWithCounts, taskTags, allTags, allAssignees] = await Promise.all([
    listTasksWithChildCount(ctx, { parentId: focused.id, excludeStatuses }),
    getTagsForTask(ctx, focused.id),
    listTags(ctx),
    listAssignees(ctx),
  ]);
  const childCounts: Record<string, number> = Object.fromEntries(
    childrenWithCounts.map((c) => [c.id, c.childCount]),
  );

  let trees: TaskTree[] = [];
  let backlogTrees: TaskTree[] = [];
  if (view === 'tree') {
    trees = (
      await Promise.all(focused.children.map((c) => getSubtree(ctx, c.id)))
    ).filter((t): t is TaskTree => t !== null);
    backlogTrees = (
      await Promise.all(backlogChildren.map((c) => getSubtree(ctx, c.id)))
    ).filter((t): t is TaskTree => t !== null);
  }

  const subtaskIds: string[] =
    view === 'tree'
      ? [...collectIds(trees), ...collectIds(backlogTrees)]
      : [...focused.children.map((c) => c.id), ...backlogChildren.map((c) => c.id)];
  const subtaskTagsByTask = await getTagsForTasks(ctx, subtaskIds);

  // Child counts for backlog rows so the row chip still shows their depth.
  const backlogChildrenWithCounts = await listTasksWithChildCount(ctx, {
    parentId: focused.id,
    status: 'backlog',
  });
  const backlogChildCounts: Record<string, number> = Object.fromEntries(
    backlogChildrenWithCounts.map((c) => [c.id, c.childCount]),
  );

  return (
    <div className="px-6 py-4 max-w-4xl mx-auto">
      <Breadcrumbs trail={trail} />
      <StatusBanner id={focused.id} status={focused.status} />
      <TaskDropZone targetId={focused.id} targetTitle={focused.title}>
        <header className="mt-3 mb-6 flex flex-col md:flex-row md:items-start md:justify-between gap-3 md:gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="mt-1">
              <StatusPicker id={focused.id} status={focused.status} />
            </div>
            <div className="min-w-0">
              <EditableHeading
                id={focused.id}
                initial={focused.title}
                done={focused.status === 'done'}
              />
              <div className="flex items-center gap-3 mt-0.5">
                <KindPicker id={focused.id} kind={focused.kind} />
                <span className="text-xs text-(--color-muted) font-mono-id">
                  {focused.id} · {focused.children.length}{' '}
                  {focused.children.length === 1 ? 'child' : 'children'} · {focused.source}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 self-start md:self-auto">
            <ShareButton taskId={focused.id} isOwner={focused.userId === ctx.userId} />
            <HiddenToggle />
            <ViewToggle />
          </div>
        </header>
      </TaskDropZone>

      <div className="mb-4 flex flex-col gap-2">
        <TaskMetaBar
          taskId={focused.id}
          dueAt={focused.dueAt}
          assigneeId={focused.assigneeId}
          reviewerId={focused.reviewerId}
          recurrence={focused.recurrence}
          assignees={allAssignees}
        />
        <TaskTagsPicker taskId={focused.id} initialTags={taskTags} allTags={allTags} />
      </div>

      <TaskPrompts prompts={focused.prompts} attachments={focused.attachments} />

      {focused.status === 'review' && (
        <ReviewActions
          id={focused.id}
          pendingPromptCount={focused.prompts.filter((p) => p.status === 'pending').length}
        />
      )}

      <div className="mb-4">
        <NotesEditor id={focused.id} initial={focused.description} />
      </div>

      <TaskAttachments taskId={focused.id} attachments={focused.attachments} />

      {(focused.kind === 'entity' || focused.kind === 'project') && (
        <div className="mb-6">
          <RulesEditor
            id={focused.id}
            initial={focused.rules}
            kindLabel={focused.kind}
          />
        </div>
      )}

      {(() => {
        const goalsKpis = focused.children.filter(
          (c) => c.kind === 'goal' || c.kind === 'kpi',
        );
        const otherChildrenRaw = focused.children.filter(
          (c) => c.kind !== 'goal' && c.kind !== 'kpi',
        );
        const otherChildren = view === 'list' ? sortTasks(otherChildrenRaw, sortKey) : otherChildrenRaw;
        const sortedBacklog = view === 'list' ? sortTasks(backlogChildren, backlogSortKey) : backlogChildren;
        const goalsKpisIds = new Set(goalsKpis.map((c) => c.id));
        const goalsKpisTrees = trees.filter((t) => goalsKpisIds.has(t.id));
        const otherTrees = trees.filter((t) => !goalsKpisIds.has(t.id));
        const showGoalsSection =
          focused.kind === 'entity' ||
          focused.kind === 'project' ||
          goalsKpis.length > 0;
        const promote = {
          toParentId: focused.parentId,
          label: focused.parentId
            ? `Move out of "${focused.title}"`
            : `Move out of "${focused.title}" to root`,
        };
        return (
          <>
            {showGoalsSection && (
              <section className="flex flex-col gap-3 mb-6">
                <h2 className="text-xs uppercase tracking-wide text-(--color-muted) px-2">
                  Goals &amp; KPIs
                </h2>
                <TasksSection
                  view={view}
                  tasks={goalsKpis}
                  forest={goalsKpisTrees}
                  childCounts={childCounts}
                  tagsByTask={subtaskTagsByTask}
                  reorder={{ kind: 'siblings', parentId: focused.id }}
                  promote={promote}
                />
                <NewTaskForm parentId={focused.id} defaultKind="goal" />
              </section>
            )}
            <section className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between px-2">
                <h2 className="text-xs uppercase tracking-wide text-(--color-muted)">
                  {focused.kind === 'entity' ? 'Projects' : 'Subtasks'}
                </h2>
                {view === 'list' && <SortPicker />}
              </div>
              <TasksSection
                view={view}
                tasks={otherChildren}
                forest={otherTrees}
                childCounts={childCounts}
                tagsByTask={subtaskTagsByTask}
                reorder={{ kind: 'siblings', parentId: focused.id }}
                promote={promote}
                {...(showDate ? { showDate } : {})}
              />
              <NewTaskForm
                parentId={focused.id}
                defaultKind={
                  focused.kind === 'entity'
                    ? 'project'
                    : focused.kind === 'project'
                      ? 'task'
                      : 'task'
                }
              />
              <FocusDecomposeButton task={focused} />
            </section>

            <BacklogSection
              tasks={sortedBacklog}
              forest={backlogTrees}
              childCounts={backlogChildCounts}
              tagsByTask={subtaskTagsByTask}
              parentId={focused.id}
              view={view}
              {...(backlogShowDate ? { showDate: backlogShowDate } : {})}
            />
          </>
        );
      })()}

      <KeyboardShortcuts focusedId={focused.id} />

      <footer className="mt-10 pt-4 border-t border-(--color-border) text-xs text-(--color-muted) flex items-center gap-4">
        <Link href="/" className="hover:text-(--color-fg)">
          ← root
        </Link>
        <span>
          <kbd className="font-mono-id">?</kbd> shortcuts
        </span>
      </footer>
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
