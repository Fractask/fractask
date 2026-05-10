import { getCurrentContext, runMigrations, type Context } from '@getshit/core';

let bootstrapped: Promise<Context> | null = null;

export function bootstrap(): Promise<Context> {
  bootstrapped ??= (async () => {
    await runMigrations();
    return getCurrentContext();
  })();
  return bootstrapped;
}
