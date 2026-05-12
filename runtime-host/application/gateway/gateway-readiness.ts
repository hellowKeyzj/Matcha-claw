export interface GatewayReadinessPort {
  readGatewayConnectionState(timeoutMs?: number): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function isGatewayReadyForSnapshot(
  gateway: GatewayReadinessPort,
  timeoutMs = 250,
): Promise<boolean> {
  try {
    const state = await gateway.readGatewayConnectionState(timeoutMs);
    if (!isRecord(state)) {
      return false;
    }
    return state.state === 'connected' && state.gatewayReady === true;
  } catch {
    return false;
  }
}

export function isGatewayStartupConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('econnrefused')
    || normalized.includes('connection refused')
    || normalized.includes('connect failed')
    || normalized.includes('socket hang up')
    || normalized.includes('closed before connect');
}
