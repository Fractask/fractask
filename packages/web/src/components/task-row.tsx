'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import {
  Archive,
  ChevronRight,
  CornerLeftUp,
  Gauge,
  GripVertical,
  Moon,
  Pencil,
  Sparkles,
  Target,
  Trash2,
} from 'lucide-react';
import type { Tag, Task } from '@getshit/core';
import { deleteTaskAction, setStatusAction, updateTaskAction } from '@/app/actions';
import { StatusToggle } from './status-toggle';
import { formatRelativeDate } from '@/lib/sort';

export type DragHandleProps = {
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
};

export type PromoteProps = {
  label: string;
  onPromote: () => void;
};

export function TaskRow({
  task,
  childCount = 0,
  tags = [],
  onDecompose,
  density = 'comfy',
  dragHandle,
  promote,
  showDate,
}: {
  task: Task;
  childCount?: number | undefined;
  tags?: Tag[] | undefined;
  onDecompose?: ((task: Task) => void) | undefined;
  density?: 'comfy' | 'compact' | undefined;
  dragHandle?: DragHandleProps | undefined;
  promote?: PromoteProps | undefined;
  showDate?: 'createdAt' | 'updatedAt' | undefined;
}) {
  const [editing, setEditing] = useState(false);

  const padding = density === 'compact' ? 'py-1' : 'py-1.5';
  const isDone = task.status === 'done';

  return (
    <div
      data-task-row
      data-task-id={task.id}
      className={`group flex items-center gap-2 px-2 ${padding} rounded-md hover:bg-(--color-surface) focus-within:bg-(--color-surface)`}
    >
      {dragHandle && (
        <span
          draggable
          onDragStart={dragHandle.onDragStart}
          onDragEnd={dragHandle.onDragEnd}
          title="Drag to reorder or move to another parent"
          className="text-(--color-muted)/60 hover:text-(--color-fg) cursor-grab active:cursor-grabbing -ml-1 shrink-0"
        >
          <GripVertical size={14} />
        </span>
      )}
      <StatusToggle id={task.id} status={task.status} showLabel />
      {task.kind === 'goal' && (
        <Target size={12} className="text-(--color-muted) shrink-0" aria-label="Goal" />
      )}
      {task.kind === 'kpi' && (
        <Gauge size={12} className="text-(--color-muted) shrink-0" aria-label="KPI" />
      )}
      {editing ? (
        <RenameField
          id={task.id}
          initial={task.title}
          done={() => setEditing(false)}
        />
      ) : (
        <Link
          href={`/${task.id}`}
          className={`flex-1 truncate text-sm ${isDone ? 'line-through text-(--color-muted)' : ''}`}
          data-task-link
        >
          {task.title}
        </Link>
      )}
      {!editing && tags.length > 0 && (
        <div className="flex items-center gap-1 shrink-0">
          {tags.slice(0, 3).map((t) => (
            <span key={t.id} title={t.name}>
              {/* Mobile: dot only — keep the title wide. */}
              <span
                className="md:hidden inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: t.color ?? 'var(--color-muted)' }}
              />
              {/* md+: full pill with name. */}
              <span
                className="hidden md:inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[10px] border"
                style={{
                  borderColor: t.color ?? 'var(--color-border)',
                  backgroundColor: t.color ? `${t.color}1A` : 'var(--color-surface)',
                  color: t.color ?? 'var(--color-muted)',
                }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: t.color ?? 'var(--color-muted)' }}
                />
                {t.name}
              </span>
            </span>
          ))}
          {tags.length > 3 && (
            <span className="text-[10px] text-(--color-muted)">+{tags.length - 3}</span>
          )}
        </div>
      )}
      {childCount > 0 && !editing && (
        <span className="font-mono-id text-(--color-muted)">{childCount}</span>
      )}
      {!editing && showDate && (
        <span
          className="font-mono-id text-[10px] text-(--color-muted)/80 hidden sm:inline"
          title={
            showDate === 'createdAt'
              ? `Created ${new Date(task.createdAt).toLocaleString()}`
              : `Updated ${new Date(task.updatedAt).toLocaleString()}`
          }
        >
          {formatRelativeDate(task[showDate])}
        </span>
      )}
      {!editing && (
        <span className="font-mono-id text-(--color-muted) hidden md:inline">
          {task.id.slice(0, 8)}
        </span>
      )}
      {!editing && (
        <div className="hidden md:flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button
            type="button"
            title="Rename"
            onClick={() => setEditing(true)}
            className="p-1 rounded hover:bg-(--color-surface-2) text-(--color-muted) hover:text-(--color-fg) cursor-pointer"
          >
            <Pencil size={14} />
          </button>
          {promote && (
            <button
              type="button"
              title={promote.label}
              onClick={promote.onPromote}
              className="p-1 rounded hover:bg-(--color-surface-2) text-(--color-muted) hover:text-(--color-fg) cursor-pointer"
            >
              <CornerLeftUp size={14} />
            </button>
          )}
          {onDecompose && (
            <button
              type="button"
              title="Decompose with AI"
              onClick={() => onDecompose(task)}
              className="p-1 rounded hover:bg-(--color-surface-2) text-(--color-muted) hover:text-(--color-accent) cursor-pointer"
            >
              <Sparkles size={14} />
            </button>
          )}
          <StatusButton
            id={task.id}
            target="snoozed"
            currentStatus={task.status}
            title={task.status === 'snoozed' ? 'Unsnooze' : 'Snooze'}
            icon={Moon}
          />
          <StatusButton
            id={task.id}
            target="archived"
            currentStatus={task.status}
            title={task.status === 'archived' ? 'Unarchive' : 'Archive'}
            icon={Archive}
          />
          <Link
            href={`/${task.id}`}
            title="Focus"
            className="p-1 rounded hover:bg-(--color-surface-2) text-(--color-muted) hover:text-(--color-fg)"
          >
            <ChevronRight size={14} />
          </Link>
          <RemoveButton id={task.id} title={task.title} />
        </div>
      )}
    </div>
  );
}

