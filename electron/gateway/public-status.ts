import type { GatewayStatus as GatewayProcessStatus } from './manager';
import type { RuntimeHostGatewayStatusSnapshot } from '../main/runtime-host-manager';
import type { GatewayTransportIssue } from '../../runtime-host/shared/gateway-error';

export interface PublicGatewayStatus {
  processState: GatewayProcessStatus['state'];
  port: number;
  pid?: number;
  uptime?: number;
  error?: string;
  connectedAt?: number;
  version?: string;
  reconnectAttempts?: number;
  gatewayReady: boolean;
  healthSummary: 'healthy' | 'degraded' | 'unresponsive';
  transportState: 'connected' | 'reconnecting' | 'disconnected';
  portReachable: boolean;
  lastAliveAt?: number;
  lastError?: string;
  lastIssue?: GatewayTransportIssue;
  diagnostics: RuntimeHostGatewayStatusSnapshot['diagnostics'];
  updatedAt: number;
}

function isActiveProcessState(state: GatewayProcessStatus['state']): boolean {
  return state === 'starting'
    || state === 'control_connecting'
    || state === 'running'
    || state === 'reconnecting';
}

function deriveFallbackHealthSummary(
  processState: GatewayProcessStatus['state'],
): PublicGatewayStatus['healthSummary'] {
  return isActiveProcessState(processState) ? 'degraded' : 'unresponsive';
}

function deriveFallbackTransportState(
  processState: GatewayProcessStatus['state'],
): PublicGatewayStatus['transportState'] {
  return isActiveProcessState(processState) ? 'reconnecting' : 'disconnected';
}

function buildEmptyDiagnostics(): PublicGatewayStatus['diagnostics'] {
  return {
    consecutiveHeartbeatMisses: 0,
    consecutiveRpcFailures: 0,
  };
}

export function buildPublicGatewayStatus(
  gatewayStatus: GatewayProcessStatus,
  runtimeGatewayStatus: RuntimeHostGatewayStatusSnapshot | null,
): PublicGatewayStatus {
  if (!runtimeGatewayStatus) {
    return {
      processState: gatewayStatus.processState,
      port: gatewayStatus.port,
      ...(typeof gatewayStatus.pid === 'number' ? { pid: gatewayStatus.pid } : {}),
      ...(typeof gatewayStatus.uptime === 'number' ? { uptime: gatewayStatus.uptime } : {}),
      ...(typeof gatewayStatus.error === 'string' ? { error: gatewayStatus.error } : {}),
      ...(typeof gatewayStatus.connectedAt === 'number' ? { connectedAt: gatewayStatus.connectedAt } : {}),
      ...(typeof gatewayStatus.version === 'string' ? { version: gatewayStatus.version } : {}),
      ...(typeof gatewayStatus.reconnectAttempts === 'number'
        ? { reconnectAttempts: gatewayStatus.reconnectAttempts }
        : {}),
      gatewayReady: false,
      healthSummary: deriveFallbackHealthSummary(gatewayStatus.processState),
      transportState: deriveFallbackTransportState(gatewayStatus.processState),
      portReachable: gatewayStatus.processState === 'running' || gatewayStatus.processState === 'control_connecting',
      diagnostics: buildEmptyDiagnostics(),
      updatedAt: Date.now(),
    };
  }

  return {
    processState: gatewayStatus.processState,
    port: gatewayStatus.port,
    ...(typeof gatewayStatus.pid === 'number' ? { pid: gatewayStatus.pid } : {}),
    ...(typeof gatewayStatus.uptime === 'number' ? { uptime: gatewayStatus.uptime } : {}),
    ...(typeof gatewayStatus.error === 'string' ? { error: gatewayStatus.error } : {}),
    ...(typeof gatewayStatus.connectedAt === 'number' ? { connectedAt: gatewayStatus.connectedAt } : {}),
    ...(typeof gatewayStatus.version === 'string' ? { version: gatewayStatus.version } : {}),
    ...(typeof gatewayStatus.reconnectAttempts === 'number'
      ? { reconnectAttempts: gatewayStatus.reconnectAttempts }
      : {}),
    gatewayReady: runtimeGatewayStatus.gatewayReady,
    healthSummary: runtimeGatewayStatus.healthSummary,
    transportState: runtimeGatewayStatus.state,
    portReachable: runtimeGatewayStatus.portReachable,
    ...(typeof runtimeGatewayStatus.diagnostics.lastAliveAt === 'number'
      ? { lastAliveAt: runtimeGatewayStatus.diagnostics.lastAliveAt }
      : {}),
    ...(typeof runtimeGatewayStatus.lastError === 'string' ? { lastError: runtimeGatewayStatus.lastError } : {}),
    ...(runtimeGatewayStatus.lastIssue ? { lastIssue: runtimeGatewayStatus.lastIssue } : {}),
    diagnostics: runtimeGatewayStatus.diagnostics,
    updatedAt: runtimeGatewayStatus.updatedAt,
  };
}
