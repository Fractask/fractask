import NextAuth, { type DefaultSession } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import type { Provider } from 'next-auth/providers';
import { findUserById, linkOrCreateGoogleUser } from '@getshit/core';
import { authConfig } from './auth.config';

declare module 'next-auth' {
  interface Session {
    user: {
      userId: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId?: string;
  }
}

// Force-load the JWT type so the augmentation above resolves under
// moduleResolution: bundler.
type _JWTHint = JWT;

function devCredentialsConfigured(): boolean {
  return (
    !!process.env.AUTH_DEV_USERNAME &&
    !!process.env.AUTH_DEV_PASSWORD &&
    !!process.env.AUTH_DEV_USER_ID
  );
}

const googleId = process.env.AUTH_GOOGLE_ID;
const googleSecret = process.env.AUTH_GOOGLE_SECRET;

const providers: Provider[] = [
  Credentials({
    name: 'Dev',
    credentials: {
      username: { label: 'Username', type: 'text' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(creds) {
      if (!devCredentialsConfigured()) return null;
      const u = String(creds?.['username'] ?? '');
      const p = String(creds?.['password'] ?? '');
      if (
        u !== process.env.AUTH_DEV_USERNAME ||
        p !== process.env.AUTH_DEV_PASSWORD
      ) {
        return null;
      }
      const userId = process.env.AUTH_DEV_USER_ID!;
      const row = await findUserById(userId);
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        image: row.image,
      };
    },
  }),
];

if (googleId && googleSecret) {
  providers.unshift(
    Google({
      clientId: googleId,
      clientSecret: googleSecret,
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers,
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, account, profile, user }) {
      // Stamp our internal userId onto the JWT exactly once, at sign-in.
      // Subsequent calls (token refresh) keep the stamped userId.
      if (account?.provider === 'google' && profile) {
        const linked = await linkOrCreateGoogleUser({
          sub: String(profile.sub),
          email: profile.email ?? null,
          name: profile.name ?? null,
          picture: (profile as { picture?: string | null }).picture ?? null,
        });
        token.userId = linked.id;
        if (linked.name) token.name = linked.name;
        if (linked.email) token.email = linked.email;
        if (linked.image) token.picture = linked.image;
      } else if (account?.provider === 'credentials' && user?.id) {
        token.userId = user.id;
        if (user.name) token.name = user.name;
        if (user.email) token.email = user.email;
        if (user.image) token.picture = user.image;
      }
      return token;
    },
    // session() lives in auth.config.ts so the middleware can map
    // token.userId → session.user.userId without importing DB code.
  },
});

export function isDevCredentialsEnabled(): boolean {
  return devCredentialsConfigured();
}

export function isGoogleConfigured(): boolean {
  return !!googleId && !!googleSecret;
}
