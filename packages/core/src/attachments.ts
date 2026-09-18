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
  ForbiddenError,
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

export type AttachmentWithUrl = TaskAttachment & { downloadUrl: string };

/**
 * Agents have no browser session, so `/api/files/<id>` only works for them
 * with a bearer header they have to construct themselves — a step most
 * fetch tools can't do and most agents never get right. When the storage
 * adapter can presign (S3), hand back a URL with the auth already baked in
 * so any plain HTTP GET just works; only local storage (which can't
 * presign) falls back to the bearer-header path.
 */
export async function withDownloadUrls(rows: TaskAttachment[]): Promise<AttachmentWithUrl[]> {
  if (rows.length === 0) return [];
  const adapter = await getStorage();
  return Promise.all(
    rows.map(async (r) => {
      const signed = await adapter.getSignedUrl(r.storageKey, 3600);
      return { ...r, downloadUrl: signed ?? `/api/files/${r.id}` };
    }),
  );
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
  if (!row) throw new NotFoundError(id, 'Attachment');
  if (row.taskId) {
    await assertAccessibleExists(ctx, row.taskId);
  } else if (row.brainNoteId) {
    await assertAccessibleNoteExists(ctx, row.brainNoteId);
  } else {
    // Defensive: rows are required to belong to one of the two owners.
    throw new NotFoundError(id, 'Attachment');
  }
  return row;
}

/**
 * Resolve the parent row to (owner, storage path segment), running the access
 * check. Owner is inherited from the parent — on a shared tree that's the
 * original sharer, not the caller — so every attachment for a task lands under
 * the same prefix regardless of which agent uploaded it.
 */
async function resolveAttachmentParent(
  ctx: Context,
  target: { taskId?: string | undefined; brainNoteId?: string | undefined },
): Promise<{ ownerId: string; storagePathSegment: string }> {
  if (target.taskId) {
    const task = await assertAccessibleExists(ctx, target.taskId);
    return { ownerId: task.userId, storagePathSegment: target.taskId };
  }
  if (target.brainNoteId) {
    const note = await assertAccessibleNoteExists(ctx, target.brainNoteId);
    return { ownerId: note.userId, storagePathSegment: `notes/${target.brainNoteId}` };
  }
  throw new Error('taskId or brainNoteId required');
}

