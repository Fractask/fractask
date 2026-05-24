import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import {
  taskAttachments,
  type TaskAttachment,
  type AttachmentStorage,
} from './schema.js';
import {
  assertAccessibleExists,
  assertAccessibleNoteExists,
  assertOwnedExists,
  NotFoundError,
} from './access.js';
import { getStorage, maxUploadBytes } from './storage/index.js';
import { idSchema } from './types.js';

export const createAttachmentInputSchema = z
  .object({
    taskId: idSchema.optional(),
    brainNoteId: idSchema.optional(),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(200),
    body: z.instanceof(Uint8Array),
    source: z.enum(['human', 'agent']).optional(),
  })
  .refine(
    (v) => (v.taskId ? 1 : 0) + (v.brainNoteId ? 1 : 0) === 1,
    'Exactly one of taskId or brainNoteId is required',
  );
export type CreateAttachmentInput = z.infer<typeof createAttachmentInputSchema>;

function sanitizeFilename(name: string): string {
  // Strip path components and anything that's not a plain filename char.
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200) || 'file';
}

export async function listAttachments(ctx: Context, taskId: string): Promise<TaskAttachment[]> {
  await assertAccessibleExists(ctx, taskId);
  const db = getDb();
  return db.select().from(taskAttachments).where(eq(taskAttachments.taskId, taskId));
}

export async function listAttachmentsForNote(
  ctx: Context,
  brainNoteId: string,
): Promise<TaskAttachment[]> {
  await assertAccessibleNoteExists(ctx, brainNoteId);
  const db = getDb();
  return db.select().from(taskAttachments).where(eq(taskAttachments.brainNoteId, brainNoteId));
}

export async function listAttachmentsForTasks(
  ctx: Context,
  taskIds: string[],
): Promise<Map<string, TaskAttachment[]>> {
  const out = new Map<string, TaskAttachment[]>();
  if (taskIds.length === 0) return out;
  const db = getDb();
  const rows = await db
    .select()
    .from(taskAttachments)
    .where(and(eq(taskAttachments.userId, ctx.userId), inArray(taskAttachments.taskId, taskIds)));
  for (const r of rows) {
    if (!r.taskId) continue;
    const list = out.get(r.taskId) ?? [];
    list.push(r);
    out.set(r.taskId, list);
  }
  return out;
}

export async function getAttachment(ctx: Context, id: string): Promise<TaskAttachment> {
  const db = getDb();
  const rows = await db.select().from(taskAttachments).where(eq(taskAttachments.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  if (row.taskId) {
    await assertAccessibleExists(ctx, row.taskId);
  } else if (row.brainNoteId) {
    await assertAccessibleNoteExists(ctx, row.brainNoteId);
  } else {
    // Defensive: rows are required to belong to one of the two owners.
    throw new NotFoundError(id);
  }
  return row;
}

export async function createAttachment(
  ctx: Context,
  input: CreateAttachmentInput,
): Promise<TaskAttachment> {
  const parsed = createAttachmentInputSchema.parse(input);
  const size = parsed.body.byteLength;
  if (size === 0) throw new Error('Empty upload');
  if (size > maxUploadBytes()) throw new Error('Upload exceeds GETSHIT_MAX_UPLOAD_MB');

  // Inherit owner from the parent row (shared trees → owner is the original
  // sharer). Access check runs BEFORE the storage write so unauthorized
  // callers don't leak orphan blobs to disk.
  let ownerId = ctx.userId;
  let storagePathSegment: string;
  if (parsed.taskId) {
    const task = await assertAccessibleExists(ctx, parsed.taskId);
    ownerId = task.userId;
    storagePathSegment = parsed.taskId;
  } else if (parsed.brainNoteId) {
    const note = await assertAccessibleNoteExists(ctx, parsed.brainNoteId);
    ownerId = note.userId;
    storagePathSegment = `notes/${parsed.brainNoteId}`;
  } else {
    throw new Error('taskId or brainNoteId required');
  }

  const id = nanoid(12);
  const safeName = sanitizeFilename(parsed.filename);
  const storageKey = `attachments/${ownerId}/${storagePathSegment}/${id}-${safeName}`;
  const sha256 = createHash('sha256').update(parsed.body).digest('hex');

  const adapter = await getStorage();
  await adapter.put(storageKey, parsed.body, parsed.mimeType);

  const row: TaskAttachment = {
    id,
    userId: ownerId,
    taskId: parsed.taskId ?? null,
    brainNoteId: parsed.brainNoteId ?? null,
    filename: safeName,
    mimeType: parsed.mimeType,
    sizeBytes: size,
    storage: adapter.kind as AttachmentStorage,
    storageKey,
    sha256,
    source: parsed.source ?? 'human',
    createdAt: Date.now(),
  };
  await getDb().insert(taskAttachments).values(row);
  return row;
}

/**
 * Server-side fetch a remote URL and store it as an attachment.
 * Used by the `attach_file_from_url` MCP tool so agents don't have to
 * base64-encode large bodies into tool arguments. Pass either `taskId` or
 * `brainNoteId` (exactly one).
 */
export async function addAttachmentFromUrl(
  ctx: Context,
  target: { taskId?: string; brainNoteId?: string },
  url: string,
  source: 'human' | 'agent' = 'agent',
): Promise<TaskAttachment> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const limit = maxUploadBytes();
  const contentLength = Number(res.headers.get('content-length') ?? '0');
  if (contentLength > limit) throw new Error('Remote file exceeds GETSHIT_MAX_UPLOAD_MB');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > limit) throw new Error('Remote file exceeds GETSHIT_MAX_UPLOAD_MB');
  const mimeType =
    res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream';
  const filename = decodeURIComponent(parsedUrl.pathname.split('/').pop() || 'download');
  return createAttachment(ctx, {
    ...(target.taskId ? { taskId: target.taskId } : {}),
    ...(target.brainNoteId ? { brainNoteId: target.brainNoteId } : {}),
    filename,
    mimeType,
    body: buf,
    source,
  });
}

export async function deleteAttachment(ctx: Context, id: string): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(taskAttachments).where(eq(taskAttachments.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  // Deletion is owner-only — same rule as task delete. For note-scoped
  // attachments, fall back to the access check (owner of the note can delete).
  if (row.taskId) {
    await assertOwnedExists(ctx, row.taskId);
  } else if (row.brainNoteId) {
    const note = await assertAccessibleNoteExists(ctx, row.brainNoteId);
    if (note.userId !== ctx.userId) {
      throw new Error('Only the owner can delete this attachment');
    }
  } else {
    throw new NotFoundError(id);
  }
  await db.delete(taskAttachments).where(eq(taskAttachments.id, id));
  try {
    const adapter = await getStorage();
    await adapter.delete(row.storageKey);
  } catch {
    // Best-effort: row is gone; orphan blobs are recoverable via storage_key.
  }
}

