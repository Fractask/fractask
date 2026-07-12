'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Bot, CheckCircle2, HelpCircle, Image as ImageIcon, ListChecks, Paperclip, User } from 'lucide-react';
import type { AgentPrompt, Task, TaskAttachment } from '@getshit/core';
import { formatRelativeDate } from '@/lib/sort';
import { textDirection } from '@/lib/text-direction';

export type OverviewPerson = { id: string; name: string; kind: 'person' | 'agent' };

export type OverviewItem = {
  task: Task;
  prompts: AgentPrompt[];
  attachments: TaskAttachment[];
};

type Group = {
  person: OverviewPerson | null; // null = unassigned
  items: OverviewItem[];
  oldest: number; // oldest updatedAt in the group (longest wait)
};

// Deterministic pleasant hue per name — stable across renders (no Math.random).
function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function Avatar({ person, size = 32 }: { person: OverviewPerson | null; size?: number }) {
  if (!person) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-(--color-surface-2) text-(--color-muted)"
        style={{ width: size, height: size }}
      >
        <User size={size * 0.5} />
      </span>
    );
  }
  const hue = hueFor(person.name);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        backgroundColor: `hsl(${hue} 55% 45%)`,
      }}
      title={person.name}
    >
      {initials(person.name)}
    </span>
  );
}

function PromptKindIcon({ kind }: { kind: AgentPrompt['kind'] }) {
  const map = {
    approval: { Icon: CheckCircle2, label: 'Approval' },
    text: { Icon: HelpCircle, label: 'Question' },
    choice: { Icon: ListChecks, label: 'Choice' },
    pick_image: { Icon: ImageIcon, label: 'Pick image' },
  } as const;
  const { Icon, label } = map[kind];
  return <Icon size={13} className="text-(--color-muted)" aria-label={label} />;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-(--color-surface-2) text-(--color-muted)' },
  doing: { label: 'Doing', cls: 'bg-blue-500/15 text-blue-500' },
  review: { label: 'Review', cls: 'bg-amber-500/15 text-amber-500' },
};

