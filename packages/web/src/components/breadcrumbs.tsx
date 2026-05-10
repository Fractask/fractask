import Link from 'next/link';
import { ChevronRight, Home } from 'lucide-react';
import type { Task } from '@getshit/core';

export function Breadcrumbs({ trail }: { trail: Task[] }) {
  return (
    <nav className="flex items-center gap-1 text-xs text-(--color-muted) flex-wrap">
      <Link
        href="/"
        className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-(--color-surface) hover:text-(--color-fg)"
      >
        <Home size={12} /> root
      </Link>
      {trail.map((t, i) => (
        <span key={t.id} className="flex items-center gap-1">
          <ChevronRight size={12} className="opacity-50" />
          {i === trail.length - 1 ? (
            <span className="px-1.5 py-0.5 text-(--color-fg)">{t.title}</span>
          ) : (
            <Link
              href={`/${t.id}`}
              className="px-1.5 py-0.5 rounded hover:bg-(--color-surface) hover:text-(--color-fg) truncate max-w-[200px]"
            >
              {t.title}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
