import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { cliTokens, users, type CliToken, type User } from './schema.js';

/** Thrown when a non-admin attempts an admin-only action. */
export class AdminRequiredError extends Error {
  constructor(message = 'This action requires a workspace admin.') {
    super(message);
    this.name = 'AdminRequiredError';
  }
}

/** True when the user is a workspace admin (users.is_admin). */
export async function isAdmin(userId: string): Promise<boolean> {
  const u = await findUserById(userId);
  return u?.isAdmin === true;
}

/** Throw AdminRequiredError unless the caller is a workspace admin. */
export async function assertAdmin(ctx: Context): Promise<void> {
  if (!(await isAdmin(ctx.userId))) throw new AdminRequiredError();
}

/**
 * Set (or clear) a user's admin flag. Unchecked — used to bootstrap the first
 * admin, where by definition no admin exists to authorise the call.
 *
 * Everything that is NOT bootstrap should go through `setWorkspaceAdmin`,
 * which gates on the caller and refuses to strip the last admin. This one is
 * deliberately left un-gated and deliberately has no product surface.
 */
export async function setUserAdmin(userId: string, admin: boolean): Promise<void> {
  const db = getDb();
  await db.update(users).set({ isAdmin: admin }).where(eq(users.id, userId));
}

/** Thrown when a change would leave the workspace with no admin at all. */
export class LastAdminError extends Error {
  constructor(message = 'Cannot remove the last workspace admin.') {
    super(message);
    this.name = 'LastAdminError';
  }
}

/** Every workspace admin, oldest first. */
export async function listAdmins(): Promise<User[]> {
  const db = getDb();
  return db.select().from(users).where(eq(users.isAdmin, true));
}

/**
 * Grant or revoke workspace admin, as an admin.
 *
 * This is the *only* checked path to `users.is_admin`, and it exists because
 * the flag previously had none: `setUserAdmin` was exported but called from no
 * production code, so the only way to grant admin was a hand-written UPDATE
 * against the database. A decision the human makes ("make X an admin") needs a
 * surface that can perform it, audit it, and reverse it.
 *
 * Two guards:
 *  - the caller must already be an admin (`AdminRequiredError`);
 *  - the last admin cannot be demoted (`LastAdminError`) — otherwise a single
 *    click locks every admin surface, including this one, permanently.
 *
 * Idempotent: setting the flag to its current value is a no-op that still
 * reports the resulting state.
 */
export async function setWorkspaceAdmin(
  ctx: Context,
  targetUserId: string,
  admin: boolean,
): Promise<{ id: string; name: string | null; isAdmin: boolean }> {
  await assertAdmin(ctx);

  const target = await findUserById(targetUserId);
  if (!target) throw new Error(`No such user: ${targetUserId}`);

  if (target.isAdmin === admin) {
    return { id: target.id, name: target.name, isAdmin: admin };
  }

  if (!admin) {
    const admins = await listAdmins();
    if (admins.length <= 1) throw new LastAdminError();
  }

  await setUserAdmin(targetUserId, admin);
  return { id: target.id, name: target.name, isAdmin: admin };
}

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
    isAdmin: false,
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
  // Agents are reachable by their minted CLI token, so they need neither an
  // email nor an endpoint. Humans/guests must have one so the row is reachable
  // (email → sign-in match; endpoint → chat).
  if (input.kind !== 'agent' && !email && !endpoint) {
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
    isAdmin: false,
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

/**
 * Mint a token on behalf of an *agent* user. Guards against minting bearer
 * tokens for humans or guests — a human authenticates via their own login, and
 * an agent token is meant to be handed to an automated MCP/CLI client scoped to
 * whatever that agent has been shared. The caller (any workspace member) is
 * trusted to manage agents; the kind check is the safety rail.
 */
export async function createAgentCliToken(
  agentUserId: string,
  label: string | null,
): Promise<{ token: string; row: CliToken }> {
  const target = await findUserById(agentUserId);
  if (!target) throw new Error('Agent not found.');
  if (target.kind !== 'agent') {
    throw new Error('CLI tokens can only be minted for agent users.');
  }
  return createCliToken(agentUserId, label);
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

/**
 * Is this call an AGENT call? Two independent ways to be one, and the guards in
 * this package have historically only asked the first:
 *
 *   1. the ACCOUNT is an agent          `users.kind === 'agent'`
 *   2. the CHANNEL is the agent surface `ctx.viaAgentTool` — the call came in
 *                                        through /api/mcp, which stamps every
 *                                        comment it writes `source: 'agent'`
 *
 * Asking only (1) makes every agent-facing rule blind to an agent running on a
 * human's CLI token — which is not hypothetical. Measured 2026-09-09 on the
 * live workspace DB: the Mac lane of `website-builder` posts through /api/mcp
 * as `zDNBp6zwzoa7` (Joel, `kind='human'`), `source='agent'`, most recently at
 * 2026-09-09T11:44:58Z. Under (1) alone the review guard, the deck requirement
 * and the addressing reroute all silently exempt that lane.
 *
 * Deliberately an OR, not an AND: it can only widen a guard. The web UI and
 * server actions never set `viaAgentTool`, so a real human at a browser is
 * unaffected, and an agent account is still an agent on any channel.
 */
export function isAgentCall(ctx: Context, caller: User | null | undefined): boolean {
  return ctx.viaAgentTool === true || caller?.kind === 'agent';
}
