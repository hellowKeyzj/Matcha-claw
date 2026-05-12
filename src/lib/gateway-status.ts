import type { GatewayStatus } from '@/types/gateway';

export function isGatewayProcessRunning(status: GatewayStatus): boolean {
  return status.processState === 'running';
}

export function isGatewayProcessActive(status: GatewayStatus): boolean {
  return status.processState === 'starting'
    || status.processState === 'control_connecting'
    || status.processState === 'running'
    || status.processState === 'reconnecting';
}

export function isGatewayTransportAvailable(status: GatewayStatus): boolean {
  return status.transportState === 'connected'
    && status.healthSummary !== 'unresponsive';
}

export function isGatewayOperational(status: GatewayStatus): boolean {
  return status.processState === 'running'
    && status.gatewayReady === true
    && isGatewayTransportAvailable(status);
}

export function isGatewayRecovering(status: GatewayStatus): boolean {
  if (!isGatewayProcessActive(status)) {
    return false;
  }
  return !isGatewayOperational(status) || status.healthSummary === 'degraded';
}

export function isGatewayPreparing(status: GatewayStatus, initialized: boolean): boolean {
  if (!initialized) {
    return true;
  }
  if (!isGatewayProcessActive(status)) {
    return false;
  }
  return !isGatewayOperational(status);
}

export function isGatewayUnavailable(status: GatewayStatus): boolean {
  return status.processState === 'stopped'
    || status.processState === 'error'
    || status.healthSummary === 'unresponsive';
}
