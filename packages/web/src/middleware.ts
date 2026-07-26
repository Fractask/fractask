import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from './auth.config';
import { VIEW_AS_COOKIE } from './lib/view-as-constants';

// Edge-runtime entry. Uses only the edge-safe config — no DB imports —
// so this never tries to pull in @libsql/client or node:fs.
const { auth } = NextAuth(authConfig);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export default auth((req) => {
  const { pathname, search, origin } = req.nextUrl;

  // Auth gate — mirrors authConfig.authorized, made explicit here so it holds
  // regardless of whether the callback form auto-applies that callback. Auth
  // routes are always open; everything else needs a stamped userId.
  const isAuthRoute = pathname.startsWith('/auth') || pathname.startsWith('/api/auth');
  if (!isAuthRoute && !req.auth?.user?.userId) {
    const url = new URL('/auth/signin', origin);
    url.searchParams.set('callbackUrl', pathname + search);
    return NextResponse.redirect(url);
  }

  // Read-only preview: while an admin is "View as agent" (cookie set), block
  // every mutation so the preview can never act as the impersonated agent.
  // Auth routes stay open (so sign-out / OAuth POSTs work while previewing);
  // entering/exiting are GETs under /api/view-as, so they pass through too.
  const viewing = req.cookies.get(VIEW_AS_COOKIE)?.value;
  if (viewing && !isAuthRoute && !SAFE_METHODS.has(req.method.toUpperCase())) {
    return NextResponse.json(
      { error: 'Read-only preview — exit “View as agent” to make changes.' },
      { status: 403 },
    );
  }

  return undefined;
});

export const config = {
  // Excludes /api/mcp and /api/files — both auth via Bearer token (cli_tokens)
  // in addition to the session cookie, and do their own auth in-route. Letting
  // the Auth.js cookie redirect run here would 302 token-only agent requests
  // (which carry no session cookie) to the sign-in page instead of serving the
  // file. Both routes still reject unauthenticated callers with a 401.
  matcher: ['/((?!api/mcp|api/files|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)'],
};
