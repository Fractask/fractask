'use client';

import Link from 'next/link';
import { useSearchParams, usePathname } from 'next/navigation';
import { CalendarRange, List, Network } from 'lucide-react';

/**
 * Three-way view switch: List / Tree / Calendar. Rendered on the root list,
 * on any task/project focus page, and on the calendar itself — so it's a real
 * round-trip toggle, not a one-way door.
 *
 * "Where the list/tree lives" is the base path: `/` at the root, `/<id>` on a
 * focus page. On the calendar we recover that base from `?scope=` (the project
 * the calendar is filtered to), so switching back to List/Tree lands on the
 * right page.
 */
export function ViewToggle() {
  const pathname = usePathname();
  const params = useSearchParams();
  const onCalendar = pathname === '/calendar';

  const scope = onCalendar
    ? params.get('scope')
    : pathname === '/'
      ? null
      : pathname.slice(1);
  const basePath = scope ? `/${scope}` : '/';

  const active: 'list' | 'tree' | 'calendar' = onCalendar
    ? 'calendar'
    : params.get('view') === 'tree'
      ? 'tree'
      : 'list';

  // List/Tree: on the calendar, jump to the (scoped) list/tree page fresh; on
  // a list/tree page, preserve the current query (sort, hidden, …) and just
  // flip the `view` param.
  const listTreeHref = (next: 'list' | 'tree') => {
    if (onCalendar) return next === 'tree' ? `${basePath}?view=tree` : basePath;
    const sp = new URLSearchParams(params.toString());
    if (next === 'list') sp.delete('view');
    else sp.set('view', next);
    const qs = sp.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const calendarHref = basePath === '/' ? '/calendar' : `/calendar?scope=${basePath.slice(1)}`;

  const cls = (on: boolean) =>
    `flex items-center gap-1.5 px-2.5 py-1 text-xs cursor-pointer ${
      on
        ? 'bg-(--color-surface-2) text-(--color-fg)'
        : 'text-(--color-muted) hover:text-(--color-fg)'
    }`;

  return (
    <div className="inline-flex rounded-md border border-(--color-border) overflow-hidden">
      <Link href={listTreeHref('list')} className={cls(active === 'list')}>
        <List size={14} /> List
      </Link>
      <Link href={listTreeHref('tree')} className={cls(active === 'tree')}>
        <Network size={14} /> Tree
      </Link>
      <Link href={calendarHref} className={cls(active === 'calendar')}>
        <CalendarRange size={14} /> Calendar
      </Link>
    </div>
  );
}
