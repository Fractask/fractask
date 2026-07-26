import { runMigrations, type Context } from '@getshit/core';
import { auth } from '@/auth';
import { resolveViewAs, type ViewAsTarget } from './view-as';

let ready: Promise<void> | null = null;

// On Vercel the migrations folder isn't bundled into serverless functions and
// the schema is already up-to-date (we run `pnpm db:migrate` from local). Skip
// in any hosted env; only run during local dev.
const SKIP_MIGRATIONS = !!process.env.VERCEL || !!process.env.GETSHIT_USER_ID;

function ensureReady(): Promise<void> {
  if (SKIP_MIGRATIONS) return Promise.resolve();
  ready ??= runMigrations();
  return ready;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('Unauthenticated');
    this.name = 'UnauthenticatedError';
  }
}

/**
 * Reads the Auth.js session and returns a Context for the signed-in user.
 * Throws UnauthenticatedError if no session — middleware should be redirecting
 * unauthenticated requests, so this only fires for direct API hits without a cookie.
 *
 * When an admin is in "View as agent" preview (a validated `gs_view_as` cookie),
 * the effective userId is the agent's, so every read scopes to exactly what that
 * agent can see. Writes are blocked by middleware while the cookie is set, so this
 * substitution never turns into acting *as* the agent.
 */
export async function getRequestContext(): Promise<Context> {
  await ensureReady();
  const session = await auth();
  const userId = session?.user?.userId;
  if (!userId) throw new UnauthenticatedError();
  const viewAs = await resolveViewAs(userId);
  return { userId: viewAs ? viewAs.agentId : userId };
}

/**
 * The real signed-in user, ignoring any "View as agent" preview. Use for the
 * control paths that must run as the human (entering/exiting preview, admin
 * checks) rather than as the impersonated agent.
 */
export async function getRealContext(): Promise<Context> {
  await ensureReady();
  const session = await auth();
  const userId = session?.user?.userId;
  if (!userId) throw new UnauthenticatedError();
  return { userId };
}

/**
 * Preview state for the layout banner: the real user plus the agent being
 * previewed (or null when not in preview).
 */
export async function getViewState(): Promise<{
  realUserId: string | null;
  viewingAs: ViewAsTarget | null;
}> {
  const session = await auth();
  const userId = session?.user?.userId ?? null;
  if (!userId) return { realUserId: null, viewingAs: null };
  return { realUserId: userId, viewingAs: await resolveViewAs(userId) };
}
