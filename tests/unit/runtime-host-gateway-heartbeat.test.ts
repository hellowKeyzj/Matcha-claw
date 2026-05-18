import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimeClockPort,
  RuntimeScheduledTask,
  RuntimeSchedulerPort,
} from '../../runtime-host/application/common/runtime-ports';
import {
  GATEWAY_READY_FALLBACK_PROBE_DELAYS_MS,
  GatewayHeartbeatScheduler,
  getGatewayHeartbeatOptions,
  type GatewayHeartbeatCallbacks,
} from '../../runtime-host/openclaw-bridge/client-heartbeat';

class ManualScheduler implements RuntimeSchedulerPort {
  readonly tasks: Array<{ delayMs: number; task: () => void; cancelled: boolean }> = [];

  schedule(delayMs: number, task: () => void): RuntimeScheduledTask {
    const entry = { delayMs, task, cancelled: false };
    this.tasks.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  runLastTask(): void {
    const entry = this.tasks.at(-1);
    if (!entry || entry.cancelled) {
      return;
    }
    entry.task();
  }
}

function createClock(): RuntimeClockPort {
  return {
    nowMs: () => 1_700_000_000_000,
    nowIso: () => '2023-11-14T22:13:20.000Z',
    toIsoString: (ms) => new Date(ms).toISOString(),
  };
}

function createCallbacks(overrides?: Partial<GatewayHeartbeatCallbacks>): GatewayHeartbeatCallbacks {
  return {
    isActive: () => true,
    isSocketOpen: () => true,
    isConnected: () => true,
    isGatewayReady: () => false,
    getConnectedAt: () => 1,
    getConsecutiveHeartbeatMisses: () => 0,
    ping: vi.fn(),
    probeReady: vi.fn(async () => undefined),
    recordHeartbeatTimeout: vi.fn(),
    requestRestart: vi.fn(),
    scheduleReconnect: vi.fn(),
    ...overrides,
  };
}

describe('GatewayHeartbeatScheduler gateway ready fallback', () => {
  it('quickly probes gateway readiness before falling back to the long retry interval', async () => {
    const scheduler = new ManualScheduler();
    const probeReady = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('not ready'))
      .mockRejectedValueOnce(new Error('still not ready'))
      .mockRejectedValueOnce(new Error('still warming up'));
    const heartbeat = new GatewayHeartbeatScheduler(
      createCallbacks({ probeReady }),
      getGatewayHeartbeatOptions('linux'),
      scheduler,
      createClock(),
    );

    heartbeat.scheduleGatewayReadyFallback(1);
    expect(scheduler.tasks.at(-1)?.delayMs).toBe(GATEWAY_READY_FALLBACK_PROBE_DELAYS_MS[0]);

    scheduler.runLastTask();
    await Promise.resolve();
    expect(scheduler.tasks.at(-1)?.delayMs).toBe(GATEWAY_READY_FALLBACK_PROBE_DELAYS_MS[1]);

    scheduler.runLastTask();
    await Promise.resolve();
    expect(scheduler.tasks.at(-1)?.delayMs).toBe(GATEWAY_READY_FALLBACK_PROBE_DELAYS_MS[2]);

    scheduler.runLastTask();
    await Promise.resolve();
    expect(scheduler.tasks.at(-1)?.delayMs).toBe(GATEWAY_READY_FALLBACK_PROBE_DELAYS_MS[3]);
  });

  it('resets fallback probe cadence when recovery timers are cleared', async () => {
    const scheduler = new ManualScheduler();
    const probeReady = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('not ready'));
    const heartbeat = new GatewayHeartbeatScheduler(
      createCallbacks({ probeReady }),
      getGatewayHeartbeatOptions('linux'),
      scheduler,
      createClock(),
    );

    heartbeat.scheduleGatewayReadyFallback(1);
    scheduler.runLastTask();
    await Promise.resolve();
    expect(scheduler.tasks.at(-1)?.delayMs).toBe(GATEWAY_READY_FALLBACK_PROBE_DELAYS_MS[1]);

    heartbeat.clearRecoveryTimers();
    heartbeat.scheduleGatewayReadyFallback(2);

    expect(scheduler.tasks.at(-1)?.delayMs).toBe(GATEWAY_READY_FALLBACK_PROBE_DELAYS_MS[0]);
  });
});
