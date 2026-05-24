'use server';

import {
  createBrainNote as coreCreateBrainNote,
  deleteBrainNote as coreDeleteBrainNote,
  moveBrainNote as coreMoveBrainNote,
  resolveInternalLinks as coreResolveInternalLinks,
  searchBrainNotes as coreSearchBrainNotes,
  searchLinkables as coreSearchLinkables,
  updateBrainNote as coreUpdateBrainNote,
  addAttachmentFromUrl as coreAddAttachmentFromUrl,
  deleteAttachment as coreDeleteAttachment,
  AmbiguousIdError,
  CycleError,
  NotFoundError,
  type BrainNote,
  type BrainNoteSearchHit,
  type InternalLinkInfo,
  type InternalLinkRef,
  type LinkableHit,
  type TaskAttachment,
} from '@getshit/core';
import { revalidatePath } from 'next/cache';
import { getRequestContext } from '@/lib/auth';

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

function toError(err: unknown): string {
  if (err instanceof NotFoundError) return err.message;
  if (err instanceof AmbiguousIdError) return err.message;
  if (err instanceof CycleError) return err.message;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

function paths(note: { id: string; parentNoteId: string | null; scopeTaskId: string | null }) {
  revalidatePath('/brain');
  revalidatePath(`/brain/${note.id}`);
  if (note.parentNoteId) revalidatePath(`/brain/${note.parentNoteId}`);
  if (note.scopeTaskId) revalidatePath(`/${note.scopeTaskId}`);
  revalidatePath('/', 'layout');
}

export async function createBrainNoteAction(input: {
  title: string;
  icon?: string | null;
  scopeTaskId?: string | null;
  parentNoteId?: string | null;
  contentText?: string;
}): Promise<ActionResult<BrainNote>> {
  try {
    const ctx = await getRequestContext();
    const note = await coreCreateBrainNote(ctx, {
      title: input.title,
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.scopeTaskId !== undefined ? { scopeTaskId: input.scopeTaskId } : {}),
      ...(input.parentNoteId !== undefined ? { parentNoteId: input.parentNoteId } : {}),
      ...(input.contentText !== undefined ? { contentText: input.contentText } : {}),
    });
    paths(note);
    return { ok: true, value: note };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function updateBrainNoteAction(
  id: string,
  patch: {
    title?: string;
    icon?: string | null;
    scopeTaskId?: string | null;
    parentNoteId?: string | null;
    contentText?: string;
    contentJson?: unknown;
  },
): Promise<ActionResult<BrainNote>> {
  try {
    const ctx = await getRequestContext();
    const note = await coreUpdateBrainNote(ctx, id, patch);
    paths(note);
    return { ok: true, value: note };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function deleteBrainNoteAction(
  id: string,
): Promise<ActionResult<{ deletedIds: string[] }>> {
  try {
    const ctx = await getRequestContext();
    const result = await coreDeleteBrainNote(ctx, id);
    revalidatePath('/brain');
    revalidatePath('/', 'layout');
    return { ok: true, value: result };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function moveBrainNoteAction(
  id: string,
  newParentNoteId: string | null,
  position?: number,
): Promise<ActionResult<BrainNote>> {
  try {
    const ctx = await getRequestContext();
    const note = await coreMoveBrainNote(ctx, id, newParentNoteId, position);
    paths(note);
    if (newParentNoteId) revalidatePath(`/brain/${newParentNoteId}`);
    return { ok: true, value: note };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function searchBrainNotesAction(
  query: string,
  limit?: number,
): Promise<ActionResult<BrainNoteSearchHit[]>> {
  try {
    const ctx = await getRequestContext();
    const hits = await coreSearchBrainNotes(ctx, query, { limit: limit ?? 12 });
    return { ok: true, value: hits };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function resolveInternalLinksAction(
  refs: InternalLinkRef[],
): Promise<ActionResult<InternalLinkInfo[]>> {
  try {
    const ctx = await getRequestContext();
    const map = await coreResolveInternalLinks(ctx, refs);
    return { ok: true, value: Array.from(map.values()) };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function addNoteAttachmentByUrlAction(
  noteId: string,
  url: string,
): Promise<ActionResult<TaskAttachment>> {
  try {
    const ctx = await getRequestContext();
    const att = await coreAddAttachmentFromUrl(ctx, { brainNoteId: noteId }, url, 'human');
    revalidatePath(`/brain/${noteId}`);
    return { ok: true, value: att };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function deleteNoteAttachmentAction(
  id: string,
  noteId: string,
): Promise<ActionResult<void>> {
  try {
    const ctx = await getRequestContext();
    await coreDeleteAttachment(ctx, id);
    revalidatePath(`/brain/${noteId}`);
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function revalidateBrainNoteAction(noteId: string): Promise<ActionResult<void>> {
  revalidatePath(`/brain/${noteId}`);
  return { ok: true, value: undefined };
}

/**
 * Mixed search across tasks and notes for the editor's "/" link picker.
 * Empty query returns recent notes; otherwise returns prioritized hits.
 */
export async function searchLinkablesAction(
  query: string,
  limit?: number,
): Promise<ActionResult<LinkableHit[]>> {
  try {
    const ctx = await getRequestContext();
    const hits = await coreSearchLinkables(ctx, query, limit ?? 10);
    return { ok: true, value: hits };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}
