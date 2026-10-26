import { subscribeHostEvent } from '@/lib/host-events';
import { decodeGatewayChannelStatusUpdates } from '@/lib/channel-status';
import { useChannelsStore } from './store';

export function subscribeChannelHostEvents(): () => void {
  const unsubscribers: Array<() => void> = [];
  unsubscribers.push(subscribeHostEvent<unknown>(
    'gateway:channel-status',
    (payload) => {
      const updates = decodeGatewayChannelStatusUpdates(payload);
      if (updates.length === 0) return;
      const state = useChannelsStore.getState();
      const endpoint = state.scope?.endpoint;
      if (endpoint?.kind !== 'native-runtime' || endpoint.runtimeAdapterId !== 'openclaw' || endpoint.runtimeInstanceId !== 'local') return;
      for (const update of updates) {
        const channel = state.channels.find((item) => item.type === update.channelId);
        if (channel) {
          state.updateChannel(channel.id, { status: update.status });
        }
      }
    },
  ));
  return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
}
