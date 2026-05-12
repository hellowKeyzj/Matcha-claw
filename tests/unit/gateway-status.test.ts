import { describe, expect, it } from 'vitest';
import { isGatewayPreparing } from '@/lib/gateway-status';
import type { GatewayStatus } from '@/types/gateway';

function status(overrides: Partial<GatewayStatus>): GatewayStatus {
  return {
    processState: 'running',
    port: 18789,
    gatewayReady: true,
    healthSummary: 'healthy',
    transportState: 'connected',
    portReachable: true,
    diagnostics: {
      consecutiveHeartbeatMisses: 0,
      consecutiveRpcFailures: 0,
    },
    updatedAt: 1,
    ...overrides,
  };
}

describe('gateway status helpers', () => {
  it('把未初始化、启动中、控制连接中、重连中识别为准备中', () => {
    expect(isGatewayPreparing(status({ processState: 'stopped', healthSummary: 'unresponsive' }), false)).toBe(true);
    expect(isGatewayPreparing(status({ processState: 'starting', gatewayReady: false, transportState: 'disconnected' }), true)).toBe(true);
    expect(isGatewayPreparing(status({ processState: 'control_connecting', gatewayReady: false, transportState: 'disconnected' }), true)).toBe(true);
    expect(isGatewayPreparing(status({ processState: 'reconnecting', gatewayReady: false, transportState: 'disconnected' }), true)).toBe(true);
    expect(isGatewayPreparing(status({
      processState: 'running',
      gatewayReady: false,
      healthSummary: 'unresponsive',
      transportState: 'disconnected',
      portReachable: false,
      lastIssue: {
        message: 'Gateway socket closed: code=1006 reason=unknown',
        source: 'socket-close',
        at: 1,
        code: '1006',
      },
    }), true)).toBe(true);
  });

  it('真正停止、错误或无响应时不算准备中', () => {
    expect(isGatewayPreparing(status({ processState: 'stopped', healthSummary: 'unresponsive' }), true)).toBe(false);
    expect(isGatewayPreparing(status({ processState: 'error' }), true)).toBe(false);
  });
});
