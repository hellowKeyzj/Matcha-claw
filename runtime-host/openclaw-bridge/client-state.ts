import type { GatewayTransportIssue } from '../shared/gateway-error';
import type { RuntimeClockPort } from '../application/common/runtime-ports';

export type GatewayConnectionState = 'connected' | 'reconnecting' | 'disconnected';
export type GatewayHealthSummary = 'healthy' | 'degraded' | 'unresponsive';

export interface GatewayDiagnosticsSnapshot {
  readonly lastAliveAt?: number;
  readonly lastRpcSuccessAt?: number;
  readonly lastRpcFailureAt?: number;
  readonly lastRpcFailureMethod?: string;
  readonly lastHeartbeatTimeoutAt?: number;
  readonly consecutiveHeartbeatMisses: number;
  readonly lastSocketCloseAt?: number;
  readonly lastSocketCloseCode?: number;
  readonly consecutiveRpcFailures: number;
}

export interface GatewayConnectionStatePayload {
  readonly state: GatewayConnectionState;
  readonly portReachable: boolean;
  readonly gatewayReady: boolean;
  readonly healthSummary: GatewayHealthSummary;
  readonly transportEpoch: number;
  readonly lastError?: string;
  readonly lastIssue?: GatewayTransportIssue;
  readonly diagnostics: GatewayDiagnosticsSnapshot;
  readonly updatedAt: number;
}

export function buildInitialDiagnostics(): GatewayDiagnosticsSnapshot {
  return {
    consecutiveHeartbeatMisses: 0,
    consecutiveRpcFailures: 0,
  };
}

export function sameDiagnosticsSnapshot(
  left: GatewayDiagnosticsSnapshot,
  right: GatewayDiagnosticsSnapshot,
): boolean {
  return left.lastAliveAt === right.lastAliveAt
    && left.lastRpcSuccessAt === right.lastRpcSuccessAt
    && left.lastRpcFailureAt === right.lastRpcFailureAt
    && left.lastRpcFailureMethod === right.lastRpcFailureMethod
    && left.lastHeartbeatTimeoutAt === right.lastHeartbeatTimeoutAt
    && left.consecutiveHeartbeatMisses === right.consecutiveHeartbeatMisses
    && left.lastSocketCloseAt === right.lastSocketCloseAt
    && left.lastSocketCloseCode === right.lastSocketCloseCode
    && left.consecutiveRpcFailures === right.consecutiveRpcFailures;
}

export function buildGatewayHealthSummary(params: {
  state: GatewayConnectionState;
  portReachable: boolean;
  gatewayReady: boolean;
  diagnostics: GatewayDiagnosticsSnapshot;
}): GatewayHealthSummary {
  if (!params.portReachable || params.state === 'disconnected') {
    return 'unresponsive';
  }
  if (!params.gatewayReady) {
    return 'degraded';
  }
  if (params.diagnostics.consecutiveHeartbeatMisses > 0 || params.diagnostics.consecutiveRpcFailures > 0) {
    return 'degraded';
  }
  return 'healthy';
}

export function createGatewayTransportIssue(input: {
  message: string;
  source: GatewayTransportIssue['source'];
  clock: RuntimeClockPort;
  code?: string;
  details?: unknown;
}): GatewayTransportIssue {
  return {
    message: input.message,
    source: input.source,
    at: input.clock.nowMs(),
    ...(input.code ? { code: input.code } : {}),
    ...(input.details !== undefined ? { details: input.details } : {}),
  };
}