function RenameField({
  id,
  initial,
  done,
}: {
  id: string;
  initial: string;
  done: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === initial) {
      done();
      return;
    }
    start(async () => {
      await updateTaskAction(id, { title: trimmed });
      done();
    });
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done();
        }
      }}
      disabled={pending}
      className="flex-1 bg-(--color-surface) border-b border-(--color-accent) outline-none px-1 text-sm"
    />
  );
}

function StatusButton({
  id,
  target,
  currentStatus,
  title,
  icon: Icon,
}: {
  id: string;
  target: 'archived' | 'snoozed';
  currentStatus: Task['status'];
  title: string;
  icon: typeof Archive;
}) {
  const [pending, start] = useTransition();
  const active = currentStatus === target;
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      disabled={pending}
      onClick={() => {
        // Toggle: clicking the matching button restores to open; otherwise sets target.
        const next: Task['status'] = active ? 'open' : target;
        start(async () => {
          await setStatusAction(id, next);
        });
      }}
      className={`p-1 rounded hover:bg-(--color-surface-2) cursor-pointer disabled:opacity-50 ${
        active
          ? 'text-(--color-accent)'
          : 'text-(--color-muted) hover:text-(--color-fg)'
      }`}
    >
      <Icon size={14} />
    </button>
  );
}

function RemoveButton({ id, title }: { id: string; title: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      title="Delete"
      disabled={pending}
      onClick={() => {
        if (!confirm(`Delete "${title}" and all subtasks?`)) return;
        start(async () => {
          await deleteTaskAction(id);
        });
      }}
      className="p-1 rounded hover:bg-(--color-surface-2) text-(--color-muted) hover:text-red-400 cursor-pointer disabled:opacity-50"
    >
      <Trash2 size={14} />
    </button>
  );
}