function storageKeyFor(
  ownerId: string,
  storagePathSegment: string,
  id: string,
  safeName: string,
): string {
  return `attachments/${ownerId}/${storagePathSegment}/${id}-${safeName}`;
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
  const { ownerId, storagePathSegment } = await resolveAttachmentParent(ctx, {
    taskId: parsed.taskId,
    brainNoteId: parsed.brainNoteId,
  });

  const id = nanoid(12);
  const safeName = sanitizeFilename(parsed.filename);
  const storageKey = storageKeyFor(ownerId, storagePathSegment, id, safeName);
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

  // Access check BEFORE the fetch — the same rule both siblings state in their
  // own comments (createUploadTicket: "before minting the URL"; createAttachment:
  // "before the storage write so unauthorized callers don't leak orphan blobs").
  // This was the one attachment entry point that checked LAST, and it produced
  // exactly the defect this file's card is about: for a hidden taskId the caller
  // got `Fetch failed: 404` instead of `not_shared`, so the access verdict was
  // masked by an unrelated network outcome — the same id answering differently
  // depending on a second, unrelated argument. It also meant an unauthorized
  // caller could make this server perform an arbitrary outbound GET, and buffer
  // its body up to the size limit, before anything asked whether they could see
  // the target at all.
  //
  // createAttachment below re-runs the same resolution. That is deliberate: it
  // is the authoritative check for the write, it is a cheap indexed read, and
  // removing it would make this hoist load-bearing for a guarantee it was not
  // written to carry.
  await resolveAttachmentParent(ctx, {
    ...(target.taskId ? { taskId: target.taskId } : {}),
    ...(target.brainNoteId ? { brainNoteId: target.brainNoteId } : {}),
  });

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

/**
 * Direct-to-storage upload — the private path for files an agent holds on its
 * own box.
 *
 * `attach_file` keeps the bytes private but pushes them through the model as a
 * tool argument, so it dies on anything past a few hundred KB.
 * `attach_file_from_url` has no size problem but needs a URL the SERVER can
 * fetch, which from a headless box means publishing the file to a public CDN
 * first — minting a permanent, unauthenticated copy of it on the way in. That
 * detour is unacceptable for anything holding a named person's details, and it
 * existed only because there was no third option.
 *
 * This is the third option: the server mints a short-lived presigned PUT into
 * the same private bucket, the caller uploads with plain `curl`, and nothing
 * ever becomes publicly readable. Two steps, because the row must not exist
 * until the bytes actually landed — a row pointing at a missing object is a
 * broken download for everyone who can see the task.
 */
export const createUploadTicketInputSchema = z
  .object({
    taskId: idSchema.optional(),
    brainNoteId: idSchema.optional(),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(200),
    sizeBytes: z.number().int().positive(),
  })
  .refine(
    (v) => (v.taskId ? 1 : 0) + (v.brainNoteId ? 1 : 0) === 1,
    'Exactly one of taskId or brainNoteId is required',
  );
export type CreateUploadTicketInput = z.infer<typeof createUploadTicketInputSchema>;

export interface UploadTicket {
  attachmentId: string;
  uploadUrl: string;
  /** Headers the PUT must carry — both are bound into the signature. */
  headers: Record<string, string>;
  expiresAt: number;
  /** Ready-to-run upload command, so there is nothing to get wrong. */
  curl: string;
}

const UPLOAD_TTL_SECONDS = 900;

export class UploadNotSupportedError extends Error {
  constructor() {
    super(
      'This server stores attachments on local disk, which has nothing to presign. Use attach_file (base64) instead.',
    );
    this.name = 'UploadNotSupportedError';
  }
}

export async function createUploadTicket(
  ctx: Context,
  input: CreateUploadTicketInput,
): Promise<UploadTicket> {
  const parsed = createUploadTicketInputSchema.parse(input);
  if (parsed.sizeBytes > maxUploadBytes()) {
    throw new Error('Upload exceeds GETSHIT_MAX_UPLOAD_MB');
  }
  // Access check BEFORE minting the URL — an unauthorized caller must not walk
  // away holding a write grant into someone else's prefix.
  const { ownerId, storagePathSegment } = await resolveAttachmentParent(ctx, {
    taskId: parsed.taskId,
    brainNoteId: parsed.brainNoteId,
  });

  const id = nanoid(12);
  const safeName = sanitizeFilename(parsed.filename);
  const storageKey = storageKeyFor(ownerId, storagePathSegment, id, safeName);

  const adapter = await getStorage();
  const uploadUrl = await adapter.getSignedUploadUrl(storageKey, {
    mimeType: parsed.mimeType,
    sizeBytes: parsed.sizeBytes,
    ttlSeconds: UPLOAD_TTL_SECONDS,
  });
  if (!uploadUrl) throw new UploadNotSupportedError();

  const headers = { 'Content-Type': parsed.mimeType };
  return {
    attachmentId: id,
    uploadUrl,
    headers,
    expiresAt: Date.now() + UPLOAD_TTL_SECONDS * 1000,
    curl: `curl -sSf -X PUT -H 'Content-Type: ${parsed.mimeType}' --upload-file '<path>' '${uploadUrl}'`,
  };
}

export const finalizeUploadInputSchema = z
  .object({
    attachmentId: idSchema,
    taskId: idSchema.optional(),
    brainNoteId: idSchema.optional(),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(200),
    sizeBytes: z.number().int().positive(),
    /** Caller-declared, stored as-is — see the note in finalizeUpload. */
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    source: z.enum(['human', 'agent']).optional(),
  })
  .refine(
    (v) => (v.taskId ? 1 : 0) + (v.brainNoteId ? 1 : 0) === 1,
    'Exactly one of taskId or brainNoteId is required',
  );
export type FinalizeUploadInput = z.infer<typeof finalizeUploadInputSchema>;

/**
 * Confirm an uploaded object and create the attachment row.
 *
 * Every field that decides WHERE we look is re-derived here from the caller's
 * own access check, never taken from the request: a forged `attachmentId` can
 * only ever address a key inside the caller's own prefix, so this cannot be
 * used to adopt another user's object.
 *
 * The size on the object is authoritative and must match what the caller
 * declared — that is the truncation guard, the same one `attach_file` gets
 * from `sizeBytes`. `sha256` is caller-declared and stored unverified (we
 * would have to download the object to check it, which defeats the point of
 * uploading direct); it is a provenance note, not an integrity proof.
 */
export async function finalizeUpload(
  ctx: Context,
  input: FinalizeUploadInput,
): Promise<TaskAttachment> {
  const parsed = finalizeUploadInputSchema.parse(input);
  const { ownerId, storagePathSegment } = await resolveAttachmentParent(ctx, {
    taskId: parsed.taskId,
    brainNoteId: parsed.brainNoteId,
  });

  const safeName = sanitizeFilename(parsed.filename);
  const storageKey = storageKeyFor(ownerId, storagePathSegment, parsed.attachmentId, safeName);

  const adapter = await getStorage();
  const meta = await adapter.head(storageKey);
  if (!meta) {
    throw new Error(
      `No uploaded object found for attachmentId ${parsed.attachmentId}. Did the PUT succeed, and are filename/taskId identical to the create_upload call?`,
    );
  }
  if (meta.sizeBytes !== parsed.sizeBytes) {
    // Delete rather than keep: a size mismatch means the PUT was truncated or
    // this is not the file that was declared. Leaving it would strand an
    // unreferenced object nobody can see or clean up.
    await adapter.delete(storageKey).catch(() => {});
    throw new Error(
      `Uploaded object is ${meta.sizeBytes} bytes but you declared ${parsed.sizeBytes}. Nothing was attached; re-upload the whole file.`,
    );
  }
  if (meta.sizeBytes > maxUploadBytes()) {
    await adapter.delete(storageKey).catch(() => {});
    throw new Error('Upload exceeds GETSHIT_MAX_UPLOAD_MB');
  }

  const row: TaskAttachment = {
    id: parsed.attachmentId,
    userId: ownerId,
    taskId: parsed.taskId ?? null,
    brainNoteId: parsed.brainNoteId ?? null,
    filename: safeName,
    mimeType: parsed.mimeType,
    sizeBytes: meta.sizeBytes,
    storage: adapter.kind as AttachmentStorage,
    storageKey,
    sha256: parsed.sha256 ?? null,
    source: parsed.source ?? 'agent',
    createdAt: Date.now(),
  };
  await getDb().insert(taskAttachments).values(row);
  return row;
}

export async function deleteAttachment(ctx: Context, id: string): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(taskAttachments).where(eq(taskAttachments.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(id, 'Attachment');
  // Deletion is owner-only — same rule as task delete. For note-scoped
  // attachments, fall back to the access check (owner of the note can delete).
  if (row.taskId) {
    await assertOwnedExists(ctx, row.taskId);
  } else if (row.brainNoteId) {
    const note = await assertAccessibleNoteExists(ctx, row.brainNoteId);
    if (note.userId !== ctx.userId) {
      // Was a bare `Error`, which both transports drop into the catch-all — so
      // "you are not the owner" arrived on the wire with the same `error:`
      // prefix as a database outage. The task branch one clause up has said
      // ForbiddenError all along; these two branches answer the same question
      // and only one of them was audible.
      throw new ForbiddenError(row.brainNoteId, 'Note');
    }
  } else {
    throw new NotFoundError(id, 'Attachment');
  }
  await db.delete(taskAttachments).where(eq(taskAttachments.id, id));
  try {
    const adapter = await getStorage();
    await adapter.delete(row.storageKey);
  } catch {
    // Best-effort: row is gone; orphan blobs are recoverable via storage_key.
  }
}

