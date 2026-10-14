import type { CallChanged, CallModule, CallReceipt, CallRecord } from '../call-log';
import { isCallId } from './decode';
import { isCallModule } from './modules';

export type CallObservationEvent = CallChanged | 'resync' | 'disconnected';
export type SubscribeCalls = (listener: (event: CallObservationEvent) => void) => () => void;
export interface WaitForCallOptions<M extends CallModule> {
  signal?: AbortSignal;
  /** Maximum observation silence; only a newer persisted revision renews it. Null disables the limit. */
  timeoutMs?: number | null;
  onUpdate?: (call: CallRecord<M>) => void | Promise<void>;
}

const terminalStatuses = new Set(['succeeded', 'failed', 'rejected', 'unknown']);
const DEFAULT_OBSERVATION_TIMEOUT_MS = 5 * 60_000;

/** Abort stops observation only; it never settles or cancels the owner operation. */
export function waitForCallRecord<M extends CallModule>(
  receipt: CallReceipt,
  module: M,
  read: (callId: string) => Promise<CallRecord>,
  options: WaitForCallOptions<M> | undefined,
  subscribe: SubscribeCalls,
): Promise<CallRecord<M>> {
  if (!isCallId(receipt.callId) || receipt.accepted !== true || !isCallModule(module)) {
    return Promise.reject(new Error('Invalid call receipt or module'));
  }
  const timeoutMs = options?.timeoutMs === undefined ? DEFAULT_OBSERVATION_TIMEOUT_MS : options.timeoutMs;
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
    return Promise.reject(new Error('Invalid call observation timeout'));
  }
  const signal = options?.signal;
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Call waiting was stopped', 'AbortError'));

  return new Promise((resolve, reject) => {
    let stopped = false;
    let reading = false;
    let readRequested = false;
    let revision = 0;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof setTimeout> | undefined;

    function renewObservation(): void {
      if (timeoutMs === null) return;
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        fail(new Error('Call observation timed out; the operation outcome is unconfirmed'));
      }, timeoutMs);
    }
    function cleanup(): void {
      stopped = true;
      clearTimeout(timeout);
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
        if (call.revision <= revision) return;
        revision = call.revision;
        renewObservation();
        await options?.onUpdate?.(call as CallRecord<M>);
        if (stopped) return;
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

    renewObservation();
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
