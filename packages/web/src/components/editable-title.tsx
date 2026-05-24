'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Pencil } from 'lucide-react';
import { updateTaskAction } from '@/app/actions';

/**
 * Header-style editable title used on the focus page. Click the pencil or
 * double-click the heading to edit; Enter saves, Esc cancels, blur saves.
 */
export function EditableHeading({
  id,
  initial,
  done = false,
}: {
  id: string;
  initial: string;
  done?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => setValue(initial), [initial]);

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === initial) {
      setValue(initial);
      setEditing(false);
      return;
    }
    start(async () => {
      const r = await updateTaskAction(id, { title: trimmed });
      if (!r.ok) setValue(initial);
      setEditing(false);
    });
  };

  if (editing) {
    return (
      <input
        ref={ref}
        dir="auto"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setValue(initial);
            setEditing(false);
          }
        }}
        disabled={pending}
        className="text-xl font-medium tracking-tight bg-(--color-surface) border-b border-(--color-accent) outline-none px-1 w-full"
      />
    );
  }

  return (
    <div className="group flex items-center gap-2 min-w-0">
      <h1
        dir="auto"
        onDoubleClick={() => setEditing(true)}
        title="Double-click to rename"
        className={`text-xl font-medium tracking-tight break-words ${done ? 'line-through text-(--color-muted)' : ''}`}
      >
        {initial}
      </h1>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Rename"
        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-(--color-surface) text-(--color-muted) hover:text-(--color-fg) cursor-pointer"
      >
        <Pencil size={14} />
      </button>
    </div>
  );
}
