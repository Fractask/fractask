/**
 * Edge-safe constants for the "View as agent" admin preview. Kept import-free
 * so `middleware.ts` (Edge runtime, no DB / node:fs) can share the cookie name
 * with the Node-runtime helpers in `view-as.ts` without duplication.
 */
export const VIEW_AS_COOKIE = 'gs_view_as';
