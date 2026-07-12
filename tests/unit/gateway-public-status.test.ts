import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPublicGatewayStatus } from '../../electron/main/process-runtime/openclaw-gateway/public-status';
import type { RuntimeHostGatewayStatusSnapshot } from '../../electron/main/runtime-host-manager';

type GatewayProcessStatus = Parameters<typeof buildPublicGatewayStatus>[0];

const emptyDiagnostics = {
  consecutiveHeartbeatMisses: 0,
  consecutiveRpcFailures: 0,
};

describe('buildPublicGatewayStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runtime health 为 null 时保留 gateway 进程字段并派生 fallback 状态', () => {
    vi.useFakeTimers();
    vi.setSystemTime(98_765);

    const gatewayStatus: GatewayProcessStatus = {
      processState: 'running',
      port: 18789,
      pid: 1234,
      uptime: 5678,
      error: 'previous launch warning',
      connectedAt: 123,
      version: '2026.5.20',
      reconnectAttempts: 2,
    };

    expect(buildPublicGatewayStatus(gatewayStatus, null)).toEqual({
      processState: 'running',
      port: 18789,
      pid: 1234,
      uptime: 5678,
      error: 'previous launch warning',
      connectedAt: 123,
      version: '2026.5.20',
      reconnectAttempts: 2,
      gatewayReady: false,
      healthSummary: 'degraded',
      transportState: 'reconnecting',
      portReachable: true,
      diagnostics: emptyDiagnostics,
      updatedAt: 98_765,
    });

    expect(buildPublicGatewayStatus({ processState: 'control_connecting', port: 18789 }, null)).toMatchObject({
      gatewayReady: false,
      healthSummary: 'degraded',
      transportState: 'reconnecting',
      portReachable: true,
      diagnostics: emptyDiagnostics,
      updatedAt: 98_765,
    });
    expect(buildPublicGatewayStatus({ processState: 'starting', port: 18789 }, null)).toMatchObject({
      gatewayReady: false,
      healthSummary: 'degraded',
      transportState: 'reconnecting',
      portReachable: false,
      diagnostics: emptyDiagnostics,
      updatedAt: 98_765,
    });
    expect(buildPublicGatewayStatus({ processState: 'reconnecting', port: 18789 }, null)).toMatchObject({
      gatewayReady: false,
      healthSummary: 'degraded',
      transportState: 'reconnecting',
      portReachable: false,
      diagnostics: emptyDiagnostics,
      updatedAt: 98_765,
    });
    expect(buildPublicGatewayStatus({ processState: 'stopped', port: 18789 }, null)).toMatchObject({
      gatewayReady: false,
      healthSummary: 'unresponsive',
      transportState: 'disconnected',
      portReachable: false,
      diagnostics: emptyDiagnostics,
      updatedAt: 98_765,
    });
    expect(buildPublicGatewayStatus({ processState: 'error', port: 18789 }, null)).toMatchObject({
      gatewayReady: false,
      healthSummary: 'unresponsive',
      transportState: 'disconnected',
      portReachable: false,
      diagnostics: emptyDiagnostics,
      updatedAt: 98_765,
    });
  });

  it('runtime health degraded 时透传 runtime health 并保留 gateway 进程字段', () => {
    const diagnostics = {
      lastAliveAt: 1_000,
      lastRpcSuccessAt: 900,
      lastRpcFailureAt: 1_100,
      lastRpcFailureMethod: 'gateway.ping',
      lastHeartbeatTimeoutAt: 1_200,
      consecutiveHeartbeatMisses: 2,
      lastSocketCloseAt: 1_300,
      lastSocketCloseCode: 1006,
      consecutiveRpcFailures: 3,
    };
    const runtimeGatewayStatus: RuntimeHostGatewayStatusSnapshot = {
      state: 'reconnecting',
      portReachable: false,
      gatewayReady: false,
      healthSummary: 'degraded',
      diagnostics,
      lastError: 'heartbeat timeout',
      updatedAt: 2_000,
    };

    expect(buildPublicGatewayStatus({
      processState: 'running',
      port: 18789,
      pid: 4321,
      uptime: 8765,
      connectedAt: 111,
      version: '2026.5.20',
      reconnectAttempts: 4,
    }, runtimeGatewayStatus)).toEqual({
      processState: 'running',
      port: 18789,
      pid: 4321,
      uptime: 8765,
      connectedAt: 111,
      version: '2026.5.20',
      reconnectAttempts: 4,
      gatewayReady: false,
      healthSummary: 'degraded',
      transportState: 'reconnecting',
      portReachable: false,
      lastAliveAt: 1_000,
      lastError: 'heartbeat timeout',
      diagnostics,
      updatedAt: 2_000,
    });
  });

  it('runtime health unresponsive 且带 lastIssue 时透传 issue、diagnostics 和 updatedAt', () => {
    const diagnostics = {
      lastHeartbeatTimeoutAt: 3_000,
      consecutiveHeartbeatMisses: 5,
      consecutiveRpcFailures: 2,
    };
    const lastIssue = {
      message: 'Gateway socket closed: code=1006 reason=abnormal',
      source: 'socket-close' as const,
      at: 3_100,
      code: '1006',
      retryable: true,
      retryAfterMs: 5_000,
    };
    const runtimeGatewayStatus: RuntimeHostGatewayStatusSnapshot = {
      state: 'disconnected',
      portReachable: false,
      gatewayReady: false,
      healthSummary: 'unresponsive',
      diagnostics,
      lastIssue,
      updatedAt: 3_200,
    };

    expect(buildPublicGatewayStatus({ processState: 'running', port: 18789 }, runtimeGatewayStatus)).toMatchObject({
      processState: 'running',
      port: 18789,
      gatewayReady: false,
      healthSummary: 'unresponsive',
      transportState: 'disconnected',
      portReachable: false,
      lastIssue,
      diagnostics,
      updatedAt: 3_200,
    });
  });
});
