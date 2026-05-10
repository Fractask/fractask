'use client';

import { Sparkles, X, Check, Pencil } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { Task } from '@getshit/core';
import { createTaskAction, decomposeAction } from '@/app/actions';
import type { DecomposeDraft } from '@/lib/anthropic';
import { ModelPicker, useStoredModelId } from './model-picker';

type DraftWithState = DecomposeDraft & { id: string; status: 'pending' | 'accepted' | 'rejected' };

export function DecomposeModal({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState<DraftWithState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, start] = useTransition();
  const dialogRef = useRef<HTMLDivElement>(null);
  const modelId = useStoredModelId();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const result = await decomposeAction(task.id, modelId);
      if (cancelled) return;
      setLoading(false);
      if (result.ok) {
        setDrafts(
          result.value.map((d, i) => ({
            ...d,
            id: `draft-${i}`,
            status: 'pending' as const,
          })),
        );
      } else {
        setError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task.id, modelId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const updateDraft = (id: string, patch: Partial<DraftWithState>) => {
    setDrafts((cur) => (cur ? cur.map((d) => (d.id === id ? { ...d, ...patch } : d)) : cur));
  };

  const acceptAll = () => {
    if (!drafts) return;
    const toAccept = drafts.filter((d) => d.status !== 'rejected');
    start(async () => {
      for (const draft of toAccept) {
        await createTaskAction({
          title: draft.title,
          parentId: task.id,
          ...(draft.description ? { description: draft.description } : {}),
        });
      }
      onClose();
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-lg border border-(--color-border) bg-(--color-bg) shadow-2xl"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-(--color-border)">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles size={16} className="text-(--color-accent)" />
            <h2 className="text-sm font-medium truncate">Decompose: {task.title}</h2>
          </div>
          <div className="flex items-center gap-2">
            <ModelPicker />
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-(--color-surface) cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="p-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-(--color-muted)">
              <Sparkles size={14} className="animate-pulse" />
              Asking the model to break this down…
            </div>
          )}
          {error && <p className="text-sm text-red-400">Error: {error}</p>}
          {drafts && (
            <div className="flex flex-col gap-2">
              {drafts.map((d) => (
                <DraftCard
                  key={d.id}
                  draft={d}
                  onChange={(patch) => updateDraft(d.id, patch)}
                />
              ))}
            </div>
          )}
        </div>

        {drafts && (
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-(--color-border)">
            <span className="text-xs text-(--color-muted) mr-auto">
              {drafts.filter((d) => d.status !== 'rejected').length} of {drafts.length} will be created
            </span>
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded border border-(--color-border) hover:bg-(--color-surface) cursor-pointer"
            >
              Cancel
            </button>
            <button
              disabled={submitting}
              onClick={acceptAll}
              className="px-3 py-1.5 text-xs rounded bg-(--color-accent) text-black hover:opacity-90 disabled:opacity-50 cursor-pointer"
            >
              {submitting ? 'Creating…' : 'Accept all'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DraftCard({
  draft,
  onChange,
}: {
  draft: DraftWithState;
  onChange: (patch: Partial<DraftWithState>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const dimmed = draft.status === 'rejected';

  return (
    <div
      className={`rounded border border-(--color-border) p-3 ${dimmed ? 'opacity-40' : 'bg-(--color-surface)'}`}
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <input
            value={draft.title}
            onChange={(e) => onChange({ title: e.target.value })}
            className="bg-transparent border-b border-(--color-border) px-1 py-0.5 text-sm outline-none focus:border-(--color-accent)"
          />
          <textarea
            value={draft.description ?? ''}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="Description (optional)"
            rows={2}
            className="bg-transparent border border-(--color-border) rounded p-1 text-xs outline-none focus:border-(--color-accent) resize-y"
          />
          <button
            onClick={() => setEditing(false)}
            className="self-end text-xs px-2 py-1 rounded hover:bg-(--color-surface-2) cursor-pointer"
          >
            Done
          </button>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">{draft.title}</div>
            {draft.description && (
              <p className="text-xs text-(--color-muted) mt-0.5">{draft.description}</p>
            )}
          </div>
          <button
            onClick={() => setEditing(true)}
            title="Edit"
            className="p-1 rounded hover:bg-(--color-surface-2) text-(--color-muted) cursor-pointer"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={() =>
              onChange({ status: draft.status === 'rejected' ? 'pending' : 'rejected' })
            }
            title={draft.status === 'rejected' ? 'Restore' : 'Reject'}
            className="p-1 rounded hover:bg-(--color-surface-2) text-(--color-muted) hover:text-red-400 cursor-pointer"
          >
            {draft.status === 'rejected' ? <Check size={12} /> : <X size={12} />}
          </button>
        </div>
      )}
    </div>
  );
}
