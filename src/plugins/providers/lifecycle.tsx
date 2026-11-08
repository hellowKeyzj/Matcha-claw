import { useEffect } from 'react';
import type { ApplicationLifecycleProps } from '@/app/extensions';
import { isTraceEnabled, startupTrace } from '@/lib/trace-logger';
import { subscribeHostEvent } from '@/lib/host-events';
import { refreshProviderPostMutationProjections } from './stores/provider-post-mutation-refresh';
import { useProviderStore } from './stores/providers';
import { useCapabilityRoutingStore } from './stores/capability-routing';
import { ProviderRecoveryDialog } from './components/ProviderRecoveryDialog';

export function ProvidersLifecycle({ hostReady, contentVisible }: ApplicationLifecycleProps) {
  const initProviders = useProviderStore((state) => state.init);

  useEffect(() => {
    if (!hostReady) return;
    return subscribeHostEvent('providers:changed', () => {
      void refreshProviderPostMutationProjections().catch(() => undefined);
    });
  }, [hostReady]);

  useEffect(() => {
    if (!hostReady) return;
    const routing = useCapabilityRoutingStore.getState();
    if (!routing.ready && !routing.loading) void routing.refresh();
    if (!isTraceEnabled()) {
      void initProviders();
      return;
    }
    const startedAt = performance.now();
    startupTrace('renderer.app', 'providers.init.start');
    void initProviders().finally(() => startupTrace('renderer.app', 'providers.init.end', () => ({
      durationMs: Math.round(performance.now() - startedAt),
      snapshotReady: useProviderStore.getState().snapshotReady,
      outcome: useProviderStore.getState().error ? 'error' : 'settled',
    })));
    return () => startupTrace('renderer.app', 'providers.init.cleanup');
  }, [hostReady, initProviders]);

  return <ProviderRecoveryDialog queryEnabled={hostReady} visible={contentVisible} />;
}
