import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import type { StorageAdapter } from './index.js';

function resolveRoot(): string {
  const raw = process.env['GETSHIT_FILES_DIR'] ?? './data/files';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function absKey(root: string, key: string): string {
  // Keys are server-generated (`attachments/<userId>/<taskId>/<id>-<filename>`)
  // but we still guard against `..` escapes by resolving and asserting prefix.
  const abs = path.resolve(root, key);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error('Invalid storage key');
  }
  return abs;
}

export function createLocalAdapter(): StorageAdapter {
  const root = resolveRoot();
  return {
    kind: 'local',
    async put(key, body) {
      const abs = absKey(root, key);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body);
    },
    async getStream(key) {
      const abs = absKey(root, key);
      const nodeStream = createReadStream(abs);
      // Node's ReadStream → Web ReadableStream so route handlers can return it.
      const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      return { body };
    },
    async getSignedUrl() {
      // Local has no notion of signed URLs; the web layer streams instead.
      return null;
    },
    async delete(key) {
      const abs = absKey(root, key);
      await fs.rm(abs, { force: true });
    },
  };
}
