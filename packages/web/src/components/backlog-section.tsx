'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import type { Tag, Task, TaskTree } from '@getshit/core';
import { TasksSection } from './tasks-section';

/**
 * Backlog = tasks parked under this parent with status='backlog'. Noted, not
 * now, no schedule. Lives in its own collapsible section so it never competes
 * with the active Subtasks list — both list and tree modes share this surface.
 */
export function BacklogSection({
  tasks,
  forest,
  childCounts,
  tagsByTask,
  parentId,
  view,
  defaultOpen,
  showDate,
}: {
  tasks: Task[];
  forest?: TaskTree[];
  childCounts: Record<string, number>;
  tagsByTask: Record<string, Tag[]>;
  parentId: string;
  view: 'list' | 'tree';
  defaultOpen?: boolean;
  showDate?: 'createdAt' | 'updatedAt';
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  if (tasks.length === 0) return null;

  return (
    <section className="flex flex-col gap-3 mt-6 border-t border-(--color-border) pt-4 opacity-90">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-2 -mx-2 py-1 rounded-md hover:bg-(--color-surface) text-(--color-muted) hover:text-(--color-fg) cursor-pointer"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Layers size={12} />
        <h2 className="text-xs uppercase tracking-wide">Backlog</h2>
        <span className="font-mono-id text-(--color-muted)">{tasks.length}</span>
        <span className="ml-2 text-[10px] text-(--color-muted) normal-case tracking-normal">
          noted, not now
        </span>
      </button>
      {open && (
        <div className="opacity-80">
          <TasksSection
            view={view}
            tasks={tasks}
            forest={forest ?? []}
            childCounts={childCounts}
            tagsByTask={tagsByTask}
            reorder={{ kind: 'siblings', parentId }}
            {...(showDate ? { showDate } : {})}
          />
        </div>
      )}
    </section>
  );
}
