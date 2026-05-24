'use client';

import { useEffect, useImperativeHandle, useState, forwardRef } from 'react';
import { Brain, Loader2, FileText } from 'lucide-react';
import type { LinkSuggestionItem } from './link-suggestion';

export type LinkSuggestionPopoverHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

type Props = {
  items: LinkSuggestionItem[];
  loading: boolean;
  query: string;
  command: (item: LinkSuggestionItem) => void;
};

/**
 * Picker UI shown inline when the user types `/` in the editor. Renders the
 * matched tasks + notes; arrow-key navigation and Enter selection are wired
 * via the `onKeyDown` handle exposed back to the suggestion plugin.
 */
export const LinkSuggestionPopover = forwardRef<LinkSuggestionPopoverHandle, Props>(
  function LinkSuggestionPopover({ items, loading, query, command }, ref) {
    const [index, setIndex] = useState(0);

    useEffect(() => {
      setIndex(0);
    }, [items]);

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key === 'ArrowDown') {
            setIndex((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
            return true;
          }
          if (event.key === 'ArrowUp') {
            setIndex((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
            return true;
          }
          if (event.key === 'Enter') {
            const picked = items[index];
            if (picked) {
              command(picked);
              return true;
            }
          }
          return false;
        },
      }),
      [items, index, command],
    );

    return (
      <div className="w-[320px] rounded-md border border-(--color-border) bg-(--color-bg) shadow-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-(--color-border) text-[10px] uppercase tracking-wider text-(--color-muted) flex items-center justify-between">
          <span>Link to task or note</span>
          {loading && <Loader2 size={10} className="animate-spin" />}
        </div>
        {items.length === 0 ? (
          <div className="px-3 py-4 text-xs text-(--color-muted)">
            {query.length === 0
              ? 'Type to search tasks and brain notes.'
              : `No matches for "${query}".`}
          </div>
        ) : (
          <ul className="max-h-72 overflow-y-auto py-1">
            {items.map((item, i) => (
              <li key={`${item.kind}:${item.id}`}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => command(item)}
                  onMouseEnter={() => setIndex(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm cursor-pointer ${
                    i === index
                      ? 'bg-(--color-surface) text-(--color-fg)'
                      : 'text-(--color-fg) hover:bg-(--color-surface)'
                  }`}
                >
                  <span className="text-[10px] uppercase tracking-wider text-(--color-muted) w-10 shrink-0 flex items-center gap-1">
                    {item.kind === 'note' ? <Brain size={10} /> : <FileText size={10} />}
                    {item.kind}
                  </span>
                  <span className="w-4 text-center text-base leading-none">
                    {item.icon ?? (item.kind === 'note' ? '📄' : '·')}
                  </span>
                  <span className="truncate flex-1">{item.title}</span>
                  {item.subtitle && (
                    <span className="text-[10px] uppercase tracking-wider text-(--color-muted) shrink-0">
                      {item.subtitle}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);
