import { createContext, type ReactNode, useContext } from 'react';

import type { LifecycleRecheckOutcome } from './useLifecycleRecheck';

export type GuestEventRefresh = () => Promise<LifecycleRecheckOutcome>;

const GuestEventRefreshContext = createContext<GuestEventRefresh | null>(null);

export function GuestEventRefreshProvider({
  refreshEvent,
  children,
}: {
  refreshEvent: GuestEventRefresh;
  children: ReactNode;
}) {
  return <GuestEventRefreshContext.Provider value={refreshEvent}>
    {children}
  </GuestEventRefreshContext.Provider>;
}

/** Returns null for isolated component previews that have no event owner. */
export function useGuestEventRefresh(): GuestEventRefresh | null {
  return useContext(GuestEventRefreshContext);
}
