import type { HostEventBus } from '../api/event-bus';
import { decodeCallChanged } from '../../src/types/call-log/decode';
import type { SubscribeCalls } from '../../src/types/call-log/wait';
import type { RuntimeHostLifecycle } from './runtime-host-delivery/lifecycle-owner';

export function createCallSubscriber(eventBus: HostEventBus, runtimeHost: Pick<RuntimeHostLifecycle, 'onDisconnect'>): SubscribeCalls {
  return (listener) => {
    const subscriptions = [
      eventBus.on('call:changed', (payload) => {
        let change;
        try { change = decodeCallChanged(payload); } catch { return; }
        listener(change);
      }),
      eventBus.on('calls:resync', () => listener('resync')),
      eventBus.on('runtime-host:restart', () => listener('resync')),
      runtimeHost.onDisconnect(() => listener('disconnected')),
    ];
    return () => { for (const unsubscribe of subscriptions) unsubscribe(); };
  };
}
