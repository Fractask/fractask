'use client';

import { useRef, useState, useTransition } from 'react';
import { updateBrainNoteAction } from '@/app/brain-actions';

// Curated emoji set — a tiny, opinionated grid biased toward the kind of
// concepts brain notes hold (people, places, work, ideas, references). Avoids
// pulling in a 1000-entry emoji-mart bundle for v1.
const EMOJIS = [
  '📒', '📝', '📚', '📖', '🗒️', '📋', '🧠', '💡', '✨', '🎯', '🚀', '🔧',
  '⚙️', '🧩', '🗂️', '📁', '📂', '🗃️', '📌', '📍', '🔖', '🏷️', '🔍', '🧭',
  '🌐', '🔗', '📡', '💼', '🏢', '🏠', '🏗️', '👤', '👥', '🤝', '💬', '📣',
  '📞', '📨', '📤', '📥', '📊', '📈', '📉', '💰', '💳', '🧾', '🛒', '🛍️',
  '🍽️', '☕', '🍳', '🧪', '🔬', '🌱', '🌳', '🌍', '🌞', '🌙', '⭐', '🔥',
  '⚡', '💧', '❄️', '🎨', '🎭', '🎬', '🎵', '🎮', '🏆', '🥇', '🥈', '🥉',
  '⚽', '🏀', '🎲', '♟️', '🧘', '🏃', '🚲', '🚗', '✈️', '🚀', '🛰️', '⛺',
  '🗺️', '🧳', '📦', '🔐', '🔑', '🛡️', '⚖️', '⚔️', '✅', '❌', '⚠️', '❓',
];

export function NoteIconPicker({
  noteId,
  initial,
}: {
  noteId: string;
  initial: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [icon, setIcon] = useState<string | null>(initial);
  const [pending, start] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);

  const pick = (next: string | null) => {
    setIcon(next);
    setOpen(false);
    start(async () => {
      await updateBrainNoteAction(noteId, { icon: next });
    });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        title={icon ? 'Change icon' : 'Add icon'}
        className="flex h-12 w-12 items-center justify-center rounded-md border border-dashed border-(--color-border) bg-(--color-surface)/40 text-3xl leading-none hover:border-(--color-accent) cursor-pointer disabled:opacity-50"
      >
        {icon ?? <span className="text-xs text-(--color-muted)">+ icon</span>}
      </button>
      {open && (
        <div
          className="absolute z-30 left-0 top-[calc(100%+6px)] w-[280px] rounded-md border border-(--color-border) bg-(--color-bg) shadow-lg p-2"
          onBlur={(e) => {
            if (!rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
          }}
        >
          <div className="grid grid-cols-8 gap-1">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => pick(e)}
                className={`h-7 w-7 rounded text-lg leading-none hover:bg-(--color-surface) cursor-pointer ${
                  icon === e ? 'bg-(--color-surface)' : ''
                }`}
              >
                {e}
              </button>
            ))}
          </div>
          {icon !== null && (
            <button
              type="button"
              onClick={() => pick(null)}
              className="mt-2 w-full rounded text-[11px] text-(--color-muted) hover:bg-(--color-surface) py-1 cursor-pointer"
            >
              Remove icon
            </button>
          )}
        </div>
      )}
    </div>
  );
}
