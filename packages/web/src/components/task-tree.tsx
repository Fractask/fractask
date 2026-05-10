'use client';

import type { Tag, Task, TaskTree as TaskTreeType } from '@getshit/core';
import { TaskRow } from './task-row';

export function TaskTreeView({
  tree,
  tagsByTask,
  onDecompose,
  level = 0,
}: {
  tree: TaskTreeType;
  tagsByTask?: Record<string, Tag[]> | undefined;
  onDecompose?: ((task: Task) => void) | undefined;
  level?: number | undefined;
}) {
  return (
    <div className="text-sm">
      <div style={{ paddingLeft: level * 20 }}>
        <TaskRow
          task={tree}
          childCount={tree.children.length}
          tags={tagsByTask?.[tree.id] ?? []}
          onDecompose={onDecompose}
        />
      </div>
      {tree.children.length > 0 && (
        <div>
          {tree.children.map((child) => (
            <TaskTreeView
              key={child.id}
              tree={child}
              tagsByTask={tagsByTask}
              onDecompose={onDecompose}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskForest({
  forest,
  tagsByTask,
  onDecompose,
}: {
  forest: TaskTreeType[];
  tagsByTask?: Record<string, Tag[]> | undefined;
  onDecompose?: ((task: Task) => void) | undefined;
}) {
  if (forest.length === 0) {
    return (
      <p className="text-sm text-(--color-muted) px-2 py-4">
        No tasks yet. Press <kbd className="font-mono-id">c</kbd> or use the input below.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {forest.map((tree) => (
        <TaskTreeView
          key={tree.id}
          tree={tree}
          tagsByTask={tagsByTask}
          onDecompose={onDecompose}
        />
      ))}
    </div>
  );
}
