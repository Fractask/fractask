import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import {
  getBrainNote,
  getTask,
  type BrainNote,
} from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { BrainEditor } from '@/components/brain/brain-editor';
import { NoteIconPicker } from '@/components/brain/note-icon-picker';
import { EditableNoteTitle } from '@/components/brain/note-title';
import { NoteAttachments } from '@/components/brain/note-attachments';
import { NoteChildren } from '@/components/brain/note-children';

export const dynamic = 'force-dynamic';

export default async function BrainNotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await getRequestContext();
  const note = await getBrainNote(ctx, id);
  if (!note) notFound();

  // Build the ancestor trail (note chain → entity → /brain).
  const trail: BrainNote[] = [];
  let cursor: string | null = note.parentNoteId;
  while (cursor) {
    const parent = await getBrainNote(ctx, cursor);
    if (!parent) break;
    trail.unshift(parent);
    cursor = parent.parentNoteId;
  }

  const scope = note.scopeTaskId ? await getTask(ctx, note.scopeTaskId) : null;

  let initialJson: unknown;
  try {
    initialJson = JSON.parse(note.contentJson);
  } catch {
    initialJson = { type: 'doc', content: [] };
  }

  return (
    <div className="px-6 py-6 max-w-4xl mx-auto">
      <nav className="mb-4 flex flex-wrap items-center gap-1 text-xs text-(--color-muted)">
        <Link href="/brain" className="hover:text-(--color-fg)">
          Brain
        </Link>
        {scope && (
          <>
            <ChevronRight size={12} />
            <Link href={`/${scope.id}`} className="hover:text-(--color-fg)">
              {scope.title}
            </Link>
            <ChevronRight size={12} />
            <Link href={`/brain?scope=${scope.id}`} className="hover:text-(--color-fg)">
              Notes
            </Link>
          </>
        )}
        {trail.map((t) => (
          <span key={t.id} className="flex items-center gap-1">
            <ChevronRight size={12} />
            <Link href={`/brain/${t.id}`} className="hover:text-(--color-fg)">
              {t.icon ? `${t.icon} ` : ''}
              {t.title}
            </Link>
          </span>
        ))}
        <ChevronRight size={12} />
        <span className="text-(--color-fg)">
          {note.icon ? `${note.icon} ` : ''}
          {note.title}
        </span>
      </nav>

      <header className="mb-6 flex items-start gap-4">
        <NoteIconPicker noteId={note.id} initial={note.icon} />
        <div className="min-w-0 flex-1">
          <EditableNoteTitle noteId={note.id} initial={note.title} />
          <div className="mt-1 text-[11px] text-(--color-muted) font-mono-id">
            {note.id} ·{' '}
            {scope ? (
              <>
                under{' '}
                <Link href={`/${scope.id}`} className="hover:text-(--color-fg)">
                  {scope.title}
                </Link>{' '}
                ({scope.kind})
              </>
            ) : (
              <>personal</>
            )}{' '}
            · {note.source}
          </div>
        </div>
      </header>

      <div className="mb-6">
        <BrainEditor noteId={note.id} initialJson={initialJson} />
      </div>

      <NoteAttachments noteId={note.id} attachments={note.attachments} />

      <section className="mt-8">
        <h2 className="mb-2 px-2 text-xs uppercase tracking-wide text-(--color-muted)">
          Sub-notes
        </h2>
        <NoteChildren
          parentNoteId={note.id}
          scopeTaskId={note.scopeTaskId}
          children={note.children}
          emptyLabel="No sub-notes yet."
        />
      </section>

      <footer className="mt-10 pt-4 border-t border-(--color-border) text-xs text-(--color-muted) flex items-center gap-4">
        <Link href="/brain" className="hover:text-(--color-fg)">
          ← all brain
        </Link>
      </footer>
    </div>
  );
}
