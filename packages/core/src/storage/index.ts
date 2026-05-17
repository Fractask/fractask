/**
 * Pluggable storage for task attachments.
 *
 * `local` (default) writes under GETSHIT_FILES_DIR — zero config, fits the
 * OSS self-host story. `s3` uses any S3-compatible endpoint (AWS, R2, MinIO,
 * B2) via @aws-sdk/client-s3, selected by GETSHIT_STORAGE=s3.
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

export async function getStorage(): Promise<StorageAdapter> {
  if (cached) return cached;
  const driver = (process.env['GETSHIT_STORAGE'] ?? 'local').toLowerCase();
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
