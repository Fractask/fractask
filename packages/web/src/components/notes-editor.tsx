'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Sparkles, X, Pencil, Check } from 'lucide-react';
import { generateNoteAction, updateTaskAction } from '@/app/actions';
import { useStoredModelId } from './model-picker';

export function NotesEditor({
  id,
  initial,
}: {
  id: string;
  initial: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial ?? '');
  const [saving, startSave] = useTransition();
  const [aiOpen, setAiOpen] = useState(false);
  const [aiGuidance, setAiGuidance] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const modelId = useStoredModelId();

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
      await updateTaskAction(id, { description: next.length === 0 ? null : next });
      setEditing(false);
    });
  };

  const cancel = () => {
    setValue(initial ?? '');
    setEditing(false);
  };

  const askAI = async () => {
    setAiBusy(true);
    setAiError(null);
    setDraft(null);
    const r = await generateNoteAction(id, modelId, aiGuidance.trim() || undefined);
    setAiBusy(false);
    if (r.ok) setDraft(r.value.note);
    else setAiError(r.error);
  };

  const acceptDraft = (mode: 'append' | 'replace') => {
    if (!draft) return;
    const merged =
      mode === 'replace' || !value.trim() ? draft : `${value.trim()}\n\n---\n${draft}`;
    startSave(async () => {
      await updateTaskAction(id, { description: merged });
      setValue(merged);
      setDraft(null);
      setAiGuidance('');
      setAiOpen(false);
    });
  };

  return (
    <section className="rounded-md border border-(--color-border) bg-(--color-surface)/40">
      <header className="flex items-center justify-between px-3 py-2 border-b border-(--color-border)">
        <h2 className="text-xs uppercase tracking-wide text-(--color-muted)">Notes</h2>
        <div className="flex items-center gap-1">
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
          <button
            type="button"
            onClick={() => setAiOpen((v) => !v)}
            title="Generate with AI"
            className="text-xs flex items-center gap-1 px-2 py-1 rounded hover:bg-(--color-surface) text-(--color-muted) hover:text-(--color-accent) cursor-pointer"
          >
            <Sparkles size={12} /> AI
          </button>
        </div>
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
            placeholder="Notes (markdown)…"
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
              No notes yet. Click Edit to write, or AI to generate.
            </span>
          ) : (
            value
          )}
        </div>
      )}

      {aiOpen && (
        <div className="px-3 pb-3 border-t border-(--color-border) pt-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              value={aiGuidance}
              onChange={(e) => setAiGuidance(e.target.value)}
              placeholder="Optional guidance (e.g. 'list open questions')"
              disabled={aiBusy}
              className="flex-1 bg-(--color-bg) rounded px-2 py-1.5 text-xs outline-none border border-(--color-border) focus:border-(--color-accent)"
            />
            <button
              onClick={askAI}
              disabled={aiBusy}
              className="text-xs px-2.5 py-1.5 rounded bg-(--color-accent) text-black hover:opacity-90 disabled:opacity-50 cursor-pointer"
            >
              {aiBusy ? '…' : 'Generate'}
            </button>
            <button
              onClick={() => {
                setAiOpen(false);
                setDraft(null);
                setAiError(null);
              }}
              title="Close"
              className="p-1.5 rounded hover:bg-(--color-surface) cursor-pointer"
            >
              <X size={12} />
            </button>
          </div>
          {aiError && <p className="text-xs text-red-400">{aiError}</p>}
          {draft && (
            <div className="rounded border border-(--color-border) bg-(--color-bg) p-2 text-sm whitespace-pre-wrap">
              {draft}
              <div className="flex items-center justify-end gap-2 mt-2 pt-2 border-t border-(--color-border) text-xs">
                <button
                  onClick={() => setDraft(null)}
                  className="px-2 py-1 rounded hover:bg-(--color-surface) cursor-pointer"
                >
                  Discard
                </button>
                {value.trim() && (
                  <button
                    onClick={() => acceptDraft('replace')}
                    disabled={saving}
                    className="px-2 py-1 rounded border border-(--color-border) hover:bg-(--color-surface) cursor-pointer"
                  >
                    Replace
                  </button>
                )}
                <button
                  onClick={() => acceptDraft('append')}
                  disabled={saving}
                  className="flex items-center gap-1 px-2 py-1 rounded bg-(--color-accent) text-black hover:opacity-90 cursor-pointer"
                >
                  <Check size={12} /> {value.trim() ? 'Append' : 'Use'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
