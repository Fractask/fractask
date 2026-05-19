/**
 * Pluggable storage for task attachments.
 *
 * Driver selection:
 *  - If `GETSHIT_STORAGE` is set, it wins ("local" or "s3").
 *  - Else, auto-detect: if all three S3 credentials env vars are present
 *    (`GETSHIT_S3_BUCKET`, `GETSHIT_S3_ACCESS_KEY_ID`,
 *    `GETSHIT_S3_SECRET_ACCESS_KEY`), use S3. Otherwise fall back to local.
 *
 * The auto-detect rule keeps the zero-config OSS path (no env → local file
 * under GETSHIT_FILES_DIR) while stopping a remote MCP server that already
 * has S3 creds in its env from silently writing to a throwaway local disk
 * the human can't open. S3 works with any S3-compatible endpoint (AWS, R2,
 * MinIO, B2) via @aws-sdk/client-s3. Force-local with `GETSHIT_STORAGE=local`
 * if you need the credentials in env for some other purpose.
 *
 * Adapters expose four operations: put, getStream (for the local serve path),
 * getSignedUrl (returns null when the adapter can't presign, telling the
 * web layer to fall back to streaming), and delete.
 */
import type { AttachmentStorage } from '../schema.js';
import { createLocalAdapter } from './local.js';

export type StorageBody = Buffer | Uint8Array;

export interface StorageAdapter {
  readonly kind: AttachmentStorage;
  put(key: string, body: StorageBody, mimeType: string): Promise<void>;
  getStream(key: string): Promise<{ body: ReadableStream<Uint8Array>; mimeType?: string }>;
  /** Returns a time-limited URL the browser can hit directly, or null if not supported (local). */
  getSignedUrl(key: string, ttlSeconds?: number): Promise<string | null>;
  delete(key: string): Promise<void>;
}

let cached: Promise<StorageAdapter> | null = null;

function resolveDriver(): 'local' | 's3' {
  const explicit = process.env['GETSHIT_STORAGE']?.toLowerCase();
  if (explicit === 's3' || explicit === 'local') return explicit;
  const hasS3 =
    !!process.env['GETSHIT_S3_BUCKET'] &&
    !!process.env['GETSHIT_S3_ACCESS_KEY_ID'] &&
    !!process.env['GETSHIT_S3_SECRET_ACCESS_KEY'];
  return hasS3 ? 's3' : 'local';
}

export async function getStorage(): Promise<StorageAdapter> {
  if (cached) return cached;
  const driver = resolveDriver();
  if (driver === 's3') {
    // Dynamic import keeps the AWS SDK out of the default-local cold path.
    cached = import('./s3.js').then((m) => m.createS3Adapter());
    return cached;
  }
  cached = Promise.resolve(createLocalAdapter());
  return cached;
}

/** Test seam — drop the cached adapter so the next getStorage() re-reads env. */
export function resetStorageCache(): void {
  cached = null;
}

export function maxUploadBytes(): number {
  const raw = Number(process.env['GETSHIT_MAX_UPLOAD_MB'] ?? '25');
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 25;
  return Math.floor(mb * 1024 * 1024);
}
