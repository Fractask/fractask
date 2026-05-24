'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Brain, Search, X } from 'lucide-react';
import type { BrainNoteSearchHit, Task } from '@getshit/core';
import { searchTasksAction } from '@/app/actions';
import { searchBrainNotesAction } from '@/app/brain-actions';

const KIND_LABEL: Record<Task['kind'], string> = {
  entity: 'entity',
  project: 'project',
  goal: 'goal',
  kpi: 'kpi',
  task: 'task',
};

export function SidebarSearch() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Task[]>([]);
  const [noteResults, setNoteResults] = useState<BrainNoteSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setResults([]);
      setNoteResults([]);
      return;
    }
    const seq = ++seqRef.current;
    const t = setTimeout(async () => {
      const [tasks, notes] = await Promise.all([
        searchTasksAction(q, undefined, 6),
        searchBrainNotesAction(q, 4),
      ]);
      if (seq !== seqRef.current) return;
      if (tasks.ok) setResults(tasks.value);
      if (notes.ok) setNoteResults(notes.value);
      setHighlight(0);
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

  const goToAll = () => {
    const q = query.trim();
    if (!q) return;
    setOpen(false);
    setQuery('');
    setResults([]);
    inputRef.current?.blur();
    router.push(`/search?q=${encodeURIComponent(q)}`);
  };

  const goToTask = (id: string) => {
    setOpen(false);
    setQuery('');
    setResults([]);
    setNoteResults([]);
    inputRef.current?.blur();
    router.push(`/${id}`);
  };

  const goToNote = (id: string) => {
    setOpen(false);
    setQuery('');
    setResults([]);
    setNoteResults([]);
    inputRef.current?.blur();
    router.push(`/brain/${id}`);
  };

  const totalResults = results.length + noteResults.length;
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || totalResults === 0) {
      if (e.key === 'Enter') {
        e.preventDefault();
        goToAll();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(totalResults, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlight < results.length) {
        const picked = results[highlight];
        if (picked) goToTask(picked.id);
      } else if (highlight < totalResults) {
        const picked = noteResults[highlight - results.length];
        if (picked) goToNote(picked.id);
      } else {
        goToAll();
      }
    }
  };

  const showPanel = open && query.trim().length > 0;

  return (
    <div className="px-2 pt-2 relative">
      <div className="relative">
        <Search
          size={12}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-(--color-muted) pointer-events-none"
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder="Search…"
          aria-label="Search tasks"
          className="w-full pl-7 pr-12 py-1.5 text-sm rounded-md bg-(--color-surface) text-(--color-fg) placeholder:text-(--color-muted) outline-none focus:ring-1 focus:ring-(--color-accent)"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onMouseDown={(e) => {
              e.preventDefault();
              setQuery('');
              setResults([]);
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-(--color-muted) hover:text-(--color-fg)"
          >
            <X size={12} />
          </button>
        ) : (
          <kbd className="absolute right-2 top-1/2 -translate-y-1/2 font-mono-id text-[10px] text-(--color-muted) border border-(--color-border) rounded px-1 py-0.5 leading-none">
            ⌘K
          </kbd>
        )}
      </div>

      {showPanel && (
        <div className="absolute z-30 left-2 right-2 top-[calc(100%+2px)] bg-(--color-bg) border border-(--color-border) rounded-md shadow-lg overflow-hidden">
          {totalResults === 0 ? (
            <div className="px-3 py-2 text-xs text-(--color-muted)">No matches</div>
          ) : (
            <ul className="py-1 max-h-80 overflow-y-auto">
              {results.map((t, i) => (
                <li key={t.id}>
                  <Link
                    href={`/${t.id}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => goToTask(t.id)}
                    onMouseEnter={() => setHighlight(i)}
                    className={`flex items-center gap-2 px-3 py-1.5 text-sm ${
                      highlight === i
                        ? 'bg-(--color-surface) text-(--color-fg)'
                        : 'text-(--color-fg) hover:bg-(--color-surface)'
                    }`}
                  >
                    <span className="text-[10px] uppercase tracking-wider text-(--color-muted) w-12 shrink-0">
                      {KIND_LABEL[t.kind]}
                    </span>
                    <span className="truncate flex-1">{t.title}</span>
                    {t.status !== 'open' && (
                      <span className="text-[10px] uppercase tracking-wider text-(--color-muted) shrink-0">
                        {t.status}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
              {noteResults.length > 0 && results.length > 0 && (
                <li className="border-t border-(--color-border) my-1" />
              )}
              {noteResults.map((n, j) => {
                const i = results.length + j;
                return (
                  <li key={n.id}>
                    <Link
                      href={`/brain/${n.id}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => goToNote(n.id)}
                      onMouseEnter={() => setHighlight(i)}
                      className={`flex items-center gap-2 px-3 py-1.5 text-sm ${
                        highlight === i
                          ? 'bg-(--color-surface) text-(--color-fg)'
                          : 'text-(--color-fg) hover:bg-(--color-surface)'
                      }`}
                    >
                      <span className="text-[10px] uppercase tracking-wider text-(--color-muted) w-12 shrink-0 flex items-center gap-1">
                        <Brain size={10} /> note
                      </span>
                      <span className="truncate flex-1">
                        {n.icon ? `${n.icon} ` : ''}
                        {n.title}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={goToAll}
            onMouseEnter={() => setHighlight(totalResults)}
            className={`w-full text-left px-3 py-1.5 text-xs border-t border-(--color-border) ${
              highlight === totalResults
                ? 'bg-(--color-surface) text-(--color-fg)'
                : 'text-(--color-muted) hover:bg-(--color-surface) hover:text-(--color-fg)'
            }`}
          >
            See all results for &ldquo;{query.trim()}&rdquo; →
          </button>
        </div>
      )}
    </div>
  );
}
