import { hostApiFetch } from './host-api';
import { subscribeBrowserRecovery, subscribeHostEvent } from './host-events';
import {
  decodeCloudPackageOperationReceipt, decodeCloudPackageOperationResult,
  type CloudPackageOperationKind, type CloudPackageOperationRequests, type CloudPackageOperationResults,
} from '../types/cloud-package-operation';

const routes: Record<CloudPackageOperationKind, string> = {
  download: '/api/packages/download',
  install: '/api/packages/install',
  uploadSealedAgent: '/api/packages/upload/sealed-agent',
  confirmSealedSkillUpload: '/api/packages/upload/sealed-skill/confirm',
};

/** Stopping observation never cancels or resubmits an admitted package operation. */
export async function runCloudPackageOperation<K extends CloudPackageOperationKind>(
  kind: K, request: CloudPackageOperationRequests[K], options?: { signal?: AbortSignal },
): Promise<CloudPackageOperationResults[K]> {
  const signal = options?.signal;
  const receipt = decodeCloudPackageOperationReceipt(await hostApiFetch<unknown>(routes[kind], {
    method: 'POST', body: JSON.stringify(request), signal,
  }));
  if (signal?.aborted) throw signal.reason ?? new DOMException('Package observation stopped', 'AbortError');
  return new Promise((resolve, reject) => {
    let stopped = false;
    let reading = false;
    let dirty = false;
    const subscriptions: Array<() => void> = [];

    function cleanup(): void {
      stopped = true;
      for (const unsubscribe of subscriptions) unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }
    function fail(error: unknown): void {
      if (stopped) return;
      cleanup();
      reject(error);
    }
    function onAbort(): void {
      fail(signal?.reason ?? new DOMException('Package observation stopped', 'AbortError'));
    }
    async function query(): Promise<void> {
      if (stopped) return;
      if (reading) { dirty = true; return; }
      reading = true;
      dirty = false;
      try {
        const completed = decodeCloudPackageOperationResult(await hostApiFetch<unknown>('/api/packages/operation-result', {
          method: 'POST', body: JSON.stringify({ operationId: receipt.operationId }), signal,
        }), receipt.operationId, kind);
        if (stopped) return;
        if (completed.state === 'failed') throw Object.assign(new Error(completed.error.message), completed.error);
        if (completed.state === 'succeeded') {
          cleanup();
          resolve(completed.result as CloudPackageOperationResults[K]);
        }
      } catch (error) {
        fail(error);
      } finally {
        reading = false;
        if (dirty && !stopped) void query();
      }
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      subscriptions.push(subscribeHostEvent('package:changed', (payload) => {
        if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)
          && Object.keys(payload).length === 1 && Object.hasOwn(payload, 'operationId')
          && (payload as { operationId: unknown }).operationId === receipt.operationId) void query();
      }));
      subscriptions.push(subscribeBrowserRecovery(() => { void query(); }));
    } catch (error) {
      fail(error);
    }
    if (stopped) { cleanup(); return; }
    if (signal?.aborted) { onAbort(); return; }
    void query();
  });
}
