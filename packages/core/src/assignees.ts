import { asc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { tasks, users, type User } from './schema.js';
import {
  createAssigneeInputSchema,
  updateAssigneeInputSchema,
  type CreateAssigneeInput,
  type UpdateAssigneeInput,
} from './types.js';

/**
 * Compatibility shim over the `users` table.
 *
 * The dedicated `assignees` table was dropped in 0010. Callers retain the
 * `Assignee` shape and CRUD function names because this module is referenced
 * from too many places (web routes, MCP docs, etc.) to rename in one go.
 * `kind: 'person' | 'agent'` is mapped onto the user's `kind: 'human' |
 * 'agent' | 'guest'` — `human` and `guest` both surface as `person` here.
 *
 * Color is no longer stored: assignees were per-user labels, but users are
 * global, and a personal-color preference per user belongs in a different
 * surface (not implemented yet).
 */

export class AssigneeNotFoundError extends Error {
  constructor(id: string) {
    super(`Assignee ${id} not found`);
    this.name = 'AssigneeNotFoundError';
  }
}

export type AssigneeKind = 'person' | 'agent';

export type Assignee = {
  id: string;
  userId: string;
  name: string;
  kind: AssigneeKind;
  color: string | null;
  createdAt: number;
};

function userToAssignee(u: User): Assignee {
  return {
    id: u.id,
    userId: u.id,
    name: u.name ?? u.email ?? '(unnamed)',
    kind: u.kind === 'agent' ? 'agent' : 'person',
    color: null,
    createdAt: u.createdAt,
  };
}

function now(): number {
  return Date.now();
}

/**
 * Returns every user in the system as an Assignee. Multi-user means everyone
 * sees the same picker list — that's intentional for the current trust model
 * (small invited group). A future "people I work with" filter can replace
 * this.
 */
export async function listAssignees(_ctx: Context): Promise<Assignee[]> {
  const db = getDb();
  const rows = await db.select().from(users).orderBy(asc(users.name));
  return rows.map(userToAssignee);
}

/**
 * Returns the current user as an Assignee — `id === ctx.userId`. Pre-merge
 * this minted a separate `me:<userId>` assignee row; that synthetic row is
 * gone, the user row is the canonical self-reference now.
 */
export async function ensureSelfAssignee(ctx: Context): Promise<Assignee> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, ctx.userId));
  const me = rows[0];
  if (!me) throw new Error(`User ${ctx.userId} not found`);
  return userToAssignee(me);
}

export async function getAssignee(_ctx: Context, id: string): Promise<Assignee | null> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, id));
  return rows[0] ? userToAssignee(rows[0]) : null;
}

export async function createAssignee(
  ctx: Context,
  input: CreateAssigneeInput,
): Promise<Assignee> {
  const parsed = createAssigneeInputSchema.parse(input);
  const db = getDb();
  // 'person' creates a guest user (no signin). To create a 'human' (signin)
  // user, use /settings/users.
  const userKind: User['kind'] = parsed.kind === 'agent' ? 'agent' : 'guest';
  const row: User = {
    id: nanoid(12),
    email: null,
    name: parsed.name,
    googleId: null,
    image: null,
    kind: userKind,
    endpoint: null,
    createdAt: now(),
  };
  await db.insert(users).values(row);
  return userToAssignee(row);
}

export async function updateAssignee(
  ctx: Context,
  id: string,
  patch: UpdateAssigneeInput,
): Promise<Assignee> {
  const parsed = updateAssigneeInputSchema.parse(patch);
  const db = getDb();
  const existing = await getAssignee(ctx, id);
  if (!existing) throw new AssigneeNotFoundError(id);

  const update: Partial<User> = {};
  if (parsed.name !== undefined) update.name = parsed.name;
  if (parsed.kind !== undefined) {
    // Don't downgrade a real signed-in human to guest via this surface — that
    // would break their session. Update via /settings/users instead.
    const existingUserRows = await db.select().from(users).where(eq(users.id, id));
    const existingKind = existingUserRows[0]?.kind;
    if (existingKind !== 'human') {
      update.kind = parsed.kind === 'agent' ? 'agent' : 'guest';
    }
  }

  if (Object.keys(update).length > 0) {
    await db.update(users).set(update).where(eq(users.id, id));
  }
  const refreshed = await getAssignee(ctx, id);
  return refreshed!;
}

/**
 * Delete a guest or agent user, unassigning them from all tasks first.
 * Refuses to delete `human` (signed-in) users — those go through
 * /settings/users to keep the auth lifecycle clean.
 */
export async function deleteAssignee(_ctx: Context, id: string): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, id));
  const u = rows[0];
  if (!u) throw new AssigneeNotFoundError(id);
  if (u.kind === 'human') {
    throw new Error('Cannot delete a signed-in user from /assignees — use /settings/users.');
  }
  const ts = now();
  await db.update(tasks).set({ assigneeId: null, updatedAt: ts }).where(eq(tasks.assigneeId, id));
  await db.update(tasks).set({ reviewerId: null, updatedAt: ts }).where(eq(tasks.reviewerId, id));
  await db.delete(users).where(eq(users.id, id));
}
