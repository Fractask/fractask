'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Pencil, Scroll } from 'lucide-react';
import { updateTaskAction } from '@/app/actions';

export function RulesEditor({
  id,
  initial,
  kindLabel,
}: {
  id: string;
  initial: string | null;
  kindLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial ?? '');
  const [saving, startSave] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setValue(initial ?? ''), [initial]);

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.setSelectionRange(value.length, value.length);
    }
  }, [editing, value.length]);

  const commit = () => {
    const next = value.trim();
    if (next === (initial ?? '').trim()) {
      setEditing(false);
      return;
    }
    startSave(async () => {
      await updateTaskAction(id, { rules: next.length === 0 ? null : next });
      setEditing(false);
    });
  };

  const cancel = () => {
    setValue(initial ?? '');
    setEditing(false);
  };

  return (
    <section className="rounded-md border border-(--color-border) bg-(--color-surface)/40">
      <header className="flex items-center justify-between px-3 py-2 border-b border-(--color-border)">
        <h2 className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-(--color-muted)">
          <Scroll size={12} />
          Rules
          <span className="ml-1 text-[10px] normal-case tracking-normal text-(--color-muted)/70">
            persistent guidance for this {kindLabel}
          </span>
        </h2>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Edit"
            className="text-xs flex items-center gap-1 px-2 py-1 rounded hover:bg-(--color-surface) text-(--color-muted) hover:text-(--color-fg) cursor-pointer"
          >
            <Pencil size={12} /> Edit
          </button>
        )}
      </header>

      {editing ? (
        <div className="p-3 flex flex-col gap-2">
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              }
            }}
            placeholder={`Rules for this ${kindLabel} (markdown)…`}
            disabled={saving}
            rows={Math.max(3, Math.min(20, (value.match(/\n/g)?.length ?? 0) + 3))}
            className="bg-(--color-bg) rounded p-2 text-sm leading-relaxed outline-none border border-(--color-border) focus:border-(--color-accent) resize-y font-mono"
          />
          <div className="flex items-center justify-end gap-2 text-xs">
            <span className="mr-auto text-(--color-muted)">
              ⌘/Ctrl+Enter saves · Esc cancels
            </span>
            <button
              onClick={cancel}
              className="px-2 py-1 rounded border border-(--color-border) hover:bg-(--color-surface) cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={commit}
              disabled={saving}
              className="px-2 py-1 rounded bg-(--color-accent) text-black hover:opacity-90 disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="p-3 text-sm whitespace-pre-wrap min-h-[2.5rem]">
          {value.length === 0 ? (
            <span className="text-(--color-muted) italic">
              No rules yet. Click Edit to write guidance that should follow this{' '}
              {kindLabel} forward.
            </span>
          ) : (
            value
          )}
        </div>
      )}
    </section>
  );
}
