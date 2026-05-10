import { Bot, UserCog, User as UserIcon } from 'lucide-react';
import { listShareableUsers, type User } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { NewUserForm } from './new-user-form';

export const dynamic = 'force-dynamic';

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

const KIND_BADGE: Record<User['kind'], { label: string; className: string; Icon: React.ComponentType<{ size?: number }> }> = {
  human: {
    label: 'Human',
    className: 'bg-sky-500/10 text-sky-600 border-sky-500/30',
    Icon: UserIcon,
  },
  agent: {
    label: 'Agent',
    className: 'bg-violet-500/10 text-violet-600 border-violet-500/30',
    Icon: Bot,
  },
  guest: {
    label: 'Guest',
    className: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
    Icon: UserCog,
  },
};

function badge(label: string, color: 'green' | 'gray' | 'amber'): React.ReactNode {
  const colors = {
    green: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
    gray: 'bg-(--color-border)/30 text-(--color-muted) border-(--color-border)',
    amber: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  } as const;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${colors[color]}`}>{label}</span>
  );
}

function UserRow({ u, isMe }: { u: User; isMe: boolean }) {
  const kindMeta = KIND_BADGE[u.kind];
  const KindIcon = kindMeta.Icon;
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm">{u.name?.trim() || <span className="text-(--color-muted)">(no name)</span>}</span>
          <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${kindMeta.className}`}>
            <KindIcon size={10} />
            <span>{kindMeta.label}</span>
          </span>
          {isMe && badge('you', 'green')}
          {u.kind === 'human' &&
            (u.googleId ? badge('Google', 'gray') : badge('not signed in', 'amber'))}
        </div>
        <div className="text-xs text-(--color-muted) font-mono-id">
          {u.email ?? <span className="opacity-60">(no email)</span>} · {u.id}
        </div>
        {u.endpoint && (
          <div className="text-xs text-(--color-muted) truncate">
            <span className="opacity-60">endpoint:</span> {u.endpoint}
          </div>
        )}
        <div className="text-[10px] text-(--color-muted)">Created {formatDate(u.createdAt)}</div>
      </div>
    </li>
  );
}

export default async function UsersPage() {
  const ctx = await getRequestContext();
  const others = await listShareableUsers(ctx);
  const { findUserById } = await import('@getshit/core');
  const me = await findUserById(ctx.userId);
  const all: User[] = me ? [me, ...others] : others;

  return (
    <div className="max-w-2xl mx-auto px-6 py-8 flex flex-col gap-6">
      <header>
        <h1 className="text-lg font-medium tracking-tight">Users</h1>
        <p className="text-sm text-(--color-muted) mt-1">
          Login identities. Humans sign in; agents are automated (email or chat
          endpoint); guests are external collaborators with limited access.
        </p>
      </header>

      <NewUserForm />

      <ul className="flex flex-col divide-y divide-(--color-border)">
        {all.map((u) => (
          <UserRow key={u.id} u={u} isMe={u.id === ctx.userId} />
        ))}
      </ul>
    </div>
  );
}
