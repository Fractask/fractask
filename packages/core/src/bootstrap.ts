import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { resolveTokenToUser } from './auth.js';
import { users, type User } from './schema.js';

const CONFIG_DIR = path.join(os.homedir(), '.getshit');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

type LocalConfig = {
  token?: string;
  /** Legacy: bare userId. Deprecated — generate a CLI token from the web UI instead. */
  userId?: string;
};

function readConfig(): LocalConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw) as LocalConfig;
  if (parsed.token || parsed.userId) return parsed;
  return null;
}

function writeConfig(config: LocalConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

let cached: User | null = null;
let legacyWarned = false;

export function resetBootstrapCache(): void {
  cached = null;
  legacyWarned = false;
}

function warnLegacyOnce(): void {
  if (legacyWarned) return;
  legacyWarned = true;
  process.stderr.write(
    'getshit: using legacy bare-userId config. Generate a CLI token at /settings/tokens and replace ~/.getshit/config.json with { "token": "..." }.\n',
  );
}

/**
 * Resolves the current user for CLI/MCP entry points.
 *
 * Resolution order:
 *   1. env GETSHIT_TOKEN — bearer token, hashed against cli_tokens.
 *   2. env GETSHIT_USER_ID — hosted env (Vercel) escape hatch, no disk write.
 *   3. config.token in ~/.getshit/config.json — preferred persisted form.
 *   4. config.userId in ~/.getshit/config.json — legacy, prints stderr warning.
 *   5. None of the above — create a fresh user and persist their userId.
 */
export async function getCurrentUser(): Promise<User> {
  if (cached) return cached;
  const db = getDb();

  const envToken = process.env.GETSHIT_TOKEN;
  if (typeof envToken === 'string' && envToken.length > 0) {
    const user = await resolveTokenToUser(envToken);
    if (!user) {
      throw new Error(
        'getshit: GETSHIT_TOKEN is set but no matching cli_tokens row was found. Token may have been revoked.',
      );
    }
    cached = user;
    return user;
  }

  const envId = process.env.GETSHIT_USER_ID;
  if (typeof envId === 'string' && envId.length > 0) {
    const rows = await db.select().from(users).where(eq(users.id, envId));
    const row = rows[0];
    if (row) {
      cached = row;
      return row;
    }
    // Hosted env points at a user that doesn't exist; fall through to file/create.
  }

  const config = readConfig();
  if (config?.token) {
    const user = await resolveTokenToUser(config.token);
    if (!user) {
      throw new Error(
        'getshit: ~/.getshit/config.json token is invalid or revoked. Re-issue a CLI token from /settings/tokens.',
      );
    }
    cached = user;
    return user;
  }

  if (config?.userId) {
    warnLegacyOnce();
    const rows = await db.select().from(users).where(eq(users.id, config.userId));
    const row = rows[0];
    if (row) {
      cached = row;
      return row;
    }
    // Config points to a user that no longer exists in this DB — recreate it
    // with the same ID so existing data (if any survived) stays linked.
    const recreated: User = {
      id: config.userId,
      email: null,
      name: null,
      googleId: null,
      image: null,
      kind: 'human',
      endpoint: null,
      createdAt: Date.now(),
    };
    await db.insert(users).values(recreated);
    cached = recreated;
    return recreated;
  }

  const newUser: User = {
    id: nanoid(12),
    email: null,
    name: null,
    googleId: null,
    image: null,
    kind: 'human',
    endpoint: null,
    createdAt: Date.now(),
  };
  await db.insert(users).values(newUser);
  writeConfig({ userId: newUser.id });
  cached = newUser;
  return newUser;
}

export async function getCurrentContext(): Promise<Context> {
  const user = await getCurrentUser();
  return { userId: user.id };
}
