'use client';

import { Archive, CheckCircle2, Circle, CircleDashed, Eye, Moon } from 'lucide-react';
import { useTransition } from 'react';
import type { TaskStatus } from '@getshit/core';
import { setStatusAction } from '@/app/actions';

// Click cycle for the four primary states; archived/snoozed restore to open.
const NEXT: Record<TaskStatus, TaskStatus> = {
  open: 'doing',
  doing: 'review',
  review: 'done',
  done: 'open',
  archived: 'open',
  snoozed: 'open',
};

const ICONS: Record<TaskStatus, typeof Circle> = {
  open: Circle,
  doing: CircleDashed,
  review: Eye,
  done: CheckCircle2,
  archived: Archive,
  snoozed: Moon,
};

const COLORS: Record<TaskStatus, string> = {
  open: 'text-(--color-muted) hover:text-(--color-fg)',
  doing: 'text-(--color-doing)',
  review: 'text-amber-500',
  done: 'text-(--color-done)',
  archived: 'text-(--color-muted)/60 hover:text-(--color-fg)',
  snoozed: 'text-(--color-muted)/60 hover:text-(--color-fg)',
};

export function StatusToggle({ id, status }: { id: string; status: TaskStatus }) {
  const [pending, start] = useTransition();
  const Icon = ICONS[status];
  const color = COLORS[status];

  return (
    <button
      type="button"
      aria-label={`status: ${status}, click to set to ${NEXT[status]}`}
      onClick={() =>
        start(async () => {
          await setStatusAction(id, NEXT[status]);
        })
      }
      disabled={pending}
      className={`shrink-0 ${color} transition-colors disabled:opacity-50 cursor-pointer`}
    >
      <Icon size={16} strokeWidth={2} />
    </button>
  );
}
