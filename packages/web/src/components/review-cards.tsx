'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  Check,
  ChevronLeft,
  ChevronRight,
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
import { MarkdownView } from '@/components/markdown-view';
import { textDirection } from '@/lib/text-direction';

export type ReviewComment = {
  body: string;
  source: 'human' | 'agent';
  authorName: string;
  createdAt: number;
};

export type ReviewItem = {
  task: Task;
  prompts: AgentPrompt[]; // pending prompts only, oldest first
  attachments: TaskAttachment[];
  lastComment?: ReviewComment | null;
};

export function ReviewCards({ items }: { items: ReviewItem[] }) {
  const [queue, setQueue] = useState(items);
  const [idx, setIdx] = useState(0);

  const clamped = Math.min(idx, Math.max(0, queue.length - 1));

  // Keep the index in range as the queue shrinks (resolving the last item, etc).
  useEffect(() => {
    if (idx > queue.length - 1) setIdx(Math.max(0, queue.length - 1));
  }, [queue.length, idx]);

  const go = (delta: number) =>
    setIdx((i) => Math.min(queue.length - 1, Math.max(0, i + delta)));

  const resolve = (taskId: string) => {
    // Drop the item; the next one slides into the same index automatically.
    setQueue((q) => q.filter((i) => i.task.id !== taskId));
  };

  if (queue.length === 0) return <AllCaughtUp />;

  const item = queue[clamped]!;
  const atStart = clamped === 0;
  const atEnd = clamped === queue.length - 1;
  const headKind = item.prompts[0]?.kind ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-(--color-muted) tabular-nums">
          {clamped + 1} <span className="opacity-50">/ {queue.length}</span>
        </span>
        <div className="flex items-center gap-1">
          <NavArrow dir="left" onClick={() => go(-1)} disabled={atStart} />
          <NavArrow dir="right" onClick={() => go(1)} disabled={atEnd} />
        </div>
      </div>

      {queue.length > 1 && queue.length <= 30 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {queue.map((q, i) => (
            <button
              key={q.task.id}
              type="button"
              aria-label={`Go to item ${i + 1}`}
              onClick={() => setIdx(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === clamped
                  ? 'w-5 bg-(--color-accent)'
                  : 'w-1.5 bg-(--color-border) hover:bg-(--color-muted)'
              }`}
            />
          ))}
        </div>
      )}

      <div className="flex items-stretch gap-2">
        <SideArrow dir="left" onClick={() => go(-1)} disabled={atStart} />
        <div className="min-w-0 flex-1">
          <Slide key={item.task.id}>
            <ReviewCard
              item={item}
              onDone={() => resolve(item.task.id)}
              onPrev={() => go(-1)}
              onNext={() => go(1)}
            />
          </Slide>
        </div>
        <SideArrow dir="right" onClick={() => go(1)} disabled={atEnd} />
      </div>

      <ShortcutBar kind={headKind} />
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-(--color-border) bg-(--color-surface) px-1.5 py-0.5 font-mono text-[10px] text-(--color-fg) shadow-sm">
      {children}
    </kbd>
  );
}

function ShortcutBar({ kind }: { kind: AgentPrompt['kind'] | null }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[11px] text-(--color-muted)">
      <span className="flex items-center gap-1">
        <Kbd>←</Kbd>
        <Kbd>→</Kbd> Move
      </span>
      {(kind === 'approval' || kind === null) && (
        <>
          <span className="flex items-center gap-1">
            <Kbd>A</Kbd> Approve
          </span>
          <span className="flex items-center gap-1">
            <Kbd>R</Kbd> {kind === 'approval' ? 'Reject' : 'Send back'}
          </span>
        </>
      )}
      {(kind === 'text' || kind === 'choice') && (
        <span className="flex items-center gap-1">
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd> {kind === 'text' ? 'Reply' : 'Submit'}
        </span>
      )}
      <span className="flex items-center gap-1">
        <Kbd>C</Kbd> Comment
      </span>
    </div>
  );
}

/** Fade + slide the incoming card in (remounts on index change via key). */
function Slide({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div
      className={`transition-all duration-200 ease-out ${
        shown ? 'translate-x-0 opacity-100' : 'translate-x-2 opacity-0'
      }`}
    >
      {children}
    </div>
  );
}

function NavArrow({
  dir,
  onClick,
  disabled,
}: {
  dir: 'left' | 'right';
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === 'left' ? 'Previous' : 'Next'}
      className="rounded-md border border-(--color-border) p-1 text-(--color-muted) hover:bg-(--color-surface) hover:text-(--color-fg) disabled:opacity-30"
    >
      {dir === 'left' ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
    </button>
  );
}

function SideArrow({
  dir,
  onClick,
  disabled,
}: {
  dir: 'left' | 'right';
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === 'left' ? 'Previous' : 'Next'}
      className="hidden shrink-0 items-center rounded-md px-1 text-(--color-muted) transition-colors hover:bg-(--color-surface) hover:text-(--color-fg) disabled:pointer-events-none disabled:opacity-20 sm:flex"
    >
      {dir === 'left' ? <ChevronLeft size={22} /> : <ChevronRight size={22} />}
    </button>
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

function ReviewCard({
  item,
  onDone,
  onPrev,
  onNext,
}: {
  item: ReviewItem;
  onDone: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { task, attachments } = item;
  const [prompts, setPrompts] = useState(item.prompts);
  const prompt = prompts[0] ?? null;
  const kind = prompt?.kind ?? null;

  const [text, setText] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, onOk: () => void) => {
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

  // Keyboard shortcuts for the active card. Only one card is mounted at a time
  // (the deck shows one), so a single window listener is unambiguous.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT');
      const mod = e.metaKey || e.ctrlKey;

      // ⌘/Ctrl+Enter submits from inside the comment/answer box.
      if (typing) {
        if (mod && e.key === 'Enter') {
          e.preventDefault();
          if (kind === 'text') reply();
          else if (kind === 'approval' || kind === null) approve();
        }
        return;
      }
      if (mod || e.altKey) return;

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          onNext();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          onPrev();
          break;
        case 'a':
        case 'A':
          if (!pending && (kind === 'approval' || kind === null)) {
            e.preventDefault();
            approve();
          }
          break;
        case 'r':
        case 'R':
          if (!pending && (kind === 'approval' || kind === null)) {
            e.preventDefault();
            reject();
          }
          break;
        case 'c':
        case 'C':
          if (showTextarea) {
            e.preventDefault();
            textareaRef.current?.focus();
          }
          break;
        case 'Enter':
          if (kind === 'choice') {
            e.preventDefault();
            submitChoice();
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, pending, comment, selected, prompts.length, onPrev, onNext]);

  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface) shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-(--color-border) px-4 py-3">
        <Link
          href={`/${task.id}`}
          dir={textDirection(task.title)}
          className="text-base font-semibold text-(--color-fg) hover:text-(--color-accent)"
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

      <div className="flex max-h-[58vh] flex-col gap-3 overflow-y-auto p-4">
        {/* What to review — an explicit agent question if there is one, else the
            task's own description is the content to review. */}
        {prompt ? (
          <div>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-(--color-accent)">
              The agent is asking
            </p>
            <div className="rounded-md border-s-2 border-(--color-accent) bg-(--color-bg) px-3 py-2 text-sm">
              <MarkdownView source={prompt.prompt} />
            </div>
          </div>
        ) : (
          <div>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-(--color-muted)">
              Review this — approve, or send back with a note
            </p>
            {task.description ? (
              <div className="rounded-md border-s-2 border-(--color-border) bg-(--color-bg) px-3 py-2 text-sm">
                <MarkdownView source={task.description} />
              </div>
            ) : (
              <p className="text-xs text-(--color-muted)">
                No description — open the task for full context.
              </p>
            )}
          </div>
        )}

        {/* Latest note from the agent — often where the real ask lives when
            the task was moved to review without a formal prompt. */}
        {item.lastComment && (!prompt || item.lastComment.source === 'agent') && (
          <div className="rounded-md border border-(--color-border) px-3 py-2">
            <p className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-(--color-muted)">
              <MessageSquarePlus size={11} />
              Latest note · {item.lastComment.authorName}
            </p>
            <div className="text-sm">
              <MarkdownView source={item.lastComment.body} />
            </div>
          </div>
        )}

        {attachments.length > 0 && <AttachmentsPreview attachments={attachments} />}

        {/* Choice / pick_image */}
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

        {/* Task context, secondary — only when a prompt is the primary content
            (otherwise the description is already shown above as the review). */}
        {prompt && task.description && (
          <details className="text-xs text-(--color-muted)">
            <summary className="cursor-pointer select-none hover:text-(--color-fg)">
              Task details
            </summary>
            <div className="mt-1 rounded-md bg-(--color-bg) p-2">
              <MarkdownView source={task.description} />
            </div>
          </details>
        )}

        {showTextarea && (
          <textarea
            ref={textareaRef}
            dir="auto"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            disabled={pending}
            placeholder={kind === 'text' ? 'Type your answer…' : 'Add a comment (optional)…'}
            className="w-full resize-y rounded-md border border-(--color-border) bg-(--color-bg) p-2.5 text-sm outline-none focus:border-(--color-accent) disabled:opacity-50"
          />
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-(--color-border) bg-(--color-bg)/40 px-4 py-2.5">
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
