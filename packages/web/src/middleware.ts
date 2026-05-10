import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

// Edge-runtime entry. Uses only the edge-safe config — no DB imports —
// so this never tries to pull in @libsql/client or node:fs.
export const { auth: middleware } = NextAuth(authConfig);

export default middleware;

export const config = {
  // Excludes /api/mcp — that route auths via Bearer token (cli_tokens), not
  // the session cookie, so the Auth.js redirect would break MCP clients.
  matcher: ['/((?!api/mcp|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)'],
};
