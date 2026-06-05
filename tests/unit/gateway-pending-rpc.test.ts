import { describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_PENDING_RPC_LIMIT,
  GatewayPendingRpcRequests,
} from '../../runtime-host/openclaw-bridge/client-pending-rpc';
import type { RuntimeScheduledTask } from '../../runtime-host/application/common/runtime-ports';

function createScheduler() {
  const tasks: Array<{ delayMs: number; task: () => void; canceled: boolean }> = [];
  return {
    tasks,
    scheduler: {
      schedule: (delayMs: number, task: () => void): RuntimeScheduledTask => {
        const scheduled = { delayMs, task, canceled: false };
        tasks.push(scheduled);
        return {
          cancel: () => {
            scheduled.canceled = true;
          },
        };
      },
    },
  };
}

describe('GatewayPendingRpcRequests', () => {
  it('rejects new registrations when the pending map reaches the hard limit', async () => {
    const { scheduler } = createScheduler();
    const pending = new GatewayPendingRpcRequests(scheduler);
    const onTimeout = vi.fn();

    for (let index = 0; index < GATEWAY_PENDING_RPC_LIMIT; index += 1) {
      pending.register({
        requestId: `req-${index}`,
        method: 'test.method',
        timeoutMs: 10_000,
        nowMs: 0,
        onTimeout,
      }).catch(() => undefined);
    }

    await expect(pending.register({
      requestId: 'overflow',
      method: 'overflow.method',
      timeoutMs: 10_000,
      nowMs: 0,
      onTimeout,
    })).rejects.toThrow('Gateway pending RPC limit exceeded: overflow.method');
    expect(pending.size()).toBe(GATEWAY_PENDING_RPC_LIMIT);
  });

  it('groups same-second timeouts into one scheduled bucket', async () => {
    const { scheduler, tasks } = createScheduler();
    const pending = new GatewayPendingRpcRequests(scheduler);
    const onTimeout = vi.fn();
    const first = pending.register({ requestId: 'req-1', method: 'first', timeoutMs: 1_100, nowMs: 0, onTimeout });
    const second = pending.register({ requestId: 'req-2', method: 'second', timeoutMs: 1_800, nowMs: 0, onTimeout });

    expect(tasks).toHaveLength(1);
    tasks[0]!.task();

    await expect(first).rejects.toThrow('Gateway RPC timeout: first');
    await expect(second).rejects.toThrow('Gateway RPC timeout: second');
    expect(onTimeout).toHaveBeenCalledTimes(2);
    expect(pending.size()).toBe(0);
  });

  it('cancels timeout buckets when all requests in the bucket settle early', async () => {
    const { scheduler, tasks } = createScheduler();
    const pending = new GatewayPendingRpcRequests(scheduler);
    const onTimeout = vi.fn();
    const rpc = pending.register({ requestId: 'req-1', method: 'first', timeoutMs: 1_100, nowMs: 0, onTimeout });

    pending.take('req-1')?.resolve({ ok: true });

    await expect(rpc).resolves.toEqual({ ok: true });
    expect(tasks[0]?.canceled).toBe(true);
    expect(pending.size()).toBe(0);
  });
});
