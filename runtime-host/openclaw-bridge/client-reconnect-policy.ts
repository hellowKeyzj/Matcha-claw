const GATEWAY_RECONNECT_BASE_DELAY_MS = 1_000;
const GATEWAY_RECONNECT_MAX_DELAY_MS = 30_000;

export const GATEWAY_RECONNECT_MAX_ATTEMPTS = 10;

export function nextReconnectDelayMs(attempt: number): number {
  return Math.min(
    GATEWAY_RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt)),
    GATEWAY_RECONNECT_MAX_DELAY_MS,
  );
}
