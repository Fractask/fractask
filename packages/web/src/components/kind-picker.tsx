'use client';

import { useTransition } from 'react';
import { Building2, FolderKanban, Gauge, ListChecks, Target } from 'lucide-react';
import type { TaskKind } from '@getshit/core';
import { updateTaskAction } from '@/app/actions';

const LABELS: Record<TaskKind, string> = {
  entity: 'Entity',
  project: 'Project',
  task: 'Task',
  goal: 'Goal',
  kpi: 'KPI',
};

const ICONS: Record<TaskKind, typeof Building2> = {
  entity: Building2,
  project: FolderKanban,
  task: ListChecks,
  goal: Target,
  kpi: Gauge,
};

export function KindPicker({ id, kind }: { id: string; kind: TaskKind }) {
  const [pending, start] = useTransition();
  const Icon = ICONS[kind];

  const change = (next: TaskKind) => {
    if (next === kind) return;
    start(async () => {
      await updateTaskAction(id, { kind: next });
    });
  };

  return (
    <label className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-(--color-muted) hover:text-(--color-fg) cursor-pointer">
      <Icon size={12} />
      <select
        value={kind}
        onChange={(e) => change(e.target.value as TaskKind)}
        disabled={pending}
        className="bg-transparent outline-none border-none cursor-pointer uppercase tracking-wider"
        aria-label="Kind"
      >
        {(['entity', 'project', 'task', 'goal', 'kpi'] as TaskKind[]).map((k) => (
          <option key={k} value={k}>
            {LABELS[k]}
          </option>
        ))}
      </select>
    </label>
  );
}
