'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDashed,
  Eye,
  Layers,
  Moon,
} from 'lucide-react';
import type { TaskStatus } from '@getshit/core';
import { setStatusAction } from '@/app/actions';

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
  open: 'Open',
  doing: 'Doing',
  review: 'Needs your input',
  done: 'Done',
  backlog: 'Backlog',
  archived: 'Archived',
  snoozed: 'Snoozed',
};

const HINTS: Record<TaskStatus, string> = {
  open: 'Not started yet',
  doing: 'Agent or human is actively working on it',
  review: 'Waiting on you — approve, answer a prompt, or send back to doing',
  done: 'Finished, shipped',
  backlog: 'Noted, not now — pull when ready, no schedule',
  archived: 'Hidden from default views',
  snoozed: 'Hidden until reopened',
};

const COLORS: Record<TaskStatus, string> = {
  open: 'text-(--color-muted)',
  doing: 'text-(--color-doing)',
  review: 'text-amber-500',
  done: 'text-(--color-done)',
  backlog: 'text-(--color-muted)/70',
  archived: 'text-(--color-muted)/70',
  snoozed: 'text-(--color-muted)/70',
};

const ALL_STATUSES: TaskStatus[] = [
  'open',
  'doing',
  'review',
  'done',
  'backlog',
  'snoozed',
  'archived',
];

/**
 * Status picker rendered as a chip showing current status + a dropdown.
 *
 * Discoverable on click — shows every possible status with its label and
 * a one-line hint, so users don't have to guess what each state means or
 * cycle through to find the one they want.
 */
export function StatusPicker({ id, status }: { id: string; status: TaskStatus }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
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

  const pick = (next: TaskStatus) => {
    setOpen(false);
    if (next === status) return;
    start(async () => {
      await setStatusAction(id, next);
    });
  };

  const Icon = ICONS[status];
  const color = COLORS[status];

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Change status"
        className={`inline-flex items-center gap-1.5 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1 text-xs font-medium hover:border-(--color-accent) disabled:opacity-50 cursor-pointer ${color}`}
      >
        <Icon size={13} />
        <span>{LABELS[status]}</span>
        <ChevronDown size={12} className="text-(--color-muted)" />
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute left-0 z-20 mt-1 w-56 rounded-md border border-(--color-border) bg-(--color-bg) py-1 shadow-lg"
        >
          {ALL_STATUSES.map((s) => {
            const IconS = ICONS[s];
            const selected = s === status;
            return (
              <li key={s}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => pick(s)}
                  className={`flex w-full items-start gap-2 px-2 py-1.5 text-left text-xs hover:bg-(--color-surface) ${
                    selected ? 'bg-(--color-surface)' : ''
                  }`}
                >
                  <IconS size={14} className={`mt-0.5 ${COLORS[s]}`} />
                  <span className="flex flex-col">
                    <span className="font-medium text-(--color-fg)">{LABELS[s]}</span>
                    <span className="text-(--color-muted)">{HINTS[s]}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
