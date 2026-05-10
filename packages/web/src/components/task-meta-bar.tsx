'use client';

import { useRef, useState, useTransition } from 'react';
import { Calendar, Eye, Repeat, User as UserIcon, X } from 'lucide-react';
import type { Assignee } from '@getshit/core';
import { updateTaskAction } from '@/app/actions';
import { PeoplePicker } from './people-picker';

const RECURRENCE_PRESETS: { value: string; label: string }[] = [
  { value: '15m', label: 'Every 15 min' },
  { value: '30m', label: 'Every 30 min' },
  { value: '1h', label: 'Hourly' },
  { value: '4h', label: 'Every 4 hours' },
  { value: '1d', label: 'Daily' },
  { value: '1w', label: 'Weekly' },
  { value: '1mo', label: 'Monthly' },
];

function toDateInputValue(ms: number | null): string {
  if (ms == null) return '';
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fromDateInputValue(value: string): number | null {
  if (!value) return null;
  const parts = value.split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (y == null || m == null || d == null) return null;
  // Local-time end of day so the task is still "due today" through the user's day.
  const dt = new Date(y, m - 1, d, 23, 59, 0, 0);
  return dt.getTime();
}

function formatDue(ms: number | null): string {
  if (ms == null) return 'Due date';
  const d = new Date(ms);
  const today = new Date();
  const isSameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (isSameDay) return 'Today';
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate()
  ) {
    return 'Tomorrow';
  }
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

function recurrenceLabel(value: string | null): string {
  if (!value) return 'Repeat';
  const preset = RECURRENCE_PRESETS.find((p) => p.value === value);
  return preset ? preset.label : value;
}

export function TaskMetaBar({
  taskId,
  dueAt,
  assigneeId,
  reviewerId,
  recurrence,
  assignees,
}: {
  taskId: string;
  dueAt: number | null;
  assigneeId: string | null;
  reviewerId: string | null;
  recurrence: string | null;
  assignees: Assignee[];
}) {
  const [pending, start] = useTransition();
  const [localDue, setLocalDue] = useState<number | null>(dueAt);
  const [localAssignee, setLocalAssignee] = useState<string | null>(assigneeId);
  const [localReviewer, setLocalReviewer] = useState<string | null>(reviewerId);
  const [localRecurrence, setLocalRecurrence] = useState<string | null>(recurrence);
  const [error, setError] = useState<string | null>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  const openDatePicker = () => {
    const el = dateInputRef.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker();
        return;
      } catch {
        // showPicker can throw in some non-user-activation contexts.
      }
    }
    el.focus();
    el.click();
  };

  const update = (patch: {
    dueAt?: number | null;
    assigneeId?: string | null;
    reviewerId?: string | null;
    recurrence?: string | null;
  }) => {
    start(async () => {
      const result = await updateTaskAction(taskId, patch);
      if (!result.ok) setError(result.error);
      else setError(null);
    });
  };

  const onDue = (value: string) => {
    const ms = fromDateInputValue(value);
    setLocalDue(ms);
    update({ dueAt: ms });
  };

  const onAssignee = (id: string | null) => {
    setLocalAssignee(id);
    update({ assigneeId: id });
  };

  const onReviewer = (id: string | null) => {
    setLocalReviewer(id);
    update({ reviewerId: id });
  };

  const onRecurrence = (value: string) => {
    const next = value === '' ? null : value;
    setLocalRecurrence(next);
    update({ recurrence: next });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <div
        className={`relative inline-flex items-center gap-1.5 px-2 py-1 rounded-full border cursor-pointer select-none ${
          localDue != null
            ? 'border-(--color-accent) text-(--color-fg) bg-(--color-surface)'
            : 'border-dashed border-(--color-border) text-(--color-muted) hover:text-(--color-fg) hover:border-(--color-fg)'
        }`}
        onClick={openDatePicker}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openDatePicker();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Set due date"
      >
        <Calendar size={12} />
        <span>{formatDue(localDue)}</span>
        <input
          ref={dateInputRef}
          type="date"
          value={toDateInputValue(localDue)}
          onChange={(e) => onDue(e.target.value)}
          disabled={pending}
          tabIndex={-1}
          aria-hidden
          className="absolute left-0 top-full opacity-0 pointer-events-none w-0 h-0"
          style={{ colorScheme: 'dark' }}
        />
        {localDue != null && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setLocalDue(null);
              update({ dueAt: null });
            }}
            disabled={pending}
            className="relative z-10 p-0.5 rounded hover:bg-(--color-surface-2) text-(--color-muted) hover:text-red-400 cursor-pointer"
            aria-label="Clear due date"
          >
            <X size={10} />
          </button>
        )}
      </div>

      <PeoplePicker
        selectedId={localAssignee}
        assignees={assignees}
        onChange={onAssignee}
        pending={pending}
        triggerIcon={<UserIcon size={12} />}
        triggerLabel={(a) => a.name}
        emptyLabel="Assignee"
      />

      <PeoplePicker
        selectedId={localReviewer}
        assignees={assignees}
        onChange={onReviewer}
        pending={pending}
        triggerIcon={<Eye size={12} />}
        triggerLabel={(a) => `Review: ${a.name}`}
        emptyLabel="Reviewer"
        triggerColor="border-amber-500"
      />

      <label
        className={`relative inline-flex items-center gap-1.5 px-2 py-1 rounded-full border cursor-pointer ${
          localRecurrence
            ? 'border-(--color-accent) text-(--color-fg) bg-(--color-surface)'
            : 'border-dashed border-(--color-border) text-(--color-muted) hover:text-(--color-fg) hover:border-(--color-fg)'
        }`}
        title="Recurring tasks bump their due date forward when marked done"
      >
        <Repeat size={12} />
        <span>{recurrenceLabel(localRecurrence)}</span>
        <select
          value={localRecurrence ?? ''}
          onChange={(e) => onRecurrence(e.target.value)}
          disabled={pending}
          aria-label="Recurrence"
          className="absolute inset-0 opacity-0 cursor-pointer"
        >
          <option value="">— No repeat —</option>
          {RECURRENCE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
