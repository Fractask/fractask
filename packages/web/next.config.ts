import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Pin the workspace root so Next stops walking up the filesystem
  // looking for a parent lockfile.
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  // @libsql/client uses dynamic require for native bindings; mark it external
  // so Turbopack/webpack don't try to bundle it.
  serverExternalPackages: ['@libsql/client', 'libsql'],
  eslint: {
    // ESLint plugin isn't wired up (no eslint-config-next, no eslint.config.*).
    // tsc --noEmit handles type safety. Re-enable when a real config is added.
    ignoreDuringBuilds: true,
  },
};

export default config;
