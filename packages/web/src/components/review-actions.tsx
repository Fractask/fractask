'use client';

import { useTransition } from 'react';
import { CheckCircle2, CornerDownRight } from 'lucide-react';
import { setStatusAction } from '@/app/actions';

/**
 * Shown when a task is in `status='review'` and there are no pending prompts
 * left. Two explicit next steps so the human doesn't have to guess: send the
 * task back to the agent (`doing`) or mark it shipped (`done`).
 */
export function ReviewActions({
  id,
  pendingPromptCount,
}: {
  id: string;
  pendingPromptCount: number;
}) {
  const [pending, start] = useTransition();
  // While prompts are still open, we don't want to short-circuit them with a
  // status flip — the human should answer them first.
  if (pendingPromptCount > 0) return null;

  const move = (next: 'doing' | 'done') => {
    start(async () => {
      await setStatusAction(id, next);
    });
  };

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
      <p className="text-xs text-amber-500">
        <strong className="font-semibold">In review.</strong> When you're done, pick the next step:
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => move('doing')}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded border border-(--color-border) bg-(--color-surface) px-2.5 py-1 text-xs font-medium hover:border-(--color-accent) disabled:opacity-50 cursor-pointer"
        >
          <CornerDownRight size={12} />
          Hand back to agent
          <span className="text-(--color-muted)">(doing)</span>
        </button>
        <button
          type="button"
          onClick={() => move('done')}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50 cursor-pointer"
        >
          <CheckCircle2 size={12} />
          Mark done
        </button>
      </div>
    </div>
  );
}
