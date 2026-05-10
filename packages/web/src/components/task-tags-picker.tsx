'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Plus, X } from 'lucide-react';
import type { Tag } from '@getshit/core';
import {
  addTagToTaskAction,
  createTagAction,
  removeTagFromTaskAction,
} from '@/app/tags-actions';

export function TaskTagsPicker({
  taskId,
  initialTags,
  allTags,
}: {
  taskId: string;
  initialTags: Tag[];
  allTags: Tag[];
}) {
  const [selected, setSelected] = useState<Tag[]>(initialTags);
  const [available, setAvailable] = useState<Tag[]>(allTags);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, start] = useTransition();
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selectedIds = new Set(selected.map((t) => t.id));
  const filtered = available.filter(
    (t) => !selectedIds.has(t.id) && t.name.toLowerCase().includes(query.toLowerCase()),
  );

  const attach = (tag: Tag) => {
    setSelected((prev) => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)));
    start(async () => {
      const result = await addTagToTaskAction(taskId, tag.id);
      if (!result.ok) setSelected((prev) => prev.filter((p) => p.id !== tag.id));
    });
  };

  const detach = (tag: Tag) => {
    setSelected((prev) => prev.filter((p) => p.id !== tag.id));
    start(async () => {
      const result = await removeTagFromTaskAction(taskId, tag.id);
      if (!result.ok)
        setSelected((prev) => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)));
    });
  };

  const createAndAttach = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    if (
      available.some((t) => t.name.toLowerCase() === trimmed.toLowerCase()) ||
      selected.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())
    ) {
      return;
    }
    start(async () => {
      const created = await createTagAction({ name: trimmed });
      if (!created.ok) return;
      setAvailable((prev) =>
        [...prev, created.value].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setQuery('');
      const attached = await addTagToTaskAction(taskId, created.value.id);
      if (attached.ok) {
        setSelected((prev) =>
          [...prev, created.value].sort((a, b) => a.name.localeCompare(b.name)),
        );
      }
    });
  };

  return (
    <div className="flex items-center flex-wrap gap-1.5">
      {selected.map((t) => (
        <span
          key={t.id}
          className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-full text-xs border"
          style={{
            borderColor: t.color ?? 'var(--color-border)',
            backgroundColor: t.color ? `${t.color}1A` : 'var(--color-surface)',
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: t.color ?? 'var(--color-muted)' }}
          />
          {t.name}
          <button
            type="button"
            onClick={() => detach(t)}
            disabled={pending}
            className="p-0.5 rounded hover:bg-(--color-surface) text-(--color-muted) hover:text-red-400 cursor-pointer"
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <div className="relative" ref={popoverRef}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border border-dashed border-(--color-border) text-(--color-muted) hover:text-(--color-fg) hover:border-(--color-fg) cursor-pointer"
        >
          <Plus size={11} /> Tag
        </button>
        {open && (
          <div className="absolute left-0 top-full mt-1 z-20 w-56 rounded-md border border-(--color-border) bg-(--color-surface) shadow-lg p-1.5 flex flex-col gap-1">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  filtered.length === 0 &&
                  query.trim().length > 0
                ) {
                  e.preventDefault();
                  createAndAttach();
                }
              }}
              placeholder="Search or create…"
              className="bg-(--color-bg) rounded px-2 py-1 text-xs outline-none border border-(--color-border) focus:border-(--color-accent)"
            />
            <div className="max-h-48 overflow-y-auto flex flex-col">
              {filtered.length === 0 && query.trim().length > 0 && (
                <button
                  type="button"
                  onClick={createAndAttach}
                  disabled={pending}
                  className="text-left px-2 py-1 rounded text-xs hover:bg-(--color-surface-2) cursor-pointer text-(--color-accent)"
                >
                  + Create &ldquo;{query.trim()}&rdquo;
                </button>
              )}
              {filtered.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => attach(t)}
                  disabled={pending}
                  className="flex items-center gap-1.5 text-left px-2 py-1 rounded text-xs hover:bg-(--color-surface-2) cursor-pointer"
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: t.color ?? 'var(--color-muted)' }}
                  />
                  {t.name}
                </button>
              ))}
              {filtered.length === 0 && query.trim().length === 0 && (
                <p className="text-xs text-(--color-muted) px-2 py-1">All tags applied.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
