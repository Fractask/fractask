'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Archive,
  ArrowDownToLine,
  Building2,
  CalendarDays,
  ChevronRight,
  Eye,
  Inbox,
  Key,
  ListTodo,
  Moon,
  Plug,
  ScrollText,
  Smartphone,
  Tag,
  Target,
  UserCircle2,
  Users,
} from 'lucide-react';
import { moveTaskAction } from '@/app/actions';
import { ConfirmMoveModal } from './confirm-move-modal';
import { TASK_DRAG_MIME } from './task-list';

type DragPayload = { id: string; title: string };

function useTaskReparentDrop({
  targetId,
  targetTitle,
}: {
  targetId: string | null;
  targetTitle: string;
}) {
  const router = useRouter();
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<DragPayload | null>(null);

  const onDragOver = (e: React.DragEvent) => {
    // Some browsers don't surface custom MIME types in dataTransfer.types during
    // dragover, so accept any drag and verify the payload at drop time.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOver(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setOver(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const raw =
      e.dataTransfer.getData(TASK_DRAG_MIME) || e.dataTransfer.getData('text/plain');
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as DragPayload;
      if (!payload?.id || payload.id === targetId) return;
      setPending(payload);
    } catch {
      /* not our payload, ignore */
    }
  };

  const confirm = async () => {
    const p = pending;
    if (!p) return;
    setPending(null);
    const result = await moveTaskAction(p.id, targetId);
    if (result.ok) router.refresh();
  };

  const cancel = () => setPending(null);

  const modal = pending ? (
    <ConfirmMoveModal
      source={pending}
      target={{ id: targetId, title: targetTitle }}
      onCancel={cancel}
      onConfirm={confirm}
    />
  ) : null;

  return { handlers: { onDragOver, onDragLeave, onDrop }, isOver: over, modal };
}

type StaticItem = {
  href: string;
  label: string;
  icon:
    | 'inbox'
    | 'today'
    | 'all'
    | 'goals'
    | 'tags'
    | 'assignees'
    | 'archived'
    | 'snoozed'
    | 'tokens'
    | 'reviews'
    | 'users'
    | 'setup'
    | 'import'
    | 'install'
    | 'guidelines';
  count?: number | null;
};

const ICONS = {
  inbox: Inbox,
  today: CalendarDays,
  all: ListTodo,
  goals: Target,
  tags: Tag,
  assignees: Users,
  archived: Archive,
  snoozed: Moon,
  tokens: Key,
  reviews: Eye,
  users: UserCircle2,
  setup: Plug,
  import: ArrowDownToLine,
  install: Smartphone,
  guidelines: ScrollText,
} as const;

export function SidebarStaticItem({ item }: { item: StaticItem }) {
  const pathname = usePathname();
  const active = pathname === item.href;
  const Icon = ICONS[item.icon];
  return (
    <Link
      href={item.href}
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm ${
        active
          ? 'bg-(--color-surface-2) text-(--color-fg)'
          : 'text-(--color-muted) hover:bg-(--color-surface) hover:text-(--color-fg)'
      }`}
    >
      <Icon size={14} />
      <span className="flex-1 truncate">{item.label}</span>
      {item.count != null && item.count > 0 && (
        <span className="font-mono-id text-(--color-muted)">{item.count}</span>
      )}
    </Link>
  );
}

export function SidebarProjectItem({
  id,
  title,
  count,
  indent = false,
}: {
  id: string;
  title: string;
  count: number;
  indent?: boolean;
}) {
  const pathname = usePathname();
  const active = pathname === `/${id}`;
  const { handlers, isOver, modal } = useTaskReparentDrop({ targetId: id, targetTitle: title });
  return (
    <div {...handlers} className={isOver ? 'rounded-md ring-2 ring-(--color-accent) ring-inset' : ''}>
      <Link
        href={`/${id}`}
        className={`flex items-center gap-1.5 ${indent ? 'pl-4 pr-2' : 'px-2'} py-1 rounded-md text-sm ${
          active
            ? 'bg-(--color-surface-2) text-(--color-fg)'
            : 'text-(--color-muted) hover:bg-(--color-surface) hover:text-(--color-fg)'
        }`}
      >
        <ChevronRight size={12} className="text-(--color-muted)" />
        <span className="flex-1 truncate">{title}</span>
        {count > 0 && <span className="font-mono-id text-(--color-muted)">{count}</span>}
      </Link>
      {modal}
    </div>
  );
}

export function SidebarEntityGroup({
  id,
  title,
  projects,
}: {
  id: string;
  title: string;
  projects: { id: string; title: string; count: number }[];
}) {
  const pathname = usePathname();
  const projectIds = projects.map((p) => p.id);
  const auto =
    pathname === '/' ||
    pathname === `/${id}` ||
    projectIds.some((pid) => pathname === `/${pid}`);
  const [override, setOverride] = useState<boolean | null>(null);
  // Manual chevron toggle wins until the route changes, then we fall back to auto.
  useEffect(() => {
    setOverride(null);
  }, [pathname]);
  const open = override ?? auto;

  const active = pathname === `/${id}`;
  const { handlers, isOver, modal } = useTaskReparentDrop({ targetId: id, targetTitle: title });

  return (
    <div className="flex flex-col gap-0.5">
      <div
        {...handlers}
        className={`flex items-center gap-1 pr-1 rounded-md ${
          isOver ? 'ring-2 ring-(--color-accent) ring-inset' : ''
        }`}
      >
        {projects.length > 0 ? (
          <button
            type="button"
            onClick={() => setOverride(!open)}
            aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
            className="p-1 rounded text-(--color-muted) hover:text-(--color-fg) hover:bg-(--color-surface) cursor-pointer"
          >
            <ChevronRight
              size={12}
              className={`transition-transform ${open ? 'rotate-90' : ''}`}
            />
          </button>
        ) : (
          <span className="w-[20px]" />
        )}
        <Link
          href={`/${id}`}
          className={`group flex items-center gap-2 flex-1 min-w-0 pt-2 pb-1 text-[11px] uppercase tracking-wider ${
            active ? 'text-(--color-fg)' : 'text-(--color-muted) hover:text-(--color-fg)'
          }`}
        >
          <Building2 size={11} />
          <span className="flex-1 truncate">{title}</span>
        </Link>
      </div>
      {open &&
        projects.map((p) => (
          <SidebarProjectItem key={p.id} id={p.id} title={p.title} count={p.count} indent />
        ))}
      {modal}
    </div>
  );
}

export function SidebarTagItem({
  id,
  name,
  color,
}: {
  id: string;
  name: string;
  color: string | null;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const active = pathname === '/' && params.get('tag') === id;
  return (
    <Link
      href={`/app?tag=${id}`}
      className={`flex items-center gap-2 px-2 py-1 rounded-md text-sm ${
        active
          ? 'bg-(--color-surface-2) text-(--color-fg)'
          : 'text-(--color-muted) hover:bg-(--color-surface) hover:text-(--color-fg)'
      }`}
    >
      <span
        className="h-2 w-2 rounded-full shrink-0"
        style={{ backgroundColor: color ?? 'var(--color-muted)' }}
      />
      <span className="flex-1 truncate">{name}</span>
    </Link>
  );
}
