'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, Check, User as UserIcon } from 'lucide-react';
import type { Assignee } from '@getshit/core';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

function Avatar({ assignee, size = 18 }: { assignee: Assignee | null; size?: number }) {
  if (!assignee) {
    return (
      <span
        className="inline-flex items-center justify-center rounded-full border border-dashed border-(--color-border) text-(--color-muted)"
        style={{ width: size, height: size }}
      >
        <UserIcon size={Math.max(8, size - 8)} />
      </span>
    );
  }
  const bg = assignee.color ?? (assignee.kind === 'agent' ? '#8b5cf6' : '#0ea5e9');
  return (
    <span
      className="inline-flex items-center justify-center rounded-full text-[10px] font-medium text-white shrink-0"
      style={{ width: size, height: size, backgroundColor: bg }}
      aria-hidden
    >
      {assignee.kind === 'agent' ? <Bot size={Math.max(8, size - 8)} /> : initials(assignee.name)}
    </span>
  );
}

/**
 * A popover picker shared by the Assignee and Reviewer pills. Click the pill
 * to open; type to filter; click a row (or "Unassigned") to commit. Closes
 * on outside-click or Escape.
 */
export function PeoplePicker({
  selectedId,
  assignees,
  onChange,
  pending,
  triggerLabel,
  triggerIcon,
  emptyLabel,
  triggerColor,
  showAvatar = true,
}: {
  selectedId: string | null;
  assignees: Assignee[];
  onChange: (id: string | null) => void;
  pending: boolean;
  triggerIcon: ReactNode;
  /** What to show in the pill when something is selected. */
  triggerLabel: (selected: Assignee) => string;
  /** What to show in the pill when nothing is selected. */
  emptyLabel: string;
  /** Border color when selected (Tailwind arbitrary class string). */
  triggerColor?: string;
  /** Render the avatar inside the pill instead of the icon when selected. */
  showAvatar?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selected = assignees.find((a) => a.id === selectedId) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    // Focus the search input on open.
    queueMicrotask(() => inputRef.current?.focus());
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = query.trim()
    ? assignees.filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase()))
    : assignees;

  const commit = (id: string | null) => {
    onChange(id);
    setOpen(false);
    setQuery('');
  };

  const borderClass = selected
    ? triggerColor ?? 'border-(--color-accent)'
    : 'border-dashed border-(--color-border)';
  const colorClass = selected
    ? 'text-(--color-fg) bg-(--color-surface)'
    : 'text-(--color-muted) hover:text-(--color-fg) hover:border-(--color-fg)';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-xs cursor-pointer transition-colors ${borderClass} ${colorClass}`}
      >
        {showAvatar && selected ? <Avatar assignee={selected} size={16} /> : triggerIcon}
        <span>{selected ? triggerLabel(selected) : emptyLabel}</span>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-1.5 z-40 w-64 rounded-lg border border-(--color-border) bg-(--color-bg) shadow-lg overflow-hidden"
          role="listbox"
        >
          <div className="border-b border-(--color-border) p-2">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full bg-transparent outline-none text-sm placeholder:text-(--color-muted)"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto">
            <li>
              <button
                type="button"
                onClick={() => commit(null)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-(--color-surface) text-left ${
                  selectedId === null ? 'text-(--color-fg)' : 'text-(--color-muted)'
                }`}
              >
                <Avatar assignee={null} size={18} />
                <span className="flex-1">{emptyLabel}</span>
                {selectedId === null && <Check size={14} />}
              </button>
            </li>
            {filtered.length === 0 && query.trim() && (
              <li className="px-3 py-2 text-xs text-(--color-muted)">No matches.</li>
            )}
            {filtered.map((a) => {
              const isSelected = a.id === selectedId;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => commit(a.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-(--color-surface) text-left ${
                      isSelected ? 'text-(--color-fg) bg-(--color-surface-2)' : 'text-(--color-fg)'
                    }`}
                  >
                    <Avatar assignee={a} size={18} />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{a.name}</div>
                      {a.kind === 'agent' && (
                        <div className="text-[10px] text-(--color-muted)">agent</div>
                      )}
                    </div>
                    {isSelected && <Check size={14} />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
