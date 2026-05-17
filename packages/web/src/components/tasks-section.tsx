'use client';

import { useState } from 'react';
import type { Tag, Task, TaskTree } from '@getshit/core';
import { TaskList, type PromoteContext, type ReorderMode } from './task-list';
import { TaskForest } from './task-tree';
import { DecomposeModal } from './decompose-modal';

type Props = {
  view: 'list' | 'tree';
  tasks: Task[];
  forest: TaskTree[];
  childCounts: Record<string, number>;
  tagsByTask?: Record<string, Tag[]>;
  reorder?: ReorderMode;
  promote?: PromoteContext;
  /**
   * When set, list rows render a small "Nd ago" indicator next to the ID.
   * Only takes effect in list view — trees have their own structural order.
   */
  showDate?: 'createdAt' | 'updatedAt';
};

export function TasksSection({
  view,
  tasks,
  forest,
  childCounts,
  tagsByTask,
  reorder,
  promote,
  showDate,
}: Props) {
  const [target, setTarget] = useState<Task | null>(null);

  return (
    <>
      {view === 'tree' ? (
        <TaskForest forest={forest} tagsByTask={tagsByTask} onDecompose={setTarget} />
      ) : (
        <TaskList
          tasks={tasks}
          childCounts={childCounts}
          tagsByTask={tagsByTask}
          reorder={reorder}
          onDecompose={setTarget}
          promote={promote}
          showDate={showDate}
        />
      )}
      {target && <DecomposeModal task={target} onClose={() => setTarget(null)} />}
    </>
  );
}

export function FocusDecomposeButton({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-xs px-3 py-1.5 rounded border border-(--color-border) text-(--color-muted) hover:text-(--color-accent) hover:border-(--color-accent) cursor-pointer mt-1"
      >
        ✨ Decompose with AI
      </button>
      {open && <DecomposeModal task={task} onClose={() => setOpen(false)} />}
    </>
  );
}
