import os from 'node:os';
import path from 'node:path';

const DEFAULT_DB_PATH = '~/.getshit/db.sqlite';

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolves the SQLite/libsql URL from GETSHIT_DB_URL.
 * Returns a libsql-style URL: `file:/abs/path` for local files, or any
 * `libsql://...` / `http(s)://...` URL passed through verbatim.
 */
export function resolveDbUrl(): string {
  const raw = process.env['GETSHIT_DB_URL'] ?? `file:${DEFAULT_DB_PATH}`;

  if (raw.startsWith('file:')) {
    const rest = raw.slice('file:'.length);
    const abs = path.resolve(expandHome(rest));
    return `file:${abs}`;
  }

  return raw;
}

/**
 * Returns the absolute filesystem path for a `file:` URL, or null for remote URLs.
 * Used by bootstrap code that needs to ensure the parent directory exists.
 */
export function localDbPath(url: string): string | null {
  if (!url.startsWith('file:')) return null;
  return url.slice('file:'.length);
}
