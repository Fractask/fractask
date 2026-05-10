import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { assertOwnedExists } from './access.js';
import { taskShares, tasks, users, type User, type TaskShare } from './schema.js';

export class UnknownEmailError extends Error {
  constructor(email: string) {
    super(`No user found for ${email}`);
    this.name = 'UnknownEmailError';
  }
}

export type ShareEntry = {
  taskId: string;
  user: User;
  createdAt: number;
  /** Set when this share comes from an ancestor task, not a direct share. */
  via?: { id: string; title: string };
};

async function findOrCreateUserByEmail(email: string): Promise<User> {
  const normalized = email.trim().toLowerCase();
  const db = getDb();
  const existing = await db.select().from(users).where(eq(users.email, normalized));
  if (existing[0]) return existing[0];

  const newUser: User = {
    id: nanoid(12),
    email: normalized,
    name: null,
    googleId: null,
    image: null,
    kind: 'human',
    endpoint: null,
    createdAt: Date.now(),
  };
  await db.insert(users).values(newUser);
  return newUser;
}

/**
 * Share `taskId` with the user owning `email`. Owner-only. Creates a placeholder
 * user row when the email is unknown — they'll inherit the row on first
 * Google sign-in by email match. Idempotent: re-sharing the same pair is a no-op.
 */
export async function shareTaskWithEmail(
  ctx: Context,
  taskId: string,
  email: string,
): Promise<ShareEntry> {
  await assertOwnedExists(ctx, taskId);
  const recipient = await findOrCreateUserByEmail(email);
  if (recipient.id === ctx.userId) {
    throw new Error("You can't share a task with yourself.");
  }

  const db = getDb();
  const existing = await db
    .select()
    .from(taskShares)
    .where(and(eq(taskShares.taskId, taskId), eq(taskShares.userId, recipient.id)));
  if (existing[0]) {
    return { taskId, user: recipient, createdAt: existing[0].createdAt };
  }

  const row: TaskShare = { taskId, userId: recipient.id, createdAt: Date.now() };
  await db.insert(taskShares).values(row);
  return { taskId, user: recipient, createdAt: row.createdAt };
}

/**
 * Revoke a direct share. Owner-only. No-op if the share didn't exist.
 */
export async function unshareTask(
  ctx: Context,
  taskId: string,
  userId: string,
): Promise<void> {
  await assertOwnedExists(ctx, taskId);
  const db = getDb();
  await db
    .delete(taskShares)
    .where(and(eq(taskShares.taskId, taskId), eq(taskShares.userId, userId)));
}

/**
 * Returns who can see this task: direct shares (revocable) and inherited
 * shares (from ancestors — read-only here, the ancestor's owner controls them).
 * Direct shares come first.
 */
export async function listTaskShares(
  ctx: Context,
  taskId: string,
): Promise<{ direct: ShareEntry[]; inherited: ShareEntry[] }> {
  // Anyone with access to the task can see who else has access. The owner
  // sees direct + inherited; collaborators see the same so they understand
  // the audience.
  const db = getDb();
  const ancestorPath = await db.all<{ id: string; title: string; ord: number }>(sql`
    WITH RECURSIVE chain(id, title, parent_id, ord) AS (
      SELECT id, title, parent_id, 0 FROM tasks WHERE id = ${taskId}
      UNION ALL
      SELECT t.id, t.title, t.parent_id, c.ord + 1
        FROM tasks t JOIN chain c ON t.id = c.parent_id
    )
    SELECT id, title, ord FROM chain ORDER BY ord ASC
  `);
  if (ancestorPath.length === 0) return { direct: [], inherited: [] };

  const ancestorIds = ancestorPath.map((r) => r.id);
  const titleById = new Map(ancestorPath.map((r) => [r.id, r.title]));

  const allShares = await db
    .select()
    .from(taskShares)
    .where(inArray(taskShares.taskId, ancestorIds));

  if (allShares.length === 0) return { direct: [], inherited: [] };

  const userIds = Array.from(new Set(allShares.map((s) => s.userId)));
  const userRows = await db.select().from(users).where(inArray(users.id, userIds));
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const direct: ShareEntry[] = [];
  const inherited: ShareEntry[] = [];
  for (const s of allShares) {
    const user = userById.get(s.userId);
    if (!user) continue;
    if (s.taskId === taskId) {
      direct.push({ taskId: s.taskId, user, createdAt: s.createdAt });
    } else {
      inherited.push({
        taskId: s.taskId,
        user,
        createdAt: s.createdAt,
        via: { id: s.taskId, title: titleById.get(s.taskId) ?? '' },
      });
    }
  }
  return { direct, inherited };
}

/**
 * Share `taskId` with a known users.id. Owner-only. Idempotent — no error
 * if the share already exists.
 */
export async function shareTaskWithUserId(
  ctx: Context,
  taskId: string,
  recipientId: string,
): Promise<ShareEntry> {
  await assertOwnedExists(ctx, taskId);
  if (recipientId === ctx.userId) {
    throw new Error("You can't share a task with yourself.");
  }
  const db = getDb();
  const found = await db.select().from(users).where(eq(users.id, recipientId));
  const recipient = found[0];
  if (!recipient) throw new Error('User not found.');

  const existing = await db
    .select()
    .from(taskShares)
    .where(and(eq(taskShares.taskId, taskId), eq(taskShares.userId, recipient.id)));
  if (existing[0]) {
    return { taskId, user: recipient, createdAt: existing[0].createdAt };
  }
  const row: TaskShare = { taskId, userId: recipient.id, createdAt: Date.now() };
  await db.insert(taskShares).values(row);
  return { taskId, user: recipient, createdAt: row.createdAt };
}

/**
 * List every user except the caller, ordered by name/email. Used by the
 * Share dialog as the source for its "pick someone" list.
 */
export async function listShareableUsers(ctx: Context): Promise<User[]> {
  const db = getDb();
  return db
    .select()
    .from(users)
    .where(ne(users.id, ctx.userId))
    .orderBy(asc(users.name), asc(users.email));
}

/**
 * Cheap check: does `userId` directly own `taskId`? Used by the focus page
 * to decide whether to render the Share button.
 */
export async function isOwner(ctx: Context, taskId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, ctx.userId)));
  return rows.length > 0;
}
