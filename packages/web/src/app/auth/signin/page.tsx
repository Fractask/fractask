import { isDevCredentialsEnabled, isGoogleConfigured } from '@/auth';
import { Logo } from '@/components/logo';
import { credentialsSignInAction, googleSignInAction } from './actions';

type SearchParams = Promise<{ error?: string; callbackUrl?: string }>;

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const { error, callbackUrl } = await searchParams;
  const message =
    error === 'invalid'
      ? 'Wrong username or password.'
      : error === 'OAuthSignin' || error === 'Configuration'
        ? 'Google sign-in is not configured.'
        : null;
  const next = callbackUrl ?? '/';
  const devEnabled = isDevCredentialsEnabled();
  const googleConfigured = isGoogleConfigured();

  return (
    <div className="min-h-screen flex items-center justify-center bg-(--color-bg) text-(--color-fg) px-6">
      <div className="w-full max-w-sm flex flex-col gap-4 border border-(--color-border) rounded-lg p-6 bg-(--color-bg)">
        <Logo size={28} variant="full" className="text-base" />

        {googleConfigured && (
          <form action={googleSignInAction} className="flex flex-col gap-2">
            <input type="hidden" name="callbackUrl" value={next} />
            <button
              type="submit"
              className="w-full bg-(--color-fg) text-(--color-bg) rounded px-3 py-2 text-sm font-medium hover:opacity-90"
            >
              Continue with Google
            </button>
          </form>
        )}

        {devEnabled && googleConfigured && (
          <div className="flex items-center gap-2 text-xs text-(--color-muted)">
            <span className="flex-1 h-px bg-(--color-border)" />
            <span>or</span>
            <span className="flex-1 h-px bg-(--color-border)" />
          </div>
        )}

        {devEnabled && (
          <form action={credentialsSignInAction} className="flex flex-col gap-3">
            <input type="hidden" name="callbackUrl" value={next} />
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-(--color-muted)">Username</span>
              <input
                type="text"
                name="username"
                autoComplete="username"
                className="bg-transparent border border-(--color-border) rounded px-3 py-2 outline-none focus:border-(--color-fg) text-(--color-fg)"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-(--color-muted)">Password</span>
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                className="bg-transparent border border-(--color-border) rounded px-3 py-2 outline-none focus:border-(--color-fg) text-(--color-fg)"
              />
            </label>
            <button
              type="submit"
              className="w-full border border-(--color-border) rounded px-3 py-2 text-sm font-medium text-(--color-fg) hover:bg-(--color-border)/40"
            >
              Sign in with credentials
            </button>
          </form>
        )}

        {!devEnabled && !googleConfigured && (
          <div className="text-sm text-red-500">
            No auth providers configured. Set AUTH_GOOGLE_ID/SECRET or AUTH_DEV_USERNAME/PASSWORD/USER_ID in the environment.
          </div>
        )}

        {message && <div className="text-sm text-red-500">{message}</div>}
      </div>
    </div>
  );
}
