import { NextResponse } from 'next/server';
import { findUserById } from '@getshit/core';
import { getRealContext } from '@/lib/auth';
import { VIEW_AS_COOKIE } from '@/lib/view-as';

export const dynamic = 'force-dynamic';

/**
 * Enter "View as agent" preview. GET (so the write-block in middleware never
 * catches it). Only a signed-in human may impersonate, and only a real
 * `kind:'agent'` user may be the target — a human never previews as another human.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const ctx = await getRealContext();
  const me = await findUserById(ctx.userId);
  if (!me || me.kind !== 'human') {
    return NextResponse.redirect(new URL('/', req.url));
  }

  const { agentId } = await params;
  const target = await findUserById(agentId);
  if (!target || target.kind !== 'agent') {
    return NextResponse.redirect(new URL('/settings/users', req.url));
  }

  const res = NextResponse.redirect(new URL('/', req.url));
  res.cookies.set(VIEW_AS_COOKIE, agentId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8, // 8h — a preview session, not a durable login
  });
  return res;
}
