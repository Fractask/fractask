'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  Check,
  CornerUpLeft,
  ExternalLink,
  MessageSquarePlus,
  Play,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import type { AgentPrompt, PromptOption, Task, TaskAttachment } from '@getshit/core';
import { answerPromptAction, postCommentAction, setStatusAction } from '@/app/actions';
import { textDirection } from '@/lib/text-direction';

export type ReviewItem = {
  task: Task;
  prompts: AgentPrompt[]; // pending prompts only, oldest first
  attachments: TaskAttachment[];
};

export function ReviewCards({ items }: { items: ReviewItem[] }) {
  const [queue, setQueue] = useState(items);
  const [leaving, setLeaving] = useState<Record<string, boolean>>({});

  const dismiss = (taskId: string) => {
    setLeaving((m) => ({ ...m, [taskId]: true }));
    // Let the card animate out before it leaves the list.
    setTimeout(() => {
      setQueue((q) => q.filter((i) => i.task.id !== taskId));
      setLeaving((m) => {
        const n = { ...m };
        delete n[taskId];
        return n;
      });
    }, 260);
  };

  if (queue.length === 0) return <AllCaughtUp />;

  const remaining = queue.filter((i) => !leaving[i.task.id]).length;

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-xs text-(--color-muted) tabular-nums">
        {remaining} to review
      </p>
      {queue.map((item) => (
        <div
          key={item.task.id}
          className={`transition-all duration-200 ease-out ${
            leaving[item.task.id]
              ? 'pointer-events-none -translate-y-1 scale-[0.98] opacity-0'
              : 'opacity-100'
          }`}
        >
          <ReviewCard item={item} onDone={() => dismiss(item.task.id)} />
        </div>
      ))}
    </div>
  );
}

function AllCaughtUp() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-(--color-border) px-6 py-16 text-center">
      <Sparkles size={28} className="text-(--color-accent)" />
      <p className="text-sm font-medium">All caught up</p>
      <p className="text-xs text-(--color-muted)">Nothing needs your input right now.</p>
    </div>
  );
}

