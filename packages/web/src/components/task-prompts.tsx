'use client';

import { useState, useTransition } from 'react';
import type { AgentPrompt, PromptOption, TaskAttachment } from '@getshit/core';
import { answerPromptAction, cancelPromptAction } from '@/app/actions';

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function attachmentUrl(id: string): string {
  return `/api/files/${id}`;
}

function imgSrcFor(opt: PromptOption): string | undefined {
  if (opt.imageUrl) return opt.imageUrl;
  if (opt.attachmentId) return attachmentUrl(opt.attachmentId);
  return undefined;
}

export function TaskPrompts({
  prompts,
  attachments,
}: {
  prompts: AgentPrompt[];
  attachments: TaskAttachment[];
}) {
  if (prompts.length === 0) return null;
  const pending = prompts.filter((p) => p.status === 'pending');
  const settled = prompts.filter((p) => p.status !== 'pending');

  return (
    <section className="mb-6 flex flex-col gap-3">
      {pending.length > 0 && (
        <>
          <h2 className="text-xs uppercase tracking-wide text-(--color-muted) px-2">
            Needs your input
          </h2>
          {pending.map((p) => (
            <PromptCard key={p.id} prompt={p} attachments={attachments} />
          ))}
        </>
      )}
      {settled.length > 0 && (
        <details className="px-2 text-xs text-(--color-muted)">
          <summary className="cursor-pointer select-none">
            {settled.length} past prompt{settled.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {settled.map((p) => (
              <li key={p.id}>
                <SettledSummary prompt={p} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function SettledSummary({ prompt }: { prompt: AgentPrompt }) {
  const ts = prompt.answeredAt ?? prompt.cancelledAt ?? prompt.createdAt;
  let summary = '';
  if (prompt.status === 'cancelled') summary = 'Cancelled';
  else if (prompt.kind === 'approval') summary = prompt.answer?.approved ? 'Approved' : 'Rejected';
  else if (prompt.kind === 'text') summary = `Replied: ${prompt.answer?.text ?? ''}`;
  else {
    const ids = prompt.answer?.selectedIds ?? [];
    const labels = ids
      .map((id) => prompt.options?.find((o) => o.id === id)?.label ?? id)
      .join(', ');
    summary = `Picked: ${labels}`;
  }
  return (
    <span dir="auto">
      <span className="text-(--color-muted)">[{fmtTime(ts)}]</span>{' '}
      <span className="text-(--color-fg)">{prompt.prompt}</span>{' '}
      <span className="text-(--color-muted)">— {summary}</span>
    </span>
  );
}

function PromptCard({
  prompt,
  attachments,
}: {
  prompt: AgentPrompt;
  attachments: TaskAttachment[];
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const cancel = () => {
    start(async () => {
      const r = await cancelPromptAction(prompt.id);
      if (!r.ok) setError(r.error);
    });
  };

  return (
    <div className="rounded-md border border-(--color-border) bg-(--color-surface) px-4 py-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div dir="auto" className="text-sm font-medium text-(--color-fg) whitespace-pre-wrap">
          {prompt.prompt}
        </div>
        <button
          type="button"
          onClick={cancel}
          disabled={pending}
          className="text-xs text-(--color-muted) hover:text-(--color-fg) disabled:opacity-50"
          title="Cancel — agent will give up on this question"
        >
          dismiss
        </button>
      </div>
      {prompt.kind === 'text' && <TextPromptBody prompt={prompt} setError={setError} />}
      {prompt.kind === 'approval' && <ApprovalPromptBody prompt={prompt} setError={setError} />}
      {prompt.kind === 'choice' && <ChoicePromptBody prompt={prompt} setError={setError} />}
      {prompt.kind === 'pick_image' && (
        <PickImagePromptBody
          prompt={prompt}
          attachments={attachments}
          setError={setError}
        />
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}

type BodyProps = {
  prompt: AgentPrompt;
  setError: (s: string | null) => void;
};

function TextPromptBody({ prompt, setError }: BodyProps) {
  const [text, setText] = useState('');
  const [pending, start] = useTransition();
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    start(async () => {
      const r = await answerPromptAction(prompt.id, { text: t });
      if (!r.ok) setError(r.error);
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        dir="auto"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Your answer…"
        disabled={pending}
        className="w-full rounded border border-(--color-border) bg-(--color-bg) p-2 text-sm outline-none focus:border-(--color-accent) disabled:opacity-50"
      />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={submit}
          disabled={pending || text.trim().length === 0}
          className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Sending…' : 'Reply'}
        </button>
      </div>
    </div>
  );
}

function ApprovalPromptBody({ prompt, setError }: BodyProps) {
  const [comment, setComment] = useState('');
  const [pending, start] = useTransition();
  const submit = (approved: boolean) => {
    start(async () => {
      const r = await answerPromptAction(prompt.id, {
        approved,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      if (!r.ok) setError(r.error);
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <input
        dir="auto"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Optional comment"
        disabled={pending}
        className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm outline-none focus:border-(--color-accent) disabled:opacity-50"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={pending}
          className="rounded border border-(--color-border) px-3 py-1 text-xs font-medium hover:bg-(--color-surface) disabled:opacity-50"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => submit(true)}
          disabled={pending}
          className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          Approve
        </button>
      </div>
    </div>
  );
}

function ChoicePromptBody({ prompt, setError }: BodyProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const opts = prompt.options ?? [];
  const submit = () => {
    if (selected.size === 0) return;
    start(async () => {
      const r = await answerPromptAction(prompt.id, { selectedIds: [...selected] });
      if (!r.ok) setError(r.error);
    });
  };
  const toggle = (id: string) => {
    if (prompt.multiple) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelected(next);
    } else {
      setSelected(new Set([id]));
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {opts.map((o) => (
          <li key={o.id}>
            <label
              dir="auto"
              className="flex items-start gap-2 cursor-pointer rounded px-2 py-1 hover:bg-(--color-bg)"
            >
              <input
                type={prompt.multiple ? 'checkbox' : 'radio'}
                name={`p-${prompt.id}`}
                checked={selected.has(o.id)}
                onChange={() => toggle(o.id)}
                disabled={pending}
                className="mt-1 shrink-0"
              />
              <span className="flex flex-col">
                <span dir="auto" className="text-sm">{o.label}</span>
                {o.description && (
                  <span dir="auto" className="text-xs text-(--color-muted)">{o.description}</span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={submit}
          disabled={pending || selected.size === 0}
          className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Sending…' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

function PickImagePromptBody({
  prompt,
  attachments,
  setError,
}: BodyProps & { attachments: TaskAttachment[] }) {
  const [pending, start] = useTransition();
  const opts = prompt.options ?? [];
  const pick = (optId: string) => {
    start(async () => {
      const r = await answerPromptAction(prompt.id, { selectedIds: [optId] });
      if (!r.ok) setError(r.error);
    });
  };
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
      {opts.map((o) => {
        const src = imgSrcFor(o);
        const filename = o.attachmentId
          ? attachments.find((a) => a.id === o.attachmentId)?.filename
          : undefined;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => pick(o.id)}
            disabled={pending}
            className="flex flex-col items-center gap-1 rounded border border-(--color-border) p-2 hover:border-(--color-accent) disabled:opacity-50"
          >
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={o.label}
                className="h-24 w-full rounded object-cover"
              />
            ) : (
              <div className="h-24 w-full rounded bg-(--color-bg)" />
            )}
            <span dir="auto" className="text-xs">{o.label}</span>
            {filename && <span dir="auto" className="text-[10px] text-(--color-muted)">{filename}</span>}
          </button>
        );
      })}
    </div>
  );
}
