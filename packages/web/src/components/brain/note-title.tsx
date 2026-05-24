'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { updateBrainNoteAction } from '@/app/brain-actions';

/**
 * Inline-editable title for a brain note. Commits on blur or Enter.
 * Single source of truth: server. Updates are debounced via a transition
 * to avoid janky re-renders.
 */
export function EditableNoteTitle({
  noteId,
  initial,
}: {
  noteId: string;
  initial: string;
}) {
  const [value, setValue] = useState(initial);
  const [, start] = useTransition();
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => setValue(initial), [initial]);

  const commit = () => {
    const next = value.trim() || initial;
    if (next === initial) return;
    start(async () => {
      await updateBrainNoteAction(noteId, { title: next });
    });
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          ref.current?.blur();
        } else if (e.key === 'Escape') {
          setValue(initial);
          ref.current?.blur();
        }
      }}
      placeholder="Untitled"
      className="w-full bg-transparent text-3xl font-semibold tracking-tight text-(--color-fg) placeholder:text-(--color-muted) outline-none"
    />
  );
}
