import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { ExtensionPoint, PluginHost } from './core';

const PluginHostContext = createContext<PluginHost | null>(null);

export function PluginHostProvider({ host, children }: { host: PluginHost; children: ReactNode }) {
  return <PluginHostContext.Provider value={host}>{children}</PluginHostContext.Provider>;
}

export function usePluginHost(): PluginHost {
  const host = useContext(PluginHostContext);
  if (!host) throw new Error('Application plugin host is not mounted');
  return host;
}

export function useContributions<T>(point: ExtensionPoint<T>): readonly T[] {
  const host = usePluginHost();
  const subscribe = useCallback((listener: () => void) => host.subscribe(point, listener), [host, point]);
  const getSnapshot = useCallback(() => host.get(point), [host, point]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
