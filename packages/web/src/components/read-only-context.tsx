'use client';

import { createContext, useContext } from 'react';

/**
 * True when the app is being viewed in "View as agent" admin preview. Writes
 * are blocked server-side (middleware 403) regardless; this flag lets the UI
 * disable mutating controls so the admin never triggers a blocked write. Defaults
 * to false so components used outside the (app) layout stay fully interactive.
 */
const ReadOnlyContext = createContext(false);

export function ReadOnlyProvider({
  value,
  children,
}: {
  value: boolean;
  children: React.ReactNode;
}) {
  return <ReadOnlyContext.Provider value={value}>{children}</ReadOnlyContext.Provider>;
}

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}
