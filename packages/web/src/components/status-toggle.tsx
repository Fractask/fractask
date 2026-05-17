'use client';

import { Archive, CheckCircle2, Circle, CircleDashed, Eye, Layers, Moon } from 'lucide-react';
import { useTransition } from 'react';
import type { TaskStatus } from '@getshit/core';
import { setStatusAction } from '@/app/actions';

// Click cycle for the four primary states. The "parked" states (backlog /
// snoozed / archived) all restore to open on click — they're never cycle
// targets, only destinations via the dropdown picker.
const NEXT: Record<TaskStatus, TaskStatus> = {
  open: 'doing',
  doing: 'review',
  review: 'done',
  done: 'open',
  backlog: 'open',
  archived: 'open',
  snoozed: 'open',
};

const ICONS: Record<TaskStatus, typeof Circle> = {
  open: Circle,
  doing: CircleDashed,
  review: Eye,
  done: CheckCircle2,
  backlog: Layers,
  archived: Archive,
  snoozed: Moon,
};

const LABELS: Record<TaskStatus, string> = {
  open: 'open',
  doing: 'doing',
  review: 'review',
  done: 'done',
  backlog: 'backlog',
  archived: 'archived',
  snoozed: 'snoozed',
};

const COLORS: Record<TaskStatus, string> = {
  open: 'text-(--color-muted) hover:text-(--color-fg)',
  doing: 'text-(--color-doing)',
  review: 'text-amber-500',
  done: 'text-(--color-done)',
  backlog: 'text-(--color-muted)/60 hover:text-(--color-fg)',
  archived: 'text-(--color-muted)/60 hover:text-(--color-fg)',
  snoozed: 'text-(--color-muted)/60 hover:text-(--color-fg)',
};

/**
 * Compact status control: icon (always) + optional inline label.
 * Click cycles through open → doing → review → done → open.
 *
 * For an explicit picker (every state in a dropdown), use `<StatusPicker>`
 * instead — that's the right surface for the task detail page header.
 */
export function StatusToggle({
  id,
  status,
  showLabel,
}: {
  id: string;
  status: TaskStatus;
  showLabel?: boolean;
}) {
  const [pending, start] = useTransition();
  const Icon = ICONS[status];
  const color = COLORS[status];
  const next = NEXT[status];

  return (
    <button
      type="button"
      aria-label={`Status: ${LABELS[status]}. Click to mark ${LABELS[next]}`}
      title={`${LABELS[status]} — click to mark ${LABELS[next]}`}
      onClick={() =>
        start(async () => {
          await setStatusAction(id, next);
        })
      }
      disabled={pending}
      className={`shrink-0 inline-flex items-center gap-1.5 ${color} transition-colors disabled:opacity-50 cursor-pointer`}
    >
      <Icon size={16} strokeWidth={2} />
      {showLabel && (
        <span className="text-[10px] uppercase tracking-wide font-medium hidden sm:inline">
          {LABELS[status]}
        </span>
      )}
    </button>
  );
}
