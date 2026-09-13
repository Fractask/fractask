import { AmbiguousIdError, CycleError } from './tasks.js';
import { ForbiddenError, NotFoundError, NotSharedError } from './access.js';

/**
 * The one place an error class becomes a wire prefix.
 *
 * This lived as two hand-copied functions — `errorText` in
 * `packages/mcp/src/index.ts` and again in
 * `packages/web/src/app/api/mcp/route.ts`. Two copies of a dispatch table is
 * how a class gets added to the codebase and mapped by neither: every core
 * test can prove the right error is THROWN and still say nothing about what
 * the caller reads. `ForbiddenError` was in that state — introduced by this
 * very card's fixes to `delete_comment` and `deleteScratchEntry`, mapped
 * nowhere, so "you may not do this" reached agents as `error:`, the same
 * prefix as a database outage.
 *
 * The copies had also drifted: only the stdio one unwrapped `cause`.
 */

// Driver errors arrive wrapped: drizzle's DrizzleQueryError stringifies the
// whole failed SQL statement as its message and hangs the useful part off
// `cause` (e.g. "BLOCKED: ... do you need to upgrade your plan?"). Reporting
// only the outer message buries the one line that says what to actually do.
export function rootCause(err: Error): string {
  let current: Error = err;
  const seen = new Set<Error>([err]);
  while (current.cause instanceof Error && !seen.has(current.cause)) {
    current = current.cause;
    seen.add(current);
  }
  return current.message;
}

export function mcpErrorText(err: unknown): string {
  // NotSharedError extends NotFoundError, so it MUST be tested first — the
  // whole point is that "not shared" stops being reported as "not found".
  if (err instanceof NotSharedError) return `not_shared: ${err.message}`;
  if (err instanceof NotFoundError) return `not_found: ${err.message}`;
  // "The row is reachable, you are not allowed to do this to it" is a third
  // answer, distinct from both. Without this branch it fell through to the
  // catch-all and was indistinguishable from an internal failure.
  if (err instanceof ForbiddenError) return `forbidden: ${err.message}`;
  if (err instanceof AmbiguousIdError) return `ambiguous_id: ${err.message}`;
  if (err instanceof CycleError) return `cycle: ${err.message}`;
  if (err instanceof Error) return `error: ${rootCause(err)}`;
  return 'error: unknown failure';
}
