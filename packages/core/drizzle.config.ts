import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'drizzle-kit';

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const raw = process.env['GETSHIT_DB_URL'] ?? 'file:~/.getshit/db.sqlite';
const url = raw.startsWith('file:')
  ? `file:${path.resolve(expandHome(raw.slice('file:'.length)))}`
  : raw;

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url },
});