function ReviewCard({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const { task, attachments } = item;
  const [prompts, setPrompts] = useState(item.prompts);
  const prompt = prompts[0] ?? null;
  const kind = prompt?.kind ?? null;

  const [text, setText] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Consumed the current prompt: advance to the next pending one, or clear the
  // card entirely when there's nothing left.
  const finish = () => {
    const rest = prompts.slice(1);
    if (rest.length > 0) {
      setPrompts(rest);
      setText('');
      setSelected(new Set());
    } else {
      onDone();
    }
  };

  const run = (
    fn: () => Promise<{ ok: boolean; error?: string }>,
    onOk: () => void,
  ) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? 'Something went wrong');
      else onOk();
    });
  };

  const comment = text.trim();
  const withComment = comment ? { comment } : {};

  const approve = () => {
    if (kind === 'approval') {
      run(() => answerPromptAction(prompt!.id, { approved: true, ...withComment }), finish);
    } else {
      run(async () => {
        if (comment) {
          const c = await postCommentAction(task.id, comment);
          if (!c.ok) return c;
        }
        return setStatusAction(task.id, 'done');
      }, finish);
    }
  };

  const reject = () => {
    if (kind === 'approval') {
      run(() => answerPromptAction(prompt!.id, { approved: false, ...withComment }), finish);
    } else {
      run(async () => {
        if (comment) {
          const c = await postCommentAction(task.id, comment);
          if (!c.ok) return c;
        }
        return setStatusAction(task.id, 'doing');
      }, finish);
    }
  };

  const reply = () => {
    if (!comment) return;
    run(() => answerPromptAction(prompt!.id, { text: comment }), finish);
  };

  const submitChoice = () => {
    if (selected.size === 0) return;
    run(() => answerPromptAction(prompt!.id, { selectedIds: [...selected] }), finish);
  };

  const pickImage = (optId: string) => {
    run(() => answerPromptAction(prompt!.id, { selectedIds: [optId] }), finish);
  };

  const addComment = () => {
    if (!comment) return;
    run(
      () => postCommentAction(task.id, comment),
      () => {
        setText('');
        setFlash('Comment added');
        setTimeout(() => setFlash(null), 1500);
      },
    );
  };

  const toggleOpt = (id: string) => {
    if (prompt?.multiple) {
      setSelected((prev) => {
        const n = new Set(prev);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
    } else {
      setSelected(new Set([id]));
    }
  };

  const showTextarea = kind !== 'pick_image' && kind !== 'choice';

  return (
    <article className="rounded-lg border border-(--color-border) bg-(--color-surface) shadow-sm">
      <div className="flex flex-col gap-3 p-4">
        {/* Title + open */}
        <div className="flex items-start justify-between gap-3">
          <Link
            href={`/${task.id}`}
            dir={textDirection(task.title)}
            className="text-sm font-medium text-(--color-fg) hover:text-(--color-accent)"
          >
            {task.title}
          </Link>
          <Link
            href={`/${task.id}`}
            className="flex shrink-0 items-center gap-1 text-xs text-(--color-muted) hover:text-(--color-fg)"
            title="Open task"
          >
            open <ExternalLink size={12} />
          </Link>
        </div>

        {task.description && (
          <p
            dir={textDirection(task.description)}
            className="line-clamp-3 whitespace-pre-wrap text-xs text-(--color-muted)"
          >
            {task.description}
          </p>
        )}

        {attachments.length > 0 && <AttachmentsPreview attachments={attachments} />}

        {/* The question */}
        {prompt && (
          <div
            dir={textDirection(prompt.prompt)}
            className="rounded-md bg-(--color-bg) px-3 py-2 text-sm font-medium whitespace-pre-wrap"
          >
            {prompt.prompt}
          </div>
        )}

        {/* Choice / pick_image options */}
        {kind === 'choice' && (
          <ChoiceOptions
            options={prompt!.options ?? []}
            selected={selected}
            multiple={!!prompt!.multiple}
            onToggle={toggleOpt}
            disabled={pending}
          />
        )}
        {kind === 'pick_image' && (
          <PickImageOptions
            options={prompt!.options ?? []}
            attachments={attachments}
            onPick={pickImage}
            disabled={pending}
          />
        )}

        {/* Big comment / answer box */}
        {showTextarea && (
          <textarea
            dir="auto"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            disabled={pending}
            placeholder={
              kind === 'text' ? 'Type your answer…' : 'Add a comment (optional)…'
            }
            className="w-full resize-y rounded-md border border-(--color-border) bg-(--color-bg) p-2.5 text-sm outline-none focus:border-(--color-accent) disabled:opacity-50"
          />
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-between gap-2 rounded-b-lg border-t border-(--color-border) bg-(--color-bg)/40 px-4 py-2.5">
        <div className="flex items-center gap-2 text-xs">
          {showTextarea && (
            <button
              type="button"
              onClick={addComment}
              disabled={pending || comment.length === 0}
              className="flex items-center gap-1 text-(--color-muted) hover:text-(--color-fg) disabled:opacity-40"
              title="Post as a comment without resolving"
            >
              <MessageSquarePlus size={14} /> Comment
            </button>
          )}
          {flash && <span className="text-emerald-500">{flash}</span>}
        </div>

        <div className="flex items-center gap-2">
          {kind === 'text' && (
            <PrimaryButton onClick={reply} disabled={pending || comment.length === 0}>
              <Send size={14} /> Reply
            </PrimaryButton>
          )}
          {kind === 'choice' && (
            <PrimaryButton onClick={submitChoice} disabled={pending || selected.size === 0}>
              <Send size={14} /> Submit
            </PrimaryButton>
          )}
          {(kind === 'approval' || kind === null) && (
            <>
              <button
                type="button"
                onClick={reject}
                disabled={pending}
                className="flex items-center gap-1 rounded-md border border-(--color-border) px-3 py-1.5 text-xs font-medium hover:bg-(--color-surface) disabled:opacity-50"
              >
                {kind === 'approval' ? <X size={14} /> : <CornerUpLeft size={14} />}
                {kind === 'approval' ? 'Reject' : 'Send back'}
              </button>
              <button
                type="button"
                onClick={approve}
                disabled={pending}
                className="flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                <Check size={14} /> Approve
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 rounded-md bg-(--color-accent) px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function optionDir(o: PromptOption): 'rtl' | 'ltr' {
  return textDirection(`${o.label} ${o.description ?? ''}`);
}

function ChoiceOptions({
  options,
  selected,
  multiple,
  onToggle,
  disabled,
}: {
  options: PromptOption[];
  selected: Set<string>;
  multiple: boolean;
  onToggle: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {options.map((o) => {
        const on = selected.has(o.id);
        return (
          <button
            key={o.id}
            type="button"
            dir={optionDir(o)}
            onClick={() => onToggle(o.id)}
            disabled={disabled}
            className={`flex items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
              on
                ? 'border-(--color-accent) bg-(--color-accent)/10'
                : 'border-(--color-border) hover:border-(--color-accent)/60'
            }`}
          >
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border ${
                multiple ? 'rounded' : 'rounded-full'
              } ${on ? 'border-(--color-accent) bg-(--color-accent) text-white' : 'border-(--color-border)'}`}
            >
              {on && <Check size={11} />}
            </span>
            <span className="flex flex-col">
              <span>{o.label}</span>
              {o.description && (
                <span className="text-xs text-(--color-muted)">{o.description}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function PickImageOptions({
  options,
  attachments,
  onPick,
  disabled,
}: {
  options: PromptOption[];
  attachments: TaskAttachment[];
  onPick: (id: string) => void;
  disabled: boolean;
}) {
  const src = (o: PromptOption): string | undefined => {
    if (o.imageUrl) return o.imageUrl;
    if (o.attachmentId) return `/api/files/${o.attachmentId}`;
    return undefined;
  };
  const filenameOf = (o: PromptOption) =>
    o.attachmentId ? attachments.find((a) => a.id === o.attachmentId)?.filename : undefined;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {options.map((o) => {
        const s = src(o);
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onPick(o.id)}
            disabled={disabled}
            className="flex flex-col items-center gap-1 rounded-md border border-(--color-border) p-2 hover:border-(--color-accent) disabled:opacity-50"
          >
            {s ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s} alt={o.label} className="h-24 w-full rounded object-cover" />
            ) : (
              <div className="h-24 w-full rounded bg-(--color-bg)" />
            )}
            <span dir={optionDir(o)} className="text-xs">
              {o.label}
            </span>
            {filenameOf(o) && (
              <span className="text-[10px] text-(--color-muted)">{filenameOf(o)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function AttachmentsPreview({ attachments }: { attachments: TaskAttachment[] }) {
  const images = attachments.filter((a) => a.mimeType.startsWith('image/'));
  const videos = attachments.filter((a) => a.mimeType.startsWith('video/'));
  const others = attachments.filter(
    (a) => !a.mimeType.startsWith('image/') && !a.mimeType.startsWith('video/'),
  );

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a) => (
            <a
              key={a.id}
              href={`/api/files/${a.id}`}
              target="_blank"
              rel="noreferrer"
              title={a.filename}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/files/${a.id}`}
                alt={a.filename}
                className="h-20 w-20 rounded-md border border-(--color-border) object-cover"
              />
            </a>
          ))}
        </div>
      )}
      {videos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {videos.map((a) => (
            <span key={a.id} className="relative block">
              <video
                src={`/api/files/${a.id}`}
                controls
                preload="metadata"
                playsInline
                className="max-h-64 w-full max-w-xs rounded-md bg-black object-contain"
              />
              <Play
                size={16}
                className="pointer-events-none absolute left-2 top-2 text-white/80 drop-shadow"
              />
            </span>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {others.map((a) => (
            <a
              key={a.id}
              href={`/api/files/${a.id}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-(--color-border) bg-(--color-bg) px-2 py-1 text-xs text-(--color-muted) hover:text-(--color-fg)"
            >
              {a.filename}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
