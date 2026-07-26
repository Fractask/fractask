import { cookies } from 'next/headers';
import { findUserById } from '@getshit/core';
import { VIEW_AS_COOKIE } from './view-as-constants';

export { VIEW_AS_COOKIE };

export type ViewAsTarget = { agentId: string; agentName: string };

/** Raw, unvalidated cookie value (an agent id) or null. */
export async function readViewAsCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(VIEW_AS_COOKIE)?.value ?? null;
}

/**
 * Validate the view-as cookie against the DB. Returns the target only when the
 * cookie points at a real `kind:'agent'` user that isn't the caller themselves.
 * Stale or forged cookies (the cookie is httpOnly, but defence-in-depth) resolve
 * to null, so an impersonation can never widen access beyond an actual agent.
 */
export async function resolveViewAs(realUserId: string): Promise<ViewAsTarget | null> {
  const raw = await readViewAsCookie();
  if (!raw || raw === realUserId) return null;
  const target = await findUserById(raw);
  if (!target || target.kind !== 'agent') return null;
  return { agentId: target.id, agentName: target.name?.trim() || target.email || 'agent' };
}
