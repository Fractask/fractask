'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { setStatusAction, deleteTaskAction } from '@/app/actions';
import type { Task } from '@getshit/core';

const NEXT_STATUS = { open: 'doing', doing: 'done', done: 'open' } as const;

export function KeyboardShortcuts({ focusedId }: { focusedId: string | null }) {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const isTyping = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.isContentEditable);

    const rows = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-task-row]'));

    const currentIndex = () => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return -1;
      return rows().findIndex((r) => r.contains(el));
    };

    const focusRow = (index: number) => {
      const list = rows();
      if (list.length === 0) return;
      const clamped = Math.max(0, Math.min(list.length - 1, index));
      const row = list[clamped];
      const link = row?.querySelector<HTMLElement>('[data-task-link]');
      link?.focus();
    };

    const idFor = (el: Element | null): string | null => {
      const row = el?.closest('[data-task-row]') as HTMLElement | null;
      return row?.dataset['taskId'] ?? null;
    };

    const onKey = async (e: KeyboardEvent) => {
      if (helpOpen && e.key === 'Escape') {
        setHelpOpen(false);
        return;
      }
      if (isTyping(e.target)) return;

      switch (e.key) {
        case 'j':
          e.preventDefault();
          focusRow(currentIndex() + 1);
          return;
        case 'k':
          e.preventDefault();
          focusRow(currentIndex() - 1);
          return;
        case 'g':
          e.preventDefault();
          focusRow(0);
          return;
        case 'G':
          e.preventDefault();
          focusRow(rows().length - 1);
          return;
        case 'c': {
          e.preventDefault();
          const input = document.querySelector<HTMLInputElement>('[data-new-task-input]');
          input?.focus();
          return;
        }
        case 'Enter': {
          const id = idFor(document.activeElement);
          if (id) {
            e.preventDefault();
            router.push(`/${id}`);
          }
          return;
        }
        case 'Backspace':
          if (focusedId) {
            e.preventDefault();
            router.push('/');
          }
          return;
        case ' ': {
          const id = idFor(document.activeElement);
          if (!id) return;
          e.preventDefault();
          const row = document.activeElement?.closest('[data-task-row]') as HTMLElement | null;
          const status = (row?.querySelector('[aria-label*="status:"]') as HTMLElement | null)
            ?.getAttribute('aria-label')
            ?.match(/status: (\w+)/)?.[1] as keyof typeof NEXT_STATUS | undefined;
          if (status) await setStatusAction(id, NEXT_STATUS[status] as Task['status']);
          return;
        }
        case 'x': {
          const id = idFor(document.activeElement);
          if (!id) return;
          e.preventDefault();
          if (confirm('Delete this task and all its subtasks?')) await deleteTaskAction(id);
          return;
        }
        case '?':
          e.preventDefault();
          setHelpOpen((v) => !v);
          return;
        case 'Escape':
          setHelpOpen(false);
          return;
        default:
          return;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, focusedId, helpOpen]);

  if (!helpOpen) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => setHelpOpen(false)}
    >
      <div
        className="rounded-lg border border-(--color-border) bg-(--color-bg) p-5 max-w-sm w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-medium mb-3">Keyboard shortcuts</h2>
        <ul className="text-xs space-y-1.5 text-(--color-muted)">
          <Shortcut k="j / k" desc="Move up / down" />
          <Shortcut k="g / G" desc="Top / bottom" />
          <Shortcut k="Enter" desc="Focus task" />
          <Shortcut k="Backspace" desc="Back to root" />
          <Shortcut k="Space" desc="Cycle status" />
          <Shortcut k="c" desc="New task" />
          <Shortcut k="x" desc="Delete task" />
          <Shortcut k="?" desc="Toggle this help" />
        </ul>
      </div>
    </div>
  );
}

function Shortcut({ k, desc }: { k: string; desc: string }) {
  return (
    <li className="flex items-center justify-between gap-4">
      <kbd className="font-mono-id px-1.5 py-0.5 rounded bg-(--color-surface) border border-(--color-border) text-(--color-fg)">
        {k}
      </kbd>
      <span>{desc}</span>
    </li>
  );
}
