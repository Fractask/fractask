import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as schema from '../schema.js';
import { localDbPath, resolveDbUrl } from './url.js';

export type Db = LibSQLDatabase<typeof schema>;

let cached: { db: Db; client: Client; url: string; replicated: boolean } | null = null;

const DEFAULT_REPLICA_PATH = path.join(os.homedir(), '.getshit', 'replica.db');
const DEFAULT_SYNC_INTERVAL_SECONDS = 60;

function isRemoteUrl(url: string): boolean {
  return (
    url.startsWith('libsql://') ||
    url.startsWith('https://') ||
    url.startsWith('http://') ||
    url.startsWith('wss://') ||
    url.startsWith('ws://')
  );
}

function replicaPath(): string {
  return process.env['GETSHIT_REPLICA_PATH'] ?? DEFAULT_REPLICA_PATH;
}

function syncIntervalSeconds(): number {
  const raw = process.env['GETSHIT_SYNC_INTERVAL'];
  if (!raw) return DEFAULT_SYNC_INTERVAL_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SYNC_INTERVAL_SECONDS;
}

export function getDb(): Db {
  if (cached) return cached.db;

  const url = resolveDbUrl();
  const fsPath = localDbPath(url);
  if (fsPath) {
    fs.mkdirSync(path.dirname(fsPath), { recursive: true });
  }

  const authToken = process.env['GETSHIT_DB_AUTH_TOKEN'];
  const replicaDisabled = process.env['GETSHIT_EMBEDDED_REPLICA'] === '0';
  const useReplica = isRemoteUrl(url) && !replicaDisabled;

  let client: Client;
  let replicated = false;
  if (useReplica) {
    const localPath = path.resolve(replicaPath());
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    client = createClient({
      url: `file:${localPath}`,
      syncUrl: url,
      ...(authToken ? { authToken } : {}),
      syncInterval: syncIntervalSeconds(),
    });
    replicated = true;
  } else {
    client = createClient(authToken ? { url, authToken } : { url });
  }

  const db = drizzle(client, { schema });
  cached = { db, client, url, replicated };
  return db;
}

export function getDbUrl(): string {
  if (!cached) getDb();
  return cached!.url;
}

export function isReplicated(): boolean {
  if (!cached) getDb();
  return cached!.replicated;
}

/**
 * Force-pull the latest changes from the remote into the local replica.
 * No-op when not using embedded replicas. Call after a write when you need
 * other replicas to catch up faster than the sync interval — or before a
 * read where staleness would be a problem.
 */
export async function syncDb(): Promise<void> {
  if (!cached) getDb();
  if (!cached!.replicated) return;
  await cached!.client.sync();
}

/** Test/maintenance helper. Closes the underlying connection. */
export function closeDb(): void {
  if (!cached) return;
  cached.client.close();
  cached = null;
}
