'use client';

import { useRef, useState, useTransition } from 'react';
import { Plus } from 'lucide-react';
import type { TaskKind } from '@getshit/core';
import { createTaskAction } from '@/app/actions';

const PLACEHOLDER: Record<TaskKind, string> = {
  entity: 'Add an entity (company, area)…',
  project: 'Add a project…',
  task: 'Add a task…',
  goal: 'Add a goal…',
  kpi: 'Add a KPI…',
};

export function NewTaskForm({
  parentId,
  defaultKind,
  showKindPicker,
}: {
  parentId?: string | null;
  defaultKind?: TaskKind;
  showKindPicker?: boolean;
}) {
  const initial: TaskKind = defaultKind ?? 'task';
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<TaskKind>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    start(async () => {
      const result = await createTaskAction({
        title: trimmed,
        ...(parentId ? { parentId } : {}),
        ...(kind !== 'task' ? { kind } : {}),
      });
      if (result.ok) {
        setTitle('');
        setError(null);
        inputRef.current?.focus();
      } else {
        setError(result.error);
      }
    });
  };

  // Placeholder reflects current kind so it's clear what will be created.
  const placeholder = parentId && kind === 'task' ? 'Add a subtask…' : PLACEHOLDER[kind];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-new-task-form
      className="flex flex-col gap-1"
    >
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-(--color-border) bg-(--color-surface) focus-within:border-(--color-accent)">
        <Plus size={14} className="text-(--color-muted)" />
        <input
          ref={inputRef}
          data-new-task-input
          name="title"
          placeholder={placeholder}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={pending}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-(--color-muted) disabled:opacity-50"
        />
        {showKindPicker !== false && (
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as TaskKind)}
            disabled={pending}
            className="bg-transparent text-xs text-(--color-muted) outline-none border-none cursor-pointer"
            aria-label="Kind"
          >
            <option value="task">Task</option>
            <option value="project">Project</option>
            <option value="entity">Entity</option>
            <option value="goal">Goal</option>
            <option value="kpi">KPI</option>
          </select>
        )}
        <span className="font-mono-id text-(--color-muted)">⏎</span>
      </div>
      {error && <p className="px-2 text-xs text-red-400">{error}</p>}
    </form>
  );
}
