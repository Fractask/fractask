'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Tag } from '@getshit/core';
import { createTagAction, deleteTagAction, updateTagAction } from '@/app/tags-actions';

const COLORS = ['#fb923c', '#60a5fa', '#34d399', '#a78bfa', '#f472b6', '#facc15', '#94a3b8'];

export function TagsManager({ initial }: { initial: Tag[] }) {
  const [items, setItems] = useState<Tag[]>(initial);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string | null>(COLORS[0] ?? null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    start(async () => {
      const result = await createTagAction({ name: trimmed, color });
      if (result.ok) {
        setItems((prev) => [...prev, result.value].sort((a, b) => a.name.localeCompare(b.name)));
        setName('');
        setError(null);
      } else {
        setError(result.error);
      }
    });
  };

  const remove = (id: string) => {
    if (!confirm('Delete this tag? It will be removed from all tasks.')) return;
    start(async () => {
      const result = await deleteTagAction(id);
      if (result.ok) setItems((prev) => prev.filter((t) => t.id !== id));
      else setError(result.error);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-2 p-3 rounded-md border border-(--color-border) bg-(--color-surface)"
      >
        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tag name (e.g. development, ops, marketing)"
            disabled={pending}
            className="flex-1 bg-(--color-bg) rounded px-2 py-1.5 text-sm outline-none border border-(--color-border) focus:border-(--color-accent)"
          />
          <button
            type="submit"
            disabled={pending || !name.trim()}
            className="flex items-center gap-1 px-3 py-1.5 rounded text-sm bg-(--color-accent) text-(--color-bg) hover:opacity-90 disabled:opacity-50 cursor-pointer"
          >
            <Plus size={14} /> Add
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-(--color-muted)">Color:</span>
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-5 w-5 rounded-full border-2 cursor-pointer ${color === c ? 'border-(--color-fg)' : 'border-transparent'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </form>

      {items.length === 0 ? (
        <p className="text-sm text-(--color-muted) px-2 py-6 text-center">
          No tags yet. Add one above.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((t) => (
            <TagChip
              key={t.id}
              tag={t}
              onUpdate={(next) =>
                setItems((prev) => prev.map((p) => (p.id === next.id ? next : p)))
              }
              onRemove={() => remove(t.id)}
              disabled={pending}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TagChip({
  tag,
  onUpdate,
  onRemove,
  disabled,
}: {
  tag: Tag;
  onUpdate: (next: Tag) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const [pending, start] = useTransition();
  const [name, setName] = useState(tag.name);

  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === tag.name) {
      setName(tag.name);
      return;
    }
    start(async () => {
      const result = await updateTagAction(tag.id, { name: trimmed });
      if (result.ok) onUpdate(result.value);
      else setName(tag.name);
    });
  };

  const setColor = (color: string) => {
    start(async () => {
      const result = await updateTagAction(tag.id, { color });
      if (result.ok) onUpdate(result.value);
    });
  };

  return (
    <li
      className="group inline-flex items-center gap-2 pl-2 pr-1 py-1 rounded-full border"
      style={{
        borderColor: tag.color ?? 'var(--color-border)',
        backgroundColor: tag.color ? `${tag.color}1A` : 'var(--color-surface)',
      }}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: tag.color ?? 'var(--color-muted)' }}
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setName(tag.name);
            (e.target as HTMLInputElement).blur();
          }
        }}
        disabled={pending || disabled}
        size={Math.max(name.length, 4)}
        className="bg-transparent text-xs outline-none"
      />
      <div className="hidden group-hover:flex items-center gap-0.5">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            className={`h-3 w-3 rounded-full border ${tag.color === c ? 'border-(--color-fg)' : 'border-transparent'}`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={pending || disabled}
        className="p-0.5 rounded hover:bg-(--color-surface) text-(--color-muted) hover:text-red-400 cursor-pointer"
      >
        <Trash2 size={12} />
      </button>
    </li>
  );
}
