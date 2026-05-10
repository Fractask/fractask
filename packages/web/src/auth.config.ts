import type { NextAuthConfig } from 'next-auth';

/**
 * Edge-safe Auth.js config. No DB imports allowed here — this gets pulled
 * into `middleware.ts`, which runs on the Edge runtime where node:fs and
 * @libsql/client are unavailable. The full config (providers + DB callbacks)
 * extends this in `auth.ts`.
 */
export const authConfig = {
  trustHost: true,
  pages: { signIn: '/auth/signin' },
  session: { strategy: 'jwt' },
  callbacks: {
    // Pure JWT-token → session mapping. Lives here (not in auth.ts) so the
    // middleware's NextAuth instance can map token.userId → session.user.userId
    // without needing DB access.
    async session({ session, token }) {
      if (token.userId) {
        session.user.userId = token.userId;
      }
      return session;
    },
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      if (pathname.startsWith('/auth') || pathname.startsWith('/api/auth')) {
        return true;
      }
      return !!auth?.user?.userId;
    },
  },
  // Providers are added in the Node-runtime config; middleware never needs
  // to actually run them (it only reads the JWT cookie).
  providers: [],
} satisfies NextAuthConfig;
