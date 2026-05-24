'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Plus, ChevronRight } from 'lucide-react';
import type { BrainNote } from '@getshit/core';
import { createBrainNoteAction, deleteBrainNoteAction } from '@/app/brain-actions';

/**
 * Renders the direct children of a note (or the index "roots") with an inline
 * "+ new" form. Kept minimal — no drag-reorder, no rename-inline (open the
 * note for that). Drives both the index `/brain` view and per-note child
 * lists.
 */
export function NoteChildren({
  parentNoteId,
  scopeTaskId,
  children,
  emptyLabel,
}: {
  parentNoteId: string | null;
  scopeTaskId: string | null;
  children: BrainNote[];
  emptyLabel?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState('');

  const create = () => {
    const title = draft.trim();
    if (!title) return;
    start(async () => {
      const r = await createBrainNoteAction({
        title,
        ...(parentNoteId !== null ? { parentNoteId } : {}),
        ...(scopeTaskId !== null ? { scopeTaskId } : {}),
      });
      if (r.ok) {
        setDraft('');
        router.push(`/brain/${r.value.id}`);
      }
    });
  };

  const remove = (id: string) => {
    if (!window.confirm('Delete this note and all its children?')) return;
    start(async () => {
      await deleteBrainNoteAction(id);
      router.refresh();
    });
  };

  return (
    <section className="flex flex-col gap-1">
      {children.length === 0 && (
        <p className="px-2 text-xs text-(--color-muted) italic">
          {emptyLabel ?? 'No notes yet.'}
        </p>
      )}
      {children.map((c) => (
        <div
          key={c.id}
          className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-(--color-surface)"
        >
          <span className="w-4 text-center text-base leading-none">{c.icon ?? '📄'}</span>
          <Link href={`/brain/${c.id}`} className="flex-1 truncate text-sm">
            {c.title}
          </Link>
          <button
            type="button"
            onClick={() => remove(c.id)}
            className="opacity-0 group-hover:opacity-100 text-[10px] uppercase tracking-wider text-(--color-muted) hover:text-red-400 cursor-pointer"
          >
            Delete
          </button>
          <Link href={`/brain/${c.id}`} className="text-(--color-muted) hover:text-(--color-fg)">
            <ChevronRight size={14} />
          </Link>
        </div>
      ))}
      <div className="mt-1 flex items-center gap-2 px-2">
        <Plus size={14} className="text-(--color-muted)" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="New note title"
          disabled={pending}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              create();
            }
          }}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-(--color-muted) py-1"
        />
        <button
          type="button"
          onClick={create}
          disabled={pending || draft.trim().length === 0}
          className="rounded border border-(--color-border) px-2 py-0.5 text-xs hover:border-(--color-accent) disabled:opacity-50 cursor-pointer"
        >
          Add
        </button>
      </div>
    </section>
  );
}
