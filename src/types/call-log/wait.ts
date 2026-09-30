import type { CallChanged, CallModule, CallReceipt, CallRecord } from '../call-log';
import { isCallId } from './decode';
import { isCallModule } from './modules';

export type CallObservationEvent = CallChanged | 'resync' | 'disconnected';
export type SubscribeCalls = (listener: (event: CallObservationEvent) => void) => () => void;

const terminalStatuses = new Set(['succeeded', 'failed', 'rejected', 'unknown']);

/** Abort stops observation only; it never settles or cancels the owner operation. */
export function waitForCallRecord<M extends CallModule>(
  receipt: CallReceipt,
  module: M,
  read: (callId: string) => Promise<CallRecord>,
  options: { signal?: AbortSignal } | undefined,
  subscribe: SubscribeCalls,
): Promise<CallRecord<M>> {
  if (!isCallId(receipt.callId) || receipt.accepted !== true || !isCallModule(module)) {
    return Promise.reject(new Error('Invalid call receipt or module'));
  }
  const signal = options?.signal;
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Call waiting was stopped', 'AbortError'));

  return new Promise((resolve, reject) => {
    let stopped = false;
    let reading = false;
    let readRequested = false;
    let revision = 0;
    let unsubscribe = () => {};

    function cleanup(): void {
      stopped = true;
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }
    function fail(error: unknown): void {
      if (stopped) return;
      cleanup();
      reject(error);
    }
    function onAbort(): void {
      fail(signal?.reason ?? new DOMException('Call waiting was stopped', 'AbortError'));
    }
    async function query(): Promise<void> {
      if (stopped) return;
      if (reading) {
        readRequested = true;
        return;
      }
      reading = true;
      readRequested = false;
      try {
        const call = await read(receipt.callId);
        if (stopped) return;
        if (call.callId !== receipt.callId || call.module !== module) {
          throw new Error('Call record does not match the requested call identity and module');
        }
        revision = Math.max(revision, call.revision);
        if (terminalStatuses.has(call.status)) {
          cleanup();
          resolve(call as CallRecord<M>);
        }
      } catch (error) {
        fail(error);
      } finally {
        reading = false;
        if (readRequested && !stopped) void query();
      }
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      unsubscribe = subscribe((event) => {
        if (event === 'disconnected') {
          fail(new Error('Call observation was interrupted; the operation outcome is unconfirmed'));
        } else if (event === 'resync' || (event.callId === receipt.callId && event.revision > revision)) {
          void query();
        }
      });
    } catch (error) {
      fail(error);
      return;
    }
    if (stopped) {
      unsubscribe();
      return;
    }
    void query();
  });
}
