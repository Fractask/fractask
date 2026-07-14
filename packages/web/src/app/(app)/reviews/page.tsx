import {
  ensureSelfAssignee,
  getTagsForTasks,
  listAssignees,
  listAttachmentsForTasks,
  listCommentsForTasks,
  listPromptsForTasks,
  listTasks,
  type Task,
} from '@getshit/core';
import Link from 'next/link';
import { getRequestContext } from '@/lib/auth';
import { TaskList } from '@/components/task-list';
import { ReviewCards, type ReviewItem } from '@/components/review-cards';
import { ReviewOverview, type OverviewPerson } from '@/components/review-overview';

export const dynamic = 'force-dynamic';

type View = 'cards' | 'list' | 'overview';

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view: rawView } = await searchParams;
  const view: View = rawView === 'list' ? 'list' : rawView === 'overview' ? 'overview' : 'cards';

  const ctx = await getRequestContext();
  // Reviewer = me. Self-assignee row is the canonical "me" id, generated lazily
  // on first list of /assignees. Ensure it exists so this page works zero-config.
  const me = await ensureSelfAssignee(ctx);
  // Cards/List = "needs your input" = tasks in review with me as reviewer.
  // Overview = the broader "who's holding what" board: every active task
  // (open/doing/review) grouped by assignee, regardless of reviewer.
  const tasks: Task[] =
    view === 'overview'
      ? await listTasks(ctx, { excludeStatuses: ['done', 'archived', 'snoozed', 'backlog'] })
      : await listTasks(ctx, { reviewerId: me.id, status: 'review' });
  const ids = tasks.map((t) => t.id);

  const [tagsByTask, promptsByTask, attByTask, assignees, commentsByTask] = await Promise.all([
    getTagsForTasks(ctx, ids),
    listPromptsForTasks(ctx, ids),
    listAttachmentsForTasks(ctx, ids),
    listAssignees(ctx),
    // Comments only matter for the action cards; skip the fetch for the (larger) overview set.
    view === 'overview' ? Promise.resolve(null) : listCommentsForTasks(ctx, ids),
  ]);

  const people: Record<string, OverviewPerson> = {};
  for (const a of assignees) people[a.id] = { id: a.id, name: a.name, kind: a.kind };

  const items: ReviewItem[] = tasks.map((task) => {
    const comments = commentsByTask?.get(task.id) ?? [];
    const last = comments.length > 0 ? comments[comments.length - 1]! : null;
    return {
      task,
      prompts: (promptsByTask.get(task.id) ?? []).filter((p) => p.status === 'pending'),
      attachments: attByTask.get(task.id) ?? [],
      lastComment: last
        ? {
            body: last.body,
            source: last.source,
            authorName:
              people[last.authorUserId]?.name ?? (last.source === 'agent' ? 'Agent' : 'Someone'),
            createdAt: last.createdAt,
          }
        : null,
    };
  });

  return (
    <div className="px-6 py-4 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-sm font-medium">Needs your input</h1>
          <p className="text-xs text-(--color-muted) mt-0.5">
            Approvals, agent questions, decisions · {tasks.length}
          </p>
        </div>
        <ViewToggle view={view} />
      </header>

      {tasks.length === 0 ? (
        <p className="text-sm text-(--color-muted) px-2 py-6 text-center">
          Nothing needs your attention right now.
        </p>
      ) : view === 'list' ? (
        <section className="flex flex-col gap-3">
          <TaskList tasks={tasks} childCounts={{}} tagsByTask={tagsByTask} showDate="updatedAt" />
        </section>
      ) : view === 'overview' ? (
        <ReviewOverview items={items} people={people} meId={me.id} />
      ) : (
        <ReviewCards items={items} />
      )}
    </div>
  );
}

function ViewToggle({ view }: { view: View }) {
  const base = 'px-2.5 py-1 text-xs cursor-pointer transition-colors';
  const on = 'bg-(--color-surface-2) text-(--color-fg)';
  const off = 'text-(--color-muted) hover:text-(--color-fg)';
  const tabs: { key: View; label: string; href: string }[] = [
    { key: 'cards', label: 'Cards', href: '/reviews' },
    { key: 'list', label: 'List', href: '/reviews?view=list' },
    { key: 'overview', label: 'By person', href: '/reviews?view=overview' },
  ];
  return (
    <div className="inline-flex rounded-md border border-(--color-border) overflow-hidden">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} className={`${base} ${view === t.key ? on : off}`}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
