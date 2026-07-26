'use client';

import { useEffect } from 'react';
import { AlertTriangle, Eye } from 'lucide-react';
import { useReadOnly } from '@/components/read-only-context';

/**
 * App-segment error boundary. Rendered inside the (app) layout, so it can read
 * the ReadOnlyProvider: while in "View as agent" preview, a mutating control
 * that isn't explicitly disabled still gets 403'd server-side, which throws in
 * the Server Action client — catch that here and explain it's read-only rather
 * than showing a raw crash. Outside preview it's a generic recoverable error.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const readOnly = useReadOnly();

  useEffect(() => {
    // Keep it in the console for real (non-preview) failures.
    if (!readOnly) console.error(error);
  }, [error, readOnly]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      {readOnly ? (
        <>
          <Eye className="text-violet-500" size={28} />
          <div>
            <p className="text-sm font-medium">That action is disabled in read-only preview</p>
            <p className="mt-1 text-sm text-(--color-muted)">
              You&rsquo;re viewing Fractask as an agent. Exit the preview to make changes.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => reset()}
              className="rounded border border-(--color-border) px-3 py-1.5 text-sm hover:bg-(--color-surface)"
            >
              Dismiss
            </button>
            <a
              href="/api/view-as/exit"
              className="rounded bg-violet-600 px-3 py-1.5 text-sm text-white hover:bg-violet-700"
            >
              Exit preview
            </a>
          </div>
        </>
      ) : (
        <>
          <AlertTriangle className="text-amber-500" size={28} />
          <div>
            <p className="text-sm font-medium">Something went wrong</p>
            <p className="mt-1 text-sm text-(--color-muted)">
              This view hit an unexpected error.
            </p>
          </div>
          <button
            type="button"
            onClick={() => reset()}
            className="rounded bg-(--color-fg) px-3 py-1.5 text-sm text-(--color-bg) hover:opacity-90"
          >
            Try again
          </button>
        </>
      )}
    </div>
  );
}
