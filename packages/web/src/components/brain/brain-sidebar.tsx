import Link from 'next/link';
import { Brain } from 'lucide-react';
import type { BrainNote, Task } from '@getshit/core';

/**
 * Sidebar "Brain" group: shows top-level personal notes and a header link to
 * /brain. Per-entity brain tree lives next to the entity in its own group;
 * this component is the root.
 */
export function BrainSidebarGroup({
  personalRoots,
  totalCount,
}: {
  personalRoots: BrainNote[];
  totalCount: number;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <Link
        href="/brain"
        className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-(--color-fg) hover:bg-(--color-surface)"
      >
        <span className="flex items-center gap-2">
          <Brain size={14} className="text-(--color-muted)" />
          Brain
        </span>
        {totalCount > 0 && (
          <span className="text-[10px] tabular-nums text-(--color-muted)">{totalCount}</span>
        )}
      </Link>
      {personalRoots.slice(0, 6).map((n) => (
        <Link
          key={n.id}
          href={`/brain/${n.id}`}
          className="ml-5 flex items-center gap-2 rounded-md px-2 py-1 text-xs text-(--color-muted) hover:text-(--color-fg) hover:bg-(--color-surface)"
        >
          <span className="w-4 text-center text-sm leading-none">{n.icon ?? '📄'}</span>
          <span className="truncate">{n.title}</span>
        </Link>
      ))}
    </div>
  );
}

export function EntityBrainLink({
  scope,
  notes,
  depth = 1,
}: {
  scope: Pick<Task, 'id' | 'title'>;
  notes: BrainNote[];
  depth?: number;
}) {
  if (notes.length === 0) return null;
  const outerIndent = depth === 2 ? 'ml-9' : 'ml-5';
  const innerIndent = depth === 2 ? 'ml-3' : 'ml-3';
  return (
    <div className={`${outerIndent} mt-0.5 flex flex-col gap-0.5`}>
      <Link
        href={`/brain?scope=${scope.id}`}
        className="flex items-center gap-2 rounded-md px-2 py-1 text-[11px] uppercase tracking-wider text-(--color-muted) hover:text-(--color-fg)"
        title={`Brain notes for ${scope.title}`}
      >
        <Brain size={11} />
        Brain ({notes.length})
      </Link>
      {notes.slice(0, 4).map((n) => (
        <Link
          key={n.id}
          href={`/brain/${n.id}`}
          className={`${innerIndent} flex items-center gap-2 rounded-md px-2 py-1 text-xs text-(--color-muted) hover:text-(--color-fg) hover:bg-(--color-surface)`}
        >
          <span className="w-4 text-center text-sm leading-none">{n.icon ?? '📄'}</span>
          <span className="truncate">{n.title}</span>
        </Link>
      ))}
    </div>
  );
}
