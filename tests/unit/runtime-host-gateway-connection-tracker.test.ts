import { describe, expect, it } from 'vitest';
import { GatewayConnectionTracker } from '../../runtime-host/openclaw-bridge/client-connection-tracker';
import { createGatewayTransportIssue } from '../../runtime-host/openclaw-bridge/client-state';
import { createTestRuntimeClock } from './helpers/runtime-clock';

describe('GatewayConnectionTracker', () => {
  it('网关恢复上报 lastError 为空时应清理旧 lastIssue', () => {
    const clock = createTestRuntimeClock();
    const tracker = new GatewayConnectionTracker(clock);
    const timeoutIssue = createGatewayTransportIssue({
      message: 'Gateway heartbeat timeout',
      source: 'heartbeat-timeout',
      clock,
    });

    tracker.updateSnapshot({
      state: 'connected',
      portReachable: true,
      gatewayReady: true,
      diagnostics: {
        consecutiveHeartbeatMisses: 1,
        consecutiveRpcFailures: 0,
        lastHeartbeatTimeoutAt: clock.nowMs(),
      },
      lastError: timeoutIssue.message,
      lastIssue: timeoutIssue,
    });

    const recoveredDiagnostics = tracker.updateDiagnostics({
      consecutiveHeartbeatMisses: 0,
      lastAliveAt: clock.nowMs(),
    });
    const recovered = tracker.updateSnapshot({
      diagnostics: recoveredDiagnostics,
      lastError: '',
    });

    expect(recovered.lastError).toBeUndefined();
    expect(recovered.lastIssue).toBeUndefined();
    expect(recovered.healthSummary).toBe('healthy');
  });
});
