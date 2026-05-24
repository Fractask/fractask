'use client';

import { useState, useTransition } from 'react';
import { Bot, Trash2, User as UserIcon } from 'lucide-react';
import type { TaskComment } from '@getshit/core';
import { postCommentAction, deleteCommentAction } from '@/app/actions';
import { MarkdownView } from './markdown-view';

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return 'just now';
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function CommentAvatar({ source }: { source: 'human' | 'agent' }) {
  const bg = source === 'agent' ? '#8b5cf6' : '#0ea5e9';
  return (
    <span
      className="inline-flex items-center justify-center rounded-full text-white shrink-0"
      style={{ width: 22, height: 22, backgroundColor: bg }}
      aria-hidden
    >
      {source === 'agent' ? <Bot size={12} /> : <UserIcon size={12} />}
    </span>
  );
}

export function TaskComments({
  taskId,
  comments,
  currentUserId,
  ownerId,
}: {
  taskId: string;
  comments: TaskComment[];
  currentUserId: string;
  ownerId: string;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [posting, startPost] = useTransition();
  const [deleting, startDelete] = useTransition();

  const post = () => {
    const body = draft.trim();
    if (body.length === 0) return;
    setError(null);
    startPost(async () => {
      const r = await postCommentAction(taskId, body);
      if (r.ok) setDraft('');
      else setError(r.error);
    });
  };

  const remove = (id: string) => {
    startDelete(async () => {
      const r = await deleteCommentAction(id, taskId);
      if (!r.ok) setError(r.error);
    });
  };

  const canDelete = (c: TaskComment) =>
    c.authorUserId === currentUserId || ownerId === currentUserId;

  return (
    <section className="rounded-md border border-(--color-border) bg-(--color-surface)/40 mb-4">
      <header className="flex items-center justify-between px-3 py-2 border-b border-(--color-border)">
        <h2 className="text-xs uppercase tracking-wide text-(--color-muted)">
          Comments {comments.length > 0 && <span className="ml-1">({comments.length})</span>}
        </h2>
      </header>

      <ol className="divide-y divide-(--color-border)">
        {comments.length === 0 ? (
          <li className="px-3 py-3 text-xs text-(--color-muted) italic">
            No comments yet. Use the box below to leave a note for yourself, another collaborator,
            or an agent picking this task up.
          </li>
        ) : (
          comments.map((c) => (
            <li key={c.id} className="px-3 py-2.5 flex gap-2.5 items-start group">
              <CommentAvatar source={c.source} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-[11px] text-(--color-muted) mb-0.5">
                  <span className="font-medium text-(--color-fg)">
                    {c.source === 'agent' ? 'Agent' : 'You'}
                  </span>
                  <span>·</span>
                  <span title={new Date(c.createdAt).toLocaleString()}>
                    {formatRelative(c.createdAt)}
                  </span>
                  {canDelete(c) && (
                    <button
                      type="button"
                      onClick={() => remove(c.id)}
                      disabled={deleting}
                      title="Delete comment"
                      className="ml-auto opacity-0 group-hover:opacity-100 transition p-1 rounded hover:bg-(--color-surface) text-(--color-muted) hover:text-red-400 cursor-pointer disabled:opacity-50"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                <div className="text-sm">
                  <MarkdownView source={c.body} />
                </div>
              </div>
            </li>
          ))
        )}
      </ol>

      <div className="px-3 py-2 border-t border-(--color-border) flex flex-col gap-2">
        <textarea
          dir="auto"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              post();
            }
          }}
          placeholder="Write a comment (markdown)…  ⌘/Ctrl+Enter to post"
          disabled={posting}
          rows={2}
          className="bg-(--color-bg) rounded p-2 text-sm leading-relaxed outline-none border border-(--color-border) focus:border-(--color-accent) resize-y font-mono"
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={post}
            disabled={posting || draft.trim().length === 0}
            className="text-xs px-2.5 py-1.5 rounded bg-(--color-accent) text-black hover:opacity-90 disabled:opacity-50 cursor-pointer"
          >
            {posting ? 'Posting…' : 'Post comment'}
          </button>
        </div>
      </div>
    </section>
  );
}
