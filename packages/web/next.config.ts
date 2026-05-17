import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
  version: string;
};

const config: NextConfig = {
  // Pin the workspace root so Next stops walking up the filesystem
  // looking for a parent lockfile.
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  // @libsql/client uses dynamic require for native bindings; mark it external
  // so Turbopack/webpack don't try to bundle it. The AWS SDKs are loaded by
  // core only when GETSHIT_STORAGE=s3, via `import()` — keep them external
  // so Turbopack doesn't try to inline them during the local-default path.
  serverExternalPackages: [
    '@libsql/client',
    'libsql',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ],
  eslint: {
    // ESLint plugin isn't wired up (no eslint-config-next, no eslint.config.*).
    // tsc --noEmit handles type safety. Re-enable when a real config is added.
    ignoreDuringBuilds: true,
  },
};

export default config;
