import { ensureSelfAssignee, listTags, listTasks, listTasksWithChildCount } from '@getshit/core';
import type { TaskWithChildCount } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { signOutAction } from '@/app/auth/signin/actions';
import {
  SidebarEntityGroup,
  SidebarProjectItem,
  SidebarStaticItem,
  SidebarTagItem,
} from './sidebar-nav';
import { SidebarSearch } from './sidebar-search';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';

function startOfTomorrow(): number {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export async function Sidebar() {
  const ctx = await getRequestContext();

  const me = await ensureSelfAssignee(ctx);
  const hidden: ('archived' | 'snoozed')[] = ['archived', 'snoozed'];
  const [
    inbox,
    dueToday,
    allOpen,
    allRoots,
    projectsAnyParent,
    goals,
    kpis,
    archived,
    snoozed,
    tags,
    reviewsForMe,
  ] = await Promise.all([
    listTasks(ctx, { parentId: null, status: 'open' }),
    listTasks(ctx, { dueBefore: startOfTomorrow(), status: 'open' }),
    listTasks(ctx, { status: 'open' }),
    listTasksWithChildCount(ctx, { parentId: null, excludeStatuses: hidden }),
    listTasksWithChildCount(ctx, { kind: 'project', excludeStatuses: hidden }),
    listTasks(ctx, { kind: 'goal', excludeStatuses: hidden }),
    listTasks(ctx, { kind: 'kpi', excludeStatuses: hidden }),
    listTasks(ctx, { status: 'archived' }),
    listTasks(ctx, { status: 'snoozed' }),
    listTags(ctx),
    listTasks(ctx, { reviewerId: me.id, status: 'review' }),
  ]);
  const goalsKpisCount = goals.length + kpis.length;

  // Hide done tasks from the sidebar — they clutter once shipped.
  const liveRoots = allRoots.filter((r) => r.status !== 'done');
  const entities = liveRoots.filter((r) => r.kind === 'entity');
  const orphanRootProjects = liveRoots.filter((r) => r.kind === 'project');

  // Projects whose parent is an entity.
  const liveProjects = projectsAnyParent.filter((p) => p.status !== 'done');
  const projectsByEntity = new Map<string, TaskWithChildCount[]>();
  for (const p of liveProjects) {
    if (!p.parentId) continue;
    const arr = projectsByEntity.get(p.parentId) ?? [];
    arr.push(p);
    projectsByEntity.set(p.parentId, arr);
  }

  return (
    <aside className="flex flex-col h-screen bg-(--color-bg) border-r border-(--color-border) text-(--color-fg)">
      <div className="px-3 py-3 border-b border-(--color-border)">
        <Logo size={18} variant="short" className="text-sm" />
      </div>

      <SidebarSearch />

      <nav className="flex-1 overflow-y-auto px-2 py-3 flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <SidebarStaticItem item={{ href: '/inbox', label: 'Inbox', icon: 'inbox', count: inbox.length }} />
          <SidebarStaticItem item={{ href: '/today', label: 'Today', icon: 'today', count: dueToday.length }} />
          <SidebarStaticItem item={{ href: '/reviews', label: 'Reviews', icon: 'reviews', count: reviewsForMe.length }} />
          <SidebarStaticItem item={{ href: '/', label: 'All', icon: 'all', count: allOpen.length }} />
          <SidebarStaticItem
            item={{ href: '/goals', label: 'Goals & KPIs', icon: 'goals', count: goalsKpisCount }}
          />
        </div>

        {entities.map((e) => {
          const projects = projectsByEntity.get(e.id) ?? [];
          return (
            <SidebarEntityGroup
              key={e.id}
              id={e.id}
              title={e.title}
              projects={projects.map((p) => ({ id: p.id, title: p.title, count: p.childCount }))}
            />
          );
        })}

        {orphanRootProjects.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-(--color-muted)">
              Projects
            </div>
            {orphanRootProjects.map((p) => (
              <SidebarProjectItem key={p.id} id={p.id} title={p.title} count={p.childCount} />
            ))}
          </div>
        )}

        {tags.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-(--color-muted)">
              Tags
            </div>
            {tags.map((t) => (
              <SidebarTagItem key={t.id} id={t.id} name={t.name} color={t.color} />
            ))}
          </div>
        )}

        <div className="flex flex-col gap-0.5">
          <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-(--color-muted)">
            Hidden
          </div>
          <SidebarStaticItem
            item={{ href: '/snoozed', label: 'Snoozed', icon: 'snoozed', count: snoozed.length }}
          />
          <SidebarStaticItem
            item={{ href: '/archived', label: 'Archived', icon: 'archived', count: archived.length }}
          />
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-(--color-muted)">
            Manage
          </div>
          <SidebarStaticItem item={{ href: '/assignees', label: 'Assignees', icon: 'assignees' }} />
          <SidebarStaticItem item={{ href: '/tags', label: 'Tags', icon: 'tags' }} />
          <SidebarStaticItem item={{ href: '/settings/users', label: 'Users', icon: 'users' }} />
          <SidebarStaticItem item={{ href: '/settings/tokens', label: 'CLI tokens', icon: 'tokens' }} />
          <SidebarStaticItem item={{ href: '/settings/guidelines', label: 'Task guidelines', icon: 'guidelines' }} />
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-(--color-muted)">
            Connect
          </div>
          <SidebarStaticItem item={{ href: '/setup', label: 'Setup MCP', icon: 'setup' }} />
          <SidebarStaticItem item={{ href: '/import', label: 'Import tasks', icon: 'import' }} />
          <SidebarStaticItem item={{ href: '/install', label: 'Install on phone', icon: 'install' }} />
        </div>
      </nav>

      <div className="border-t border-(--color-border)">
        <div className="px-2 pt-2">
          <ThemeToggle />
        </div>
        <form action={signOutAction} className="px-2 py-2">
          <button
            type="submit"
            className="w-full text-left px-2 py-1.5 text-xs text-(--color-muted) hover:text-(--color-fg) rounded"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
