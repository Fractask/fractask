'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Tag, Task } from '@getshit/core';
import { moveTaskAction, reorderPriorityAction, reorderSiblingsAction } from '@/app/actions';
import { ConfirmMoveModal } from './confirm-move-modal';
import { TaskRow } from './task-row';

export const TASK_DRAG_MIME = 'application/x-getshit-task';

export type ReorderMode =
  | { kind: 'siblings'; parentId: string | null }
  | { kind: 'priority' };

export type PromoteContext = {
  toParentId: string | null;
  label: string;
};

type PendingMove = {
  source: { id: string; title: string };
  target: { id: string; title: string };
};

export function TaskList({
  tasks,
  childCounts,
  tagsByTask,
  reorder,
  onDecompose,
  promote,
}: {
  tasks: Task[];
  childCounts?: Record<string, number> | undefined;
  tagsByTask?: Record<string, Tag[]> | undefined;
  reorder?: ReorderMode | undefined;
  onDecompose?: ((task: Task) => void) | undefined;
  promote?: PromoteContext | undefined;
}) {
  const router = useRouter();
  const [order, setOrder] = useState<Task[]>(tasks);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [, start] = useTransition();

  // Re-sync if the server sends a new task list (e.g. after a create/delete).
  if (tasks !== order && tasks.map((t) => t.id).join(',') !== order.map((t) => t.id).join(',')) {
    setOrder(tasks);
  }

  const reorderable = reorder !== undefined;

  if (order.length === 0) {
    return (
      <p className="text-sm text-(--color-muted) px-2 py-4">
        No tasks yet. Press <kbd className="font-mono-id">c</kbd> or use the input below.
      </p>
    );
  }

  const onRowDragStart = (id: string) => (e: React.DragEvent) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    const task = order.find((t) => t.id === id);
    const payload = JSON.stringify({ id, title: task?.title ?? '' });
    // Some browsers don't surface custom MIME types reliably, so write the same
    // payload to text/plain as a fallback. (Also satisfies Firefox's drag-init.)
    e.dataTransfer.setData('text/plain', payload);
    e.dataTransfer.setData(TASK_DRAG_MIME, payload);
  };

  const onRowDragOver = (index: number, rowId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Foreign drag (from another TaskList or the sidebar): no local dragId, so
    // the whole row is a drop-into target — sibling reorder doesn't apply.
    if (!dragId) {
      setDropTargetId(rowId);
      setDropIndex(null);
      return;
    }

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offset = e.clientY - rect.top;
    const ratio = offset / rect.height;
    // Top 25% → drop above, bottom 25% → drop below, middle 50% → drop INTO row.
    if (ratio >= 0.25 && ratio <= 0.75 && rowId !== dragId) {
      setDropTargetId(rowId);
      setDropIndex(null);
    } else {
      setDropTargetId(null);
      setDropIndex(ratio < 0.5 ? index : index + 1);
    }
  };

  const onListDragLeave = (e: React.DragEvent) => {
    // Only clear if we left the list entirely, not just moved between rows.
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setDropIndex(null);
      setDropTargetId(null);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();

    // Foreign drag (cross-TaskList / sidebar): parse the payload from
    // dataTransfer and open the confirm modal to reparent into this row.
    if (!dragId) {
      const targetId = dropTargetId;
      setDropIndex(null);
      setDropTargetId(null);
      if (!targetId) return;
      const raw =
        e.dataTransfer.getData(TASK_DRAG_MIME) ||
        e.dataTransfer.getData('text/plain');
      if (!raw) return;
      try {
        const payload = JSON.parse(raw) as { id: string; title: string };
        if (!payload?.id || payload.id === targetId) return;
        const target = order.find((t) => t.id === targetId);
        if (!target) return;
        setPendingMove({
          source: { id: payload.id, title: payload.title ?? '' },
          target: { id: target.id, title: target.title },
        });
      } catch {
        /* not our payload */
      }
      return;
    }

    // Reparent path — open confirm modal, defer move until user confirms.
    if (dropTargetId && dropTargetId !== dragId) {
      const source = order.find((t) => t.id === dragId);
      const target = order.find((t) => t.id === dropTargetId);
      setDragId(null);
      setDropIndex(null);
      setDropTargetId(null);
      if (source && target) setPendingMove({ source, target });
      return;
    }

    if (dropIndex == null) {
      setDragId(null);
      setDropIndex(null);
      setDropTargetId(null);
      return;
    }
    const fromIndex = order.findIndex((t) => t.id === dragId);
    if (fromIndex < 0) {
      setDragId(null);
      setDropIndex(null);
      setDropTargetId(null);
      return;
    }
    let toIndex = dropIndex;
    if (toIndex > fromIndex) toIndex -= 1; // account for own removal
    if (toIndex === fromIndex) {
      setDragId(null);
      setDropIndex(null);
      setDropTargetId(null);
      return;
    }
    const next = order.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    setOrder(next);
    setDragId(null);
    setDropIndex(null);
    setDropTargetId(null);

    const ids = next.map((t) => t.id);
    start(async () => {
      const result =
        reorder?.kind === 'priority'
          ? await reorderPriorityAction(ids)
          : await reorderSiblingsAction(reorder?.parentId ?? null, ids);
      if (!result.ok) {
        // Roll back on failure.
        setOrder(order);
      }
    });
  };

  const onDragEnd = () => {
    setDragId(null);
    setDropIndex(null);
    setDropTargetId(null);
  };

  const confirmMove = () => {
    if (!pendingMove) return;
    const { source, target } = pendingMove;
    const prevOrder = order;
    setOrder(order.filter((t) => t.id !== source.id));
    setPendingMove(null);
    start(async () => {
      const result = await moveTaskAction(source.id, target.id);
      if (result.ok) router.refresh();
      else setOrder(prevOrder);
    });
  };

  const promoteRow = (id: string) => {
    if (!promote) return;
    const prevOrder = order;
    setOrder(order.filter((t) => t.id !== id));
    start(async () => {
      const result = await moveTaskAction(id, promote.toParentId);
      if (result.ok) router.refresh();
      else setOrder(prevOrder);
    });
  };

  return (
    <div
      className="flex flex-col"
      onDragLeave={reorderable ? onListDragLeave : undefined}
      onDrop={reorderable ? onDrop : undefined}
    >
      {reorderable && dropIndex === 0 && <DropIndicator />}
      {order.map((t, i) => (
        <div key={t.id}>
          <div
            onDragOver={reorderable ? onRowDragOver(i, t.id) : undefined}
            className={`${dragId === t.id ? 'opacity-40' : ''} ${
              dropTargetId === t.id
                ? 'rounded-md ring-2 ring-(--color-accent) ring-inset bg-(--color-accent)/5'
                : ''
            }`}
          >
            <TaskRow
              task={t}
              childCount={childCounts?.[t.id] ?? 0}
              tags={tagsByTask?.[t.id] ?? []}
              onDecompose={onDecompose}
              dragHandle={
                reorderable
                  ? {
                      onDragStart: onRowDragStart(t.id),
                      onDragEnd,
                    }
                  : undefined
              }
              promote={
                promote
                  ? { label: promote.label, onPromote: () => promoteRow(t.id) }
                  : undefined
              }
            />
          </div>
          {reorderable && dropIndex === i + 1 && <DropIndicator />}
        </div>
      ))}
      {pendingMove && (
        <ConfirmMoveModal
          source={pendingMove.source}
          target={pendingMove.target}
          onCancel={() => setPendingMove(null)}
          onConfirm={confirmMove}
        />
      )}
    </div>
  );
}


function DropIndicator() {
  return <div className="h-0.5 mx-2 bg-(--color-accent) rounded-full pointer-events-none" />;
}
