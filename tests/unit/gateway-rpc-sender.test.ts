import { describe, expect, it, vi } from 'vitest';
import type { PendingGatewayRpcRequest } from '../../runtime-host/openclaw-bridge/client-pending-rpc';
import {
  GATEWAY_RPC_CONCURRENCY_LIMIT,
  GATEWAY_RPC_QUEUE_LIMIT,
  GatewayRpcSender,
} from '../../runtime-host/openclaw-bridge/client-rpc-sender';
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createPendingRpcRequestsStub() {
  const pending = new Map<string, ReturnType<typeof createDeferred<unknown>>>();
  return {
    pending,
    register: vi.fn((input: { requestId: string }) => {
      const deferred = createDeferred<unknown>();
      pending.set(input.requestId, deferred);
      return deferred.promise;
    }),
    take: (requestId: string): PendingGatewayRpcRequest | null => {
      const deferred = pending.get(requestId);
      if (!deferred) {
        return null;
      }
      pending.delete(requestId);
      return {
        method: requestId,
        resolve: deferred.resolve,
        reject: vi.fn(),
        clearTimer: vi.fn(),
      };
    },
    delete: vi.fn((requestId: string) => {
      pending.delete(requestId);
    }),
    size: vi.fn(() => pending.size),
    rejectAll: vi.fn(),
  };
}

describe('GatewayRpcSender', () => {
  it('limits concurrent pending RPC sends and releases queued calls in FIFO order', async () => {
    let nextId = 1;
    const pending = createPendingRpcRequestsStub();
    const sender = new GatewayRpcSender({
      ensureConnected: vi.fn(async () => undefined),
      isSocketOpen: () => true,
      sendRaw: vi.fn(),
      pendingRpcRequests: pending as never,
      idGenerator: { randomId: () => String(nextId++) },
      clock: { nowMs: () => 1 },
      recordRpcFailure: vi.fn(),
    });

    const calls = Array.from({ length: GATEWAY_RPC_CONCURRENCY_LIMIT + 1 }, (_, index) => sender.call(`method-${index}`, {}));
    await vi.waitFor(() => {
      expect(pending.pending.has('req-1')).toBe(true);
    });

    expect((sender as unknown as { activeCallCount: number }).activeCallCount).toBe(GATEWAY_RPC_CONCURRENCY_LIMIT);
    expect((sender as unknown as { queuedCalls: unknown[] }).queuedCalls).toHaveLength(1);

    pending.take('req-1')?.resolve({ ok: true });
    await expect(calls[0]).resolves.toEqual({ ok: true });
    await Promise.resolve();

    expect((sender as unknown as { activeCallCount: number }).activeCallCount).toBe(GATEWAY_RPC_CONCURRENCY_LIMIT);
    expect((sender as unknown as { queuedCallHead: number }).queuedCallHead).toBe(1);
    await vi.waitFor(() => {
      expect(pending.pending.has(`req-${GATEWAY_RPC_CONCURRENCY_LIMIT + 1}`)).toBe(true);
    });

    for (let requestId = 2; requestId <= GATEWAY_RPC_CONCURRENCY_LIMIT + 1; requestId += 1) {
      pending.take(`req-${requestId}`)?.resolve({ ok: true, requestId });
    }
    await expect(Promise.all(calls)).resolves.toHaveLength(GATEWAY_RPC_CONCURRENCY_LIMIT + 1);
    expect((sender as unknown as { activeCallCount: number }).activeCallCount).toBe(0);
  });

  it('rejects when the pending RPC queue is full', async () => {
    const blockedConnection = createDeferred<void>();
    const pending = createPendingRpcRequestsStub();
    const sender = new GatewayRpcSender({
      ensureConnected: vi.fn(() => blockedConnection.promise),
      isSocketOpen: () => true,
      sendRaw: vi.fn((payload: string) => {
        const parsed = JSON.parse(payload) as { id: string };
        pending.take(parsed.id)?.resolve({ ok: true });
      }),
      pendingRpcRequests: pending as never,
      idGenerator: { randomId: () => 'blocked' },
      clock: { nowMs: () => 1 },
      recordRpcFailure: vi.fn(),
    });

    const blockedCalls = Array.from(
      { length: GATEWAY_RPC_CONCURRENCY_LIMIT + GATEWAY_RPC_QUEUE_LIMIT },
      (_, index) => sender.call(`blocked-${index}`, {}).catch((error: unknown) => error),
    );
    await Promise.resolve();

    await expect(sender.call('overflow', {})).rejects.toThrow('Gateway RPC queue full: overflow');
    blockedConnection.resolve();
    await Promise.all(blockedCalls);
  });
});
