'use client';

import { useRef, useState, useTransition } from 'react';
import { FileText, ImageIcon, Paperclip, Trash2, Upload } from 'lucide-react';
import type { TaskAttachment } from '@getshit/core';
import {
  addAttachmentByUrlAction,
  deleteAttachmentAction,
  revalidateTaskAction,
} from '@/app/actions';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

function isPdf(mime: string): boolean {
  return mime === 'application/pdf';
}

export function TaskAttachments({
  taskId,
  attachments,
}: {
  taskId: string;
  attachments: TaskAttachment[];
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [urlMode, setUrlMode] = useState(false);
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const uploadFiles = (files: FileList | File[]) => {
    if (files.length === 0) return;
    setError(null);
    const form = new FormData();
    form.append('taskId', taskId);
    for (const f of Array.from(files)) form.append('file', f);
    start(async () => {
      const res = await fetch('/api/uploads', { method: 'POST', body: form });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? `Upload failed (${res.status})`);
        return;
      }
      await revalidateTaskAction(taskId);
    });
  };

  const submitUrl = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    start(async () => {
      const r = await addAttachmentByUrlAction(taskId, trimmed);
      if (!r.ok) setError(r.error);
      else {
        setUrl('');
        setUrlMode(false);
      }
    });
  };

  const remove = (id: string) => {
    start(async () => {
      const r = await deleteAttachmentAction(id);
      if (!r.ok) setError(r.error);
      else await revalidateTaskAction(taskId);
    });
  };

  const images = attachments.filter((a) => isImage(a.mimeType));
  const others = attachments.filter((a) => !isImage(a.mimeType));

  return (
    <section className="mb-6 flex flex-col gap-2">
      <h2 className="text-xs uppercase tracking-wide text-(--color-muted) px-2">Files</h2>

      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2">
          {images.map((a) => (
            <a
              key={a.id}
              href={`/api/files/${a.id}`}
              target="_blank"
              rel="noreferrer"
              title={`${a.filename} · ${fmtSize(a.sizeBytes)}`}
              className="block"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/files/${a.id}`}
                alt={a.filename}
                className="h-16 w-16 rounded border border-(--color-border) object-cover"
              />
            </a>
          ))}
        </div>
      )}

      {others.length > 0 && (
        <ul className="flex flex-col gap-1 px-2">
          {others.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded border border-(--color-border) bg-(--color-surface) px-2 py-1 text-sm"
            >
              {isPdf(a.mimeType) ? <FileText size={14} /> : <Paperclip size={14} />}
              <a
                href={`/api/files/${a.id}`}
                target="_blank"
                rel="noreferrer"
                className="flex-1 truncate hover:text-(--color-accent)"
              >
                {a.filename}
              </a>
              <span className="text-xs text-(--color-muted)">{fmtSize(a.sizeBytes)}</span>
              {isPdf(a.mimeType) && (
                <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
                  PDF
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(a.id)}
                disabled={pending}
                className="text-(--color-muted) hover:text-red-400 disabled:opacity-50"
                aria-label="Delete attachment"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
        }}
        className={`mx-2 rounded-md border border-dashed px-3 py-3 text-sm transition-colors ${
          dragging ? 'border-(--color-accent) bg-(--color-surface)' : 'border-(--color-border)'
        }`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-xs hover:border-(--color-accent) disabled:opacity-50"
          >
            <Upload size={12} />
            Choose files
          </button>
          <span className="text-xs text-(--color-muted)">or drop here</span>
          <button
            type="button"
            onClick={() => setUrlMode((v) => !v)}
            className="text-xs text-(--color-muted) hover:text-(--color-fg)"
          >
            {urlMode ? 'Cancel URL' : 'Attach by URL'}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) uploadFiles(e.target.files);
              if (inputRef.current) inputRef.current.value = '';
            }}
          />
        </div>
        {urlMode && (
          <div className="mt-2 flex items-center gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              disabled={pending}
              className="flex-1 rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm outline-none focus:border-(--color-accent) disabled:opacity-50"
            />
            <button
              type="button"
              onClick={submitUrl}
              disabled={pending || url.trim().length === 0}
              className="rounded bg-(--color-accent) px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              {pending ? 'Fetching…' : 'Attach'}
            </button>
          </div>
        )}
        {pending && !urlMode && (
          <p className="mt-2 text-xs text-(--color-muted)">Uploading…</p>
        )}
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>

      {attachments.length === 0 && !pending && (
        <p className="px-2 text-xs text-(--color-muted) flex items-center gap-1">
          <ImageIcon size={12} /> No files yet
        </p>
      )}
    </section>
  );
}
