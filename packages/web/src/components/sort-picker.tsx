'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowDown, ArrowDownUp, ArrowUp, GripVertical } from 'lucide-react';
import {
  DEFAULT_SORT,
  SORT_KEYS,
  parseSortKey,
  sortLabel,
  sortShort,
  type SortKey,
} from '@/lib/sort';

const ICONS: Record<SortKey, typeof ArrowDownUp> = {
  position: GripVertical,
  'created:desc': ArrowDown,
  'created:asc': ArrowUp,
  'updated:desc': ArrowDown,
  'updated:asc': ArrowUp,
};

/**
 * Sort dropdown. Persists in the URL (`?sort=created:desc`) so reloading,
 * sharing, and back-button all work for free. Default is `position` — the
 * existing drag-reordered sibling order.
 *
 * Optional `paramName` lets multiple lists on one page (e.g. subtasks +
 * backlog) keep independent sorts.
 */
export function SortPicker({ paramName = 'sort' }: { paramName?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = parseSortKey(params.get(paramName) ?? undefined);

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const pick = (key: SortKey) => {
    setOpen(false);
    const next = new URLSearchParams(params.toString());
    if (key === DEFAULT_SORT) next.delete(paramName);
    else next.set(paramName, key);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const Icon = ICONS[current];

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Change sort order"
        className="inline-flex items-center gap-1 text-[11px] text-(--color-muted) hover:text-(--color-fg) px-1.5 py-0.5 rounded cursor-pointer"
      >
        <Icon size={11} />
        <span>{sortShort(current)}</span>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-(--color-border) bg-(--color-bg) py-1 shadow-lg"
        >
          {SORT_KEYS.map((k) => {
            const I = ICONS[k];
            const selected = k === current;
            return (
              <li key={k}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => pick(k)}
                  className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-(--color-surface) ${
                    selected ? 'bg-(--color-surface) text-(--color-fg)' : 'text-(--color-muted)'
                  }`}
                >
                  <I size={12} />
                  <span>{sortLabel(k)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
