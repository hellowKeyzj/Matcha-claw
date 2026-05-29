import type { GatewayResponseFrame } from './protocol';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function ensureError(value: unknown, fallback = 'Gateway request failed'): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(value ? String(value) : fallback);
}

export function extractGatewayErrorMessage(payload: unknown): string {
  if (!isRecord(payload)) {
    return String(payload);
  }
  const error = payload.error;
  if (!isRecord(error)) {
    return String(payload.error || 'Unknown Gateway error');
  }
  if (typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  if (typeof error.code === 'string' && error.code.trim()) {
    return error.code;
  }
  return JSON.stringify(error);
}

export function extractGatewayErrorMessageFromResponse(message: GatewayResponseFrame): string {
  if (message.error !== undefined && message.error !== null) {
    return extractGatewayErrorMessage({ error: message.error });
  }
  return 'Unknown Gateway error';
}

export function extractGatewayErrorCode(payload: unknown): string {
  if (!isRecord(payload)) {
    return '';
  }
  const error = payload.error;
  if (!isRecord(error)) {
    return '';
  }
  return typeof error.code === 'string' ? error.code.trim() : '';
}

export function extractGatewayErrorDetails(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }
  const error = payload.error;
  if (!isRecord(error)) {
    return undefined;
  }
  return error.details;
}

export function extractGatewayErrorRetryable(payload: unknown): boolean | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const error = payload.error;
  if (!isRecord(error)) {
    return undefined;
  }
  return typeof error.retryable === 'boolean' ? error.retryable : undefined;
}

export function extractGatewayErrorRetryAfterMs(payload: unknown): number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const error = payload.error;
  if (!isRecord(error)) {
    return undefined;
  }
  const retryAfterMs = error.retryAfterMs;
  return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : undefined;
}