export function ReviewOverview({
  items,
  people,
  meId,
}: {
  items: OverviewItem[];
  people: Record<string, OverviewPerson>;
  meId: string;
}) {
  const needsYou = (it: OverviewItem) =>
    it.task.status === 'review' && it.task.reviewerId === meId;

  const counts = {
    all: items.length,
    needs: items.filter(needsYou).length,
    assigned: items.filter((i) => !needsYou(i)).length,
  };

  const [filter, setFilter] = useState<'all' | 'needs' | 'assigned'>('needs');
  const visible =
    filter === 'needs'
      ? items.filter(needsYou)
      : filter === 'assigned'
        ? items.filter((i) => !needsYou(i))
        : items;

  const byId = new Map<string, Group>();
  const unassigned: Group = { person: null, items: [], oldest: Infinity };

  for (const item of visible) {
    const aid = item.task.assigneeId;
    if (!aid || !people[aid]) {
      unassigned.items.push(item);
      unassigned.oldest = Math.min(unassigned.oldest, item.task.updatedAt);
      continue;
    }
    let g = byId.get(aid);
    if (!g) {
      g = { person: people[aid]!, items: [], oldest: Infinity };
      byId.set(aid, g);
    }
    g.items.push(item);
    g.oldest = Math.min(g.oldest, item.task.updatedAt);
  }

  const groups = [...byId.values()];
  // Busiest first; break ties by who's been waiting longest.
  groups.sort((a, b) => b.items.length - a.items.length || a.oldest - b.oldest);
  // Unassigned is a catch-all, not a person — always pin it last.
  if (unassigned.items.length > 0) groups.push(unassigned);

  const now = Date.now();

  if (items.length === 0) {
    return (
      <p className="px-2 py-6 text-center text-sm text-(--color-muted)">
        Nothing is waiting on you right now.
      </p>
    );
  }

  const filters: { key: typeof filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: counts.all },
    { key: 'needs', label: 'Needs you', count: counts.needs },
    { key: 'assigned', label: 'Assigned', count: counts.assigned },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Filter: what needs me vs what's out with an agent */}
      <div className="inline-flex w-fit rounded-md border border-(--color-border) overflow-hidden">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs transition-colors ${
              filter === f.key
                ? 'bg-(--color-surface-2) text-(--color-fg)'
                : 'text-(--color-muted) hover:text-(--color-fg)'
            }`}
          >
            {f.label}
            <span className="rounded-full bg-(--color-bg) px-1.5 font-mono text-[10px] tabular-nums">
              {f.count}
            </span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-(--color-muted)">
          {filter === 'needs'
            ? 'Nothing needs your input right now.'
            : 'Nothing assigned and in progress right now.'}
        </p>
      ) : (
        <>
      {/* Summary strip: one chip per person, busiest first */}
      <div className="flex flex-wrap gap-2">
        {groups.map((g) => (
          <a
            key={g.person?.id ?? 'unassigned'}
            href={`#g-${g.person?.id ?? 'unassigned'}`}
            className="flex items-center gap-2 rounded-full border border-(--color-border) bg-(--color-surface) py-1 pe-3 ps-1 text-xs hover:border-(--color-accent)"
          >
            <Avatar person={g.person} size={22} />
            <span className="max-w-[10rem] truncate font-medium">
              {g.person?.name ?? 'Unassigned'}
            </span>
            <span className="rounded-full bg-(--color-bg) px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-(--color-muted)">
              {g.items.length}
            </span>
          </a>
        ))}
      </div>

      {/* Grouped sections */}
      {groups.map((g) => (
        <section key={g.person?.id ?? 'unassigned'} id={`g-${g.person?.id ?? 'unassigned'}`} className="flex flex-col gap-2 scroll-mt-4">
          <header className="flex items-center gap-2 px-1">
            <Avatar person={g.person} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold">
                  {g.person?.name ?? 'Unassigned'}
                </span>
                {g.person && (
                  <span className="flex items-center gap-0.5 rounded-full bg-(--color-surface-2) px-1.5 py-0.5 text-[10px] text-(--color-muted)">
                    {g.person.kind === 'agent' ? <Bot size={10} /> : <User size={10} />}
                    {g.person.kind}
                  </span>
                )}
              </div>
              <span className="text-xs text-(--color-muted)">
                {g.items.length} active · longest {formatRelativeDate(g.oldest, now)}
              </span>
            </div>
          </header>

          <ul className="flex flex-col divide-y divide-(--color-border) overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface)">
            {g.items
              .slice()
              .sort((a, b) => a.task.updatedAt - b.task.updatedAt)
              .map(({ task, prompts, attachments }) => {
                const media = attachments.filter(
                  (a) => a.mimeType.startsWith('image/') || a.mimeType.startsWith('video/'),
                ).length;
                const needsYou = task.status === 'review' && task.reviewerId === meId;
                const badge = STATUS_BADGE[task.status] ?? STATUS_BADGE['open']!;
                return (
                  <li key={task.id}>
                    <Link
                      href={`/${task.id}`}
                      className={`flex items-center gap-3 py-2 pe-3 text-sm hover:bg-(--color-bg) ${
                        needsYou ? 'border-s-2 border-amber-500 ps-2.5' : 'ps-3'
                      }`}
                    >
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        {prompts.slice(0, 3).map((p) => (
                          <PromptKindIcon key={p.id} kind={p.kind} />
                        ))}
                      </div>
                      <span dir={textDirection(task.title)} className="min-w-0 flex-1 truncate">
                        {task.title}
                      </span>
                      {needsYou && (
                        <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                          needs you
                        </span>
                      )}
                      {media > 0 && (
                        <span className="flex shrink-0 items-center gap-0.5 text-xs text-(--color-muted)">
                          <Paperclip size={12} />
                          {media}
                        </span>
                      )}
                      <span className="shrink-0 text-xs text-(--color-muted) tabular-nums">
                        {formatRelativeDate(task.updatedAt, now)}
                      </span>
                    </Link>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
        </>
      )}
    </div>
  );
}
