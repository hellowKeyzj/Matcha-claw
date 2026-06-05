import { describe, expect, it, vi } from 'vitest';
import { GATEWAY_PENDING_RPC_LIMIT, GatewayPendingRpcRequests } from '../../runtime-host/openclaw-bridge/client-pending-rpc';
import type { RuntimeScheduledTask, RuntimeSchedulerPort } from '../../runtime-host/application/common/runtime-ports';

class ManualScheduler implements RuntimeSchedulerPort {
  tasks: Array<() => void> = [];

  schedule(_delayMs: number, task: () => void): RuntimeScheduledTask {
    this.tasks.push(task);
    return {
      cancel: vi.fn(),
    };
  }

  runNext(): void {
    const task = this.tasks.shift();
    if (task) {
      task();
    }
  }
}

describe('GatewayPendingRpcRequests', () => {
  it('tracks pending RPC request count', () => {
    const scheduler = new ManualScheduler();
    const pendingRequests = new GatewayPendingRpcRequests(scheduler);

    pendingRequests.register({
      requestId: 'req-1',
      method: 'session.prompt',
      timeoutMs: 100,
      nowMs: 0,
      onTimeout: vi.fn(),
    }).catch(() => undefined);

    expect(pendingRequests.size()).toBe(1);
    pendingRequests.take('req-1')?.resolve({ ok: true });
    expect(pendingRequests.size()).toBe(0);
  });

  it('rejects new RPCs when the pending registry reaches its hard limit', async () => {
    const scheduler = new ManualScheduler();
    const pendingRequests = new GatewayPendingRpcRequests(scheduler);

    for (let index = 0; index < GATEWAY_PENDING_RPC_LIMIT; index += 1) {
      pendingRequests.register({
        requestId: `req-${index}`,
        method: 'session.prompt',
        timeoutMs: 10_000,
        nowMs: 0,
        onTimeout: vi.fn(),
      }).catch(() => undefined);
    }

    expect(pendingRequests.size()).toBe(GATEWAY_PENDING_RPC_LIMIT);
    await expect(pendingRequests.register({
      requestId: 'req-overflow',
      method: 'session.prompt',
      timeoutMs: 10_000,
      nowMs: 0,
      onTimeout: vi.fn(),
    })).rejects.toThrow('Gateway pending RPC limit exceeded: session.prompt');
  });

  it('rejects timed out RPCs inside the pending request registry', async () => {
    const scheduler = new ManualScheduler();
    const pendingRequests = new GatewayPendingRpcRequests(scheduler);
    const onTimeout = vi.fn();

    const promise = pendingRequests.register({
      requestId: 'req-1',
      method: 'session.prompt',
      timeoutMs: 100,
      nowMs: 0,
      onTimeout,
    });

    scheduler.runNext();

    await expect(promise).rejects.toThrow('Gateway RPC timeout: session.prompt');
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0]?.[1]).toEqual(expect.any(Error));
    expect(pendingRequests.take('req-1')).toBeNull();
    expect(pendingRequests.size()).toBe(0);
  });
});
