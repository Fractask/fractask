'use client';

import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { CalendarRange, List, Network } from 'lucide-react';

export function ViewToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const view = params.get('view') === 'tree' ? 'tree' : 'list';

  const setView = (next: 'list' | 'tree') => {
    const sp = new URLSearchParams(params.toString());
    if (next === 'list') sp.delete('view');
    else sp.set('view', next);
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <div className="inline-flex rounded-md border border-(--color-border) overflow-hidden">
      <button
        type="button"
        onClick={() => setView('list')}
        className={`flex items-center gap-1.5 px-2.5 py-1 text-xs cursor-pointer ${view === 'list' ? 'bg-(--color-surface-2) text-(--color-fg)' : 'text-(--color-muted) hover:text-(--color-fg)'}`}
      >
        <List size={14} /> List
      </button>
      <button
        type="button"
        onClick={() => setView('tree')}
        className={`flex items-center gap-1.5 px-2.5 py-1 text-xs cursor-pointer ${view === 'tree' ? 'bg-(--color-surface-2) text-(--color-fg)' : 'text-(--color-muted) hover:text-(--color-fg)'}`}
      >
        <Network size={14} /> Tree
      </button>
      <Link
        // On a task/project focus page the path is `/<id>` — scope the
        // calendar to that subtree. On the root list, show everything.
        href={pathname === '/' ? '/calendar' : `/calendar?scope=${pathname.slice(1)}`}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-(--color-muted) hover:text-(--color-fg)"
      >
        <CalendarRange size={14} /> Calendar
      </Link>
    </div>
  );
}
