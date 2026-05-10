'use client';

import { Check, Share2, X } from 'lucide-react';
import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  listSharesAction,
  listShareableUsersAction,
  shareTaskAction,
  unshareTaskAction,
  type ShareEntryDTO,
} from '@/app/share-actions';

type CandidateUser = { id: string; email: string | null; name: string | null };

function displayName(user: { name: string | null; email: string | null; id: string }): string {
  return user.name?.trim() || user.email || user.id;
}

function initials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

function Avatar({ user, size = 20 }: { user: { name: string | null; email: string | null }; size?: number }) {
  const seed = user.email ?? user.name ?? '';
  // Stable color from string hash so the same user always gets the same avatar bg.
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return (
    <span
      className="inline-flex items-center justify-center rounded-full text-[10px] font-medium text-white shrink-0"
      style={{ width: size, height: size, backgroundColor: `hsl(${hue} 60% 45%)` }}
      aria-hidden
    >
      {initials(displayName({ ...user, id: '' }))}
    </span>
  );
}

export function ShareButton({ taskId, isOwner }: { taskId: string; isOwner: boolean }) {
  const [open, setOpen] = useState(false);
  const [direct, setDirect] = useState<ShareEntryDTO[]>([]);
  const [inherited, setInherited] = useState<ShareEntryDTO[]>([]);
  const [candidates, setCandidates] = useState<CandidateUser[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    Promise.all([listSharesAction(taskId), listShareableUsersAction()]).then(([s, u]) => {
      setLoading(false);
      if (s.ok) {
        setDirect(s.value.direct);
        setInherited(s.value.inherited);
      } else {
        setError(s.error);
      }
      if (u.ok) setCandidates(u.value);
      else setError(u.error);
    });
  }, [open, taskId]);

  const sharedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of direct) ids.add(s.user.id);
    for (const s of inherited) ids.add(s.user.id);
    return ids;
  }, [direct, inherited]);

  const inviteable = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates
      .filter((u) => !sharedIds.has(u.id))
      .filter((u) => {
        if (!q) return true;
        const blob = `${u.name ?? ''} ${u.email ?? ''}`.toLowerCase();
        return blob.includes(q);
      });
  }, [candidates, sharedIds, query]);

  const onShare = (recipientId: string) => {
    start(async () => {
      setError(null);
      const r = await shareTaskAction(taskId, recipientId);
      if (r.ok) {
        setDirect((prev) => {
          const without = prev.filter((p) => p.user.id !== r.value.user.id);
          return [...without, r.value];
        });
        setQuery('');
      } else {
        setError(r.error);
      }
    });
  };

  const onRevoke = (userId: string) => {
    start(async () => {
      setError(null);
      const r = await unshareTaskAction(taskId, userId);
      if (r.ok) {
        setDirect((prev) => prev.filter((p) => p.user.id !== userId));
      } else {
        setError(r.error);
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-full border border-(--color-border) text-(--color-muted) hover:text-(--color-fg) hover:border-(--color-fg)"
      >
        <Share2 size={12} />
        <span>Share</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md bg-(--color-bg) border border-(--color-border) rounded-lg p-5 flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Share this task</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-(--color-muted) hover:text-(--color-fg)"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            {isOwner ? (
              <div className="flex flex-col gap-2">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search users…"
                  className="w-full bg-transparent border border-(--color-border) rounded px-3 py-2 text-sm outline-none focus:border-(--color-fg)"
                />
                <div className="max-h-48 overflow-y-auto rounded border border-(--color-border) divide-y divide-(--color-border)">
                  {loading ? (
                    <div className="text-xs text-(--color-muted) p-3">Loading…</div>
                  ) : inviteable.length === 0 ? (
                    <div className="text-xs text-(--color-muted) p-3">
                      {query.trim()
                        ? 'No matching users.'
                        : sharedIds.size > 0
                          ? 'Everyone you can share with already has access.'
                          : 'No other users in the system yet.'}
                    </div>
                  ) : (
                    inviteable.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => onShare(u.id)}
                        disabled={pending}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-(--color-surface) disabled:opacity-50"
                      >
                        <Avatar user={u} />
                        <div className="flex-1 min-w-0">
                          <div className="truncate">{u.name?.trim() || (u.email ?? u.id)}</div>
                          {u.name && u.email && (
                            <div className="text-[10px] text-(--color-muted) truncate">{u.email}</div>
                          )}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="text-xs text-(--color-muted)">
                Only the owner can change who has access.
              </div>
            )}

            {error && <div className="text-xs text-red-500">{error}</div>}

            <div className="flex flex-col gap-1.5">
              <div className="text-[10px] uppercase tracking-wider text-(--color-muted)">
                Currently shared with
              </div>
              {loading ? (
                <div className="text-xs text-(--color-muted) py-2">Loading…</div>
              ) : direct.length === 0 && inherited.length === 0 ? (
                <div className="text-xs text-(--color-muted) py-2">
                  Just you. Pick someone above to invite.
                </div>
              ) : (
                <ul className="flex flex-col divide-y divide-(--color-border)">
                  {direct.map((s) => (
                    <li key={s.user.id} className="flex items-center gap-3 py-2">
                      <Avatar user={s.user} />
                      <div className="flex-1 min-w-0 text-sm truncate">{displayName(s.user)}</div>
                      {isOwner && (
                        <button
                          type="button"
                          onClick={() => onRevoke(s.user.id)}
                          disabled={pending}
                          className="text-xs text-(--color-muted) hover:text-red-500 disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      )}
                    </li>
                  ))}
                  {inherited.map((s) => (
                    <li
                      key={`${s.user.id}-${s.via?.id ?? ''}`}
                      className="flex items-center gap-3 py-2 opacity-70"
                    >
                      <Avatar user={s.user} />
                      <div className="flex-1 min-w-0 text-sm truncate">
                        {displayName(s.user)}
                        {s.via && (
                          <span className="text-(--color-muted) text-xs ml-2">
                            via {s.via.title || 'parent'}
                          </span>
                        )}
                      </div>
                      <Check size={12} className="text-(--color-muted)" />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
