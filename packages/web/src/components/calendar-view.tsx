'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Play } from 'lucide-react';
import type { Task } from '@getshit/core';
import { textDirection } from '@/lib/text-direction';

export type CalendarMedia = { kind: 'image' | 'video'; url: string };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** All grid cells for a month: full weeks (Sun–Sat) covering the 1st..last. */
function monthCells(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const start = new Date(year, month, 1 - first.getDay()); // Sunday on/before the 1st
  const end = new Date(year, month, last.getDate() + (6 - last.getDay())); // Saturday on/after the last
  const cells: Date[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    cells.push(new Date(d));
  }
  return cells;
}

export function CalendarView({
  tasks,
  media,
  scope,
}: {
  tasks: Task[];
  media: Record<string, CalendarMedia>;
  scope: { id: string; title: string } | null;
}) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const shift = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  const byDay = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.dueAt == null) continue;
    const key = dayKey(new Date(t.dueAt));
    const list = byDay.get(key) ?? [];
    list.push(t);
    byDay.set(key, list);
  }

  const cells = monthCells(year, month);
  const todayKey = dayKey(now);
  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-sm font-medium whitespace-nowrap">{monthLabel}</h1>
          {scope && (
            <span className="flex items-baseline gap-1.5 min-w-0 text-xs text-(--color-muted)">
              ·
              <Link
                href={`/${scope.id}`}
                dir={textDirection(scope.title)}
                className="truncate hover:text-(--color-fg)"
              >
                {scope.title}
              </Link>
              <Link href="/calendar" className="whitespace-nowrap hover:text-(--color-fg)">
                (show all)
              </Link>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => shift(-1)}
            aria-label="Previous month"
            className="rounded p-1 text-(--color-muted) hover:bg-(--color-surface) hover:text-(--color-fg)"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={() => {
              setYear(now.getFullYear());
              setMonth(now.getMonth());
            }}
            className="rounded px-2 py-1 text-xs text-(--color-muted) hover:bg-(--color-surface) hover:text-(--color-fg)"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => shift(1)}
            aria-label="Next month"
            className="rounded p-1 text-(--color-muted) hover:bg-(--color-surface) hover:text-(--color-fg)"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </header>

      <div className="grid grid-cols-7 text-center text-[10px] uppercase tracking-wider text-(--color-muted)">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-px rounded-md border border-(--color-border) bg-(--color-border) overflow-hidden">
        {cells.map((d) => {
          const key = dayKey(d);
          const inMonth = d.getMonth() === month;
          const isToday = key === todayKey;
          const dayTasks = byDay.get(key) ?? [];
          return (
            <div
              key={key}
              className={`min-h-24 bg-(--color-bg) p-1 ${inMonth ? '' : 'opacity-40'}`}
            >
              <div
                className={`mb-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                  isToday
                    ? 'bg-(--color-accent) font-medium text-white'
                    : 'text-(--color-muted)'
                }`}
              >
                {d.getDate()}
              </div>
              <div className="flex flex-col gap-1">
                {dayTasks.map((t) => (
                  <CalendarChip key={t.id} task={t} media={media[t.id]} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalendarChip({ task, media }: { task: Task; media: CalendarMedia | undefined }) {
  const done = task.status === 'done';
  return (
    <Link
      href={`/${task.id}`}
      className={`block rounded border border-(--color-border) bg-(--color-surface) hover:border-(--color-accent) overflow-hidden ${
        done ? 'opacity-60' : ''
      }`}
    >
      {media &&
        (media.kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={media.url}
            alt=""
            loading="lazy"
            className="h-14 w-full object-cover"
          />
        ) : (
          <span className="relative block">
            <video
              src={media.url}
              muted
              playsInline
              preload="metadata"
              className="h-14 w-full object-cover"
            />
            <Play
              size={14}
              className="absolute inset-0 m-auto text-white drop-shadow"
            />
          </span>
        ))}
      <span
        dir={textDirection(task.title)}
        className={`block truncate px-1 py-0.5 text-[11px] ${done ? 'line-through' : ''}`}
        title={task.title}
      >
        {task.title}
      </span>
    </Link>
  );
}
