import type { CallReceipt, CallRecord } from '../../../src/types/call-log';
import { waitForCallRecord, type SubscribeCalls } from '../../../src/types/call-log/wait';
import type { CallLogTransport } from '../runtime-host-delivery/transport/call-log';

export function createProviderCallObserver(transport: CallLogTransport, subscribeCalls: SubscribeCalls) {
  return async (
    receipt: CallReceipt,
    command: 'providerAccounts.replace' | 'providerAccounts.delete' | 'providerModels.replace',
  ): Promise<CallRecord<'provider'>> => {
    const call = await waitForCallRecord(receipt, 'provider', async (callId) => {
      const response = await transport.get({ callId });
      if (response.status !== 200 || !('callId' in response.body)) {
        throw new Error('Provider operation result could not be confirmed');
      }
      return response.body;
    }, undefined, subscribeCalls);
    if (call.command !== command) throw new Error('Provider operation call identity is invalid');
    return call;
  };
}
