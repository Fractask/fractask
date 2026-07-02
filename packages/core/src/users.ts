import { asc, eq, like, or, sql } from 'drizzle-orm';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { users, type User } from './schema.js';

/**
 * Read-only lookups over the `users` table for MCP/CLI callers that need to
 * resolve a person or agent — typically to fill `assigneeId` / `reviewerId`
 * on a task from a human-supplied name.
 *
 * Trust model matches `assignees.ts`: everyone in the (small, invited) group
 * is visible to everyone. `ctx` is accepted for a future "people I work with"
 * filter but not used yet.
 */

export type UserSummary = {
  id: string;
  name: string | null;
  email: string | null;
  kind: User['kind'];
  image: string | null;
  createdAt: number;
};

function toSummary(u: User): UserSummary {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    kind: u.kind,
    image: u.image,
    createdAt: u.createdAt,
  };
}

export async function getUserById(_ctx: Context, id: string): Promise<UserSummary | null> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ? toSummary(rows[0]) : null;
}

/**
 * Case-insensitive exact-name lookup. If several users share a name, the
 * oldest is returned — use `searchUsers` when you need to disambiguate.
 */
export async function getUserByName(_ctx: Context, name: string): Promise<UserSummary | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(users)
    .where(sql`lower(${users.name}) = lower(${name})`)
    .orderBy(asc(users.createdAt))
    .limit(1);
  return rows[0] ? toSummary(rows[0]) : null;
}

export type SearchUsersOptions = { query?: string; limit?: number };

/**
 * Substring search across name and email (case-insensitive via SQLite LIKE).
 * Omit `query` to list everyone. Ordered by name.
 */
export async function searchUsers(
  _ctx: Context,
  opts: SearchUsersOptions = {},
): Promise<UserSummary[]> {
  const db = getDb();
  const limit = opts.limit ?? 50;
  const q = opts.query?.trim();
  const rows = q
    ? await db
        .select()
        .from(users)
        .where(or(like(users.name, `%${q}%`), like(users.email, `%${q}%`)))
        .orderBy(asc(users.name))
        .limit(limit)
    : await db.select().from(users).orderBy(asc(users.name)).limit(limit);
  return rows.map(toSummary);
}
