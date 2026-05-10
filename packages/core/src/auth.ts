import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from './db/client.js';
import { cliTokens, users, type CliToken, type User } from './schema.js';

export type GoogleProfile = {
  sub: string;
  email?: string | null;
  name?: string | null;
  picture?: string | null;
};

/**
 * Resolve a Google profile to our internal users.id, linking by google_id
 * (returning user) or by email (existing pre-Google user) and creating a
 * row when neither matches. Idempotent.
 */
export async function linkOrCreateGoogleUser(profile: GoogleProfile): Promise<User> {
  const db = getDb();

  const byGoogle = await db.select().from(users).where(eq(users.googleId, profile.sub));
  if (byGoogle[0]) return byGoogle[0];

  if (profile.email) {
    const byEmail = await db.select().from(users).where(eq(users.email, profile.email));
    const existing = byEmail[0];
    if (existing) {
      const linked: User = {
        ...existing,
        googleId: profile.sub,
        name: existing.name ?? profile.name ?? null,
        image: existing.image ?? profile.picture ?? null,
      };
      await db
        .update(users)
        .set({
          googleId: profile.sub,
          name: linked.name,
          image: linked.image,
        })
        .where(eq(users.id, existing.id));
      return linked;
    }
  }

  const newUser: User = {
    id: nanoid(12),
    email: profile.email ?? null,
    name: profile.name ?? null,
    googleId: profile.sub,
    image: profile.picture ?? null,
    kind: 'human',
    endpoint: null,
    createdAt: Date.now(),
  };
  await db.insert(users).values(newUser);
  return newUser;
}

export async function findUserById(id: string): Promise<User | null> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, id));
  return rows[0] ?? null;
}

export type CreateUserInput = {
  kind: 'human' | 'agent' | 'guest';
  name?: string | null;
  email?: string | null;
  endpoint?: string | null;
};

/**
 * Create a user row. Used to seed agents (with chat endpoint), guests (limited
 * humans), or pre-seed humans before they sign in. Email or endpoint must be
 * present so the row is reachable somehow.
 */
export async function createUser(input: CreateUserInput): Promise<User> {
  const email = input.email?.trim().toLowerCase() || null;
  const endpoint = input.endpoint?.trim() || null;
  if (!email && !endpoint) {
    throw new Error('User needs at least an email or an endpoint URL.');
  }
  if (email) {
    const existing = await getDb().select().from(users).where(eq(users.email, email));
    if (existing[0]) {
      throw new Error(`A user with email ${email} already exists.`);
    }
  }

  const row: User = {
    id: nanoid(12),
    email,
    name: input.name?.trim() || null,
    googleId: null,
    image: null,
    kind: input.kind,
    endpoint,
    createdAt: Date.now(),
  };
  await getDb().insert(users).values(row);
  return row;
}

const TOKEN_PREFIX = 'gs_';

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Mint a new CLI token for the given user. Returns the raw token (shown once
 * to the user) and the stored row. The raw token is never recoverable later.
 */
export async function createCliToken(
  userId: string,
  label: string | null,
): Promise<{ token: string; row: CliToken }> {
  const raw = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const row: CliToken = {
    id: nanoid(12),
    userId,
    tokenHash: hashToken(raw),
    label: label ?? null,
    lastUsedAt: null,
    createdAt: Date.now(),
  };
  const db = getDb();
  await db.insert(cliTokens).values(row);
  return { token: raw, row };
}

export async function listCliTokens(userId: string): Promise<CliToken[]> {
  const db = getDb();
  return db
    .select()
    .from(cliTokens)
    .where(eq(cliTokens.userId, userId))
    .orderBy(desc(cliTokens.createdAt));
}

export async function revokeCliToken(userId: string, id: string): Promise<void> {
  const db = getDb();
  await db.delete(cliTokens).where(and(eq(cliTokens.id, id), eq(cliTokens.userId, userId)));
}

/**
 * Resolve a raw bearer token to its owning user. Updates lastUsedAt as a
 * side effect so the settings UI can show recency.
 */
export async function resolveTokenToUser(rawToken: string): Promise<User | null> {
  if (!rawToken) return null;
  const hash = hashToken(rawToken);
  const db = getDb();
  const tokenRows = await db
    .select()
    .from(cliTokens)
    .where(eq(cliTokens.tokenHash, hash));
  const tokenRow = tokenRows[0];
  if (!tokenRow) return null;

  const user = await findUserById(tokenRow.userId);
  if (!user) return null;

  await db
    .update(cliTokens)
    .set({ lastUsedAt: Date.now() })
    .where(eq(cliTokens.id, tokenRow.id));

  return user;
}
