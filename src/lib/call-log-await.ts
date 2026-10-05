import type { CallModule, CallReceipt, CallRecord } from '@/types/call-log';
import { decodeCallChanged } from '@/types/call-log/decode';
import { waitForCallRecord, type WaitForCallOptions } from '@/types/call-log/wait';
import { getCall } from './call-log';
import { hostApiFetch } from './host-api';
import { subscribeBrowserRecovery, subscribeHostEvent } from './host-events';

export function waitForCall<M extends CallModule>(
  receipt: CallReceipt,
  module: M,
  options?: WaitForCallOptions<M>,
): Promise<CallRecord<M>> {
  let firstRead = true;
  return waitForCallRecord(receipt, module, async (callId) => {
    const call = await getCall(callId, options?.signal);
    if (firstRead) {
      firstRead = false;
      // A disconnect before subscription can leave HTTP reads available without change hints.
      if (!['succeeded', 'failed', 'rejected', 'unknown'].includes(call.status)) {
        await hostApiFetch('/api/runtime-host/status', { signal: options?.signal });
      }
    }
    return call;
  }, options, (listener) => {
    const subscriptions: Array<() => void> = [];
    const cleanup = () => { for (const unsubscribe of subscriptions) unsubscribe(); };
    const resync = () => listener('resync');
    try {
      subscriptions.push(subscribeHostEvent('call:changed', (payload) => {
        let change;
        try { change = decodeCallChanged(payload); } catch { return; }
        listener(change);
      }));
      subscriptions.push(subscribeHostEvent('calls:resync', resync));
      subscriptions.push(subscribeHostEvent('runtime-host:restart', resync));
      subscriptions.push(subscribeHostEvent('runtime-host:disconnected', () => listener('disconnected')));
      subscriptions.push(subscribeBrowserRecovery(resync));
    } catch (error) {
      cleanup();
      throw error;
    }
    return cleanup;
  });
}
