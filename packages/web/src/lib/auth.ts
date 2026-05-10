import { runMigrations, type Context } from '@getshit/core';
import { auth } from '@/auth';

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
 */
export async function getRequestContext(): Promise<Context> {
  await ensureReady();
  const session = await auth();
  const userId = session?.user?.userId;
  if (!userId) throw new UnauthenticatedError();
  return { userId };
}
