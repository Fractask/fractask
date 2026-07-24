import Link from 'next/link';
import {
  CheckCircle2,
  ImageIcon,
  MessageSquare,
  PenLine,
  Play,
  Plus,
} from 'lucide-react';
import type { TaskStatus } from '@getshit/core';
import { MarkdownView } from '@/components/markdown-view';
import { textDirection } from '@/lib/text-direction';
import { formatRelativeDate } from '@/lib/sort';

export type ActivityMedia = {
  id: string;
  kind: 'image' | 'video';
  url: string;
  filename: string;
};

export type ActivityEvent = {
  id: string;
  type: 'created' | 'updated' | 'comment' | 'attachment' | 'completed';
  at: number;
  taskId: string;
  taskTitle: string;
  taskStatus: TaskStatus;
  actorName: string;
  actorKind: 'person' | 'agent';
  body?: string;
  media?: ActivityMedia[];
};

const VERB: Record<ActivityEvent['type'], string> = {
  created: 'created',
  updated: 'worked on',
  comment: 'commented on',
  attachment: 'added media to',
  completed: 'completed',
};

const TYPE_ICON = {
  created: Plus,
  updated: PenLine,
  comment: MessageSquare,
  attachment: ImageIcon,
  completed: CheckCircle2,
} as const;

const TYPE_TONE: Record<ActivityEvent['type'], string> = {
  created: 'text-sky-600 dark:text-sky-400',
  updated: 'text-(--color-muted)',
  comment: 'text-violet-600 dark:text-violet-400',
  attachment: 'text-emerald-600 dark:text-emerald-400',
  completed: 'text-green-600 dark:text-green-400',
};

const STATUS_LABEL: Partial<Record<TaskStatus, string>> = {
  doing: 'Doing',
  review: 'In review',
  done: 'Done',
  backlog: 'Backlog',
};

const STATUS_TONE: Partial<Record<TaskStatus, string>> = {
  doing: 'border-sky-500/40 text-sky-700 dark:text-sky-300',
  review: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
  done: 'border-green-500/40 text-green-700 dark:text-green-300',
};

// Deterministic hue so each actor keeps a stable avatar color.
function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const todayKey = dayKey(now);
  const yKey = dayKey(now - 24 * 3600_000);
  const k = dayKey(ts);
  if (k === todayKey) return 'Today';
  if (k === yKey) return 'Yesterday';
  const weekday = d.toLocaleString('en-US', { weekday: 'short' });
  const mon = d.toLocaleString('en-US', { month: 'short' });
  const year = d.getFullYear() === n.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${weekday}, ${mon} ${d.getDate()}${year}`;
}

/**
 * The activity board: one reverse-chronological stream of everything that
 * happened — tasks created / worked on / completed, comments, media added —
 * grouped by day. It's a lens over data that already exists (task timestamps,
 * comments, attachments); no new tables, no event log.
 */
export function ActivityFeed({ events, now }: { events: ActivityEvent[]; now: number }) {
  if (events.length === 0) {
    return (
      <p className="px-2 py-12 text-center text-sm text-(--color-muted)">
        No activity yet. As you and your agents work on tasks, it shows up here.
      </p>
    );
  }

  // Group into day buckets, preserving the incoming (newest-first) order.
  const groups: { key: string; label: string; events: ActivityEvent[] }[] = [];
  for (const e of events) {
    const key = dayKey(e.at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.events.push(e);
    else groups.push({ key, label: dayLabel(e.at, now), events: [e] });
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <section key={g.key} className="flex flex-col gap-1">
          <h2 className="sticky top-0 z-10 bg-(--color-bg) py-1 text-[11px] font-medium uppercase tracking-wider text-(--color-muted)">
            {g.label}
          </h2>
          <ol className="flex flex-col">
            {g.events.map((e) => (
              <EventRow key={e.id} e={e} now={now} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function EventRow({ e, now }: { e: ActivityEvent; now: number }) {
  const Icon = TYPE_ICON[e.type];
  const hue = hueFor(e.actorName || e.taskId);
  const statusLabel = STATUS_LABEL[e.taskStatus];
  return (
    <li className="group relative flex gap-3 pb-4 pl-1">
      {/* Timeline rail + avatar */}
      <div className="relative flex flex-col items-center">
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white ring-2 ring-(--color-bg)"
          style={{ backgroundColor: `hsl(${hue} 55% 45%)` }}
          title={e.actorName}
        >
          {initials(e.actorName)}
        </span>
        <span className="absolute top-7 h-full w-px bg-(--color-border) group-last:hidden" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm leading-6">
          <Icon size={13} className={`shrink-0 ${TYPE_TONE[e.type]}`} />
          <span className="font-medium text-(--color-fg)">{e.actorName}</span>
          {e.actorKind === 'agent' && (
            <span className="rounded bg-(--color-surface-2) px-1 text-[10px] uppercase tracking-wide text-(--color-muted)">
              agent
            </span>
          )}
          <span className="text-(--color-muted)">{VERB[e.type]}</span>
          <Link
            href={`/${e.taskId}`}
            dir={textDirection(e.taskTitle)}
            className="min-w-0 max-w-full truncate font-medium text-(--color-fg) hover:text-(--color-accent)"
            title={e.taskTitle}
          >
            {e.taskTitle || 'Untitled'}
          </Link>
          {(e.type === 'completed' || e.type === 'updated') && statusLabel && (
            <span
              className={`rounded border px-1 text-[10px] ${
                STATUS_TONE[e.taskStatus] ?? 'border-(--color-border) text-(--color-muted)'
              }`}
            >
              {statusLabel}
            </span>
          )}
          <span className="ml-auto shrink-0 whitespace-nowrap text-xs tabular-nums text-(--color-muted)">
            {formatRelativeDate(e.at, now)}
          </span>
        </div>

        {e.body && (
          <div className="mt-1 rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-2 text-sm">
            <div className="line-clamp-4 text-(--color-fg)">
              <MarkdownView source={e.body} />
            </div>
          </div>
        )}

        {e.media && e.media.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {e.media.slice(0, 8).map((m) => (
              <Link
                key={m.id}
                href={`/${e.taskId}`}
                className="relative block h-16 w-16 overflow-hidden rounded border border-(--color-border) bg-(--color-surface)"
                title={m.filename}
              >
                {m.kind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={m.url}
                    alt={m.filename}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <>
                    <video src={m.url} preload="metadata" className="h-full w-full bg-black object-cover" />
                    <Play
                      size={14}
                      className="pointer-events-none absolute inset-0 m-auto text-white/90 drop-shadow"
                    />
                  </>
                )}
              </Link>
            ))}
            {e.media.length > 8 && (
              <span className="grid h-16 w-16 place-items-center rounded border border-(--color-border) text-xs text-(--color-muted)">
                +{e.media.length - 8}
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
