'use client';

import { useTransition } from 'react';
import { Archive, Moon, RotateCcw } from 'lucide-react';
import type { Task } from '@getshit/core';
import { setStatusAction } from '@/app/actions';

export function StatusBanner({
  id,
  status,
}: {
  id: string;
  status: Task['status'];
}) {
  const [pending, start] = useTransition();

  if (status !== 'archived' && status !== 'snoozed') return null;

  const Icon = status === 'archived' ? Archive : Moon;
  const label =
    status === 'archived'
      ? 'This task is archived and hidden from default views.'
      : 'This task is snoozed and hidden from default views.';

  return (
    <div className="mb-4 flex items-center gap-3 px-3 py-2 rounded-md border border-(--color-border) bg-(--color-surface)/60 text-sm">
      <Icon size={14} className="text-(--color-muted) shrink-0" />
      <span className="flex-1 text-(--color-muted)">{label}</span>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => void (await setStatusAction(id, 'open')))}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-(--color-border) hover:border-(--color-accent) hover:text-(--color-accent) text-xs cursor-pointer disabled:opacity-50"
      >
        <RotateCcw size={12} />
        Restore
      </button>
    </div>
  );
}
