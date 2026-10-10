import { normalizeAppError } from './error-model';

export type HostApiProxySuccessData = {
  status: number;
  ok: boolean;
  json?: unknown;
  text?: string;
};

export type HostApiProxySuccessEnvelope = {
  ok: true;
  data: HostApiProxySuccessData;
};

export type HostApiProxyFailureCode = 'TIMEOUT' | 'ABORTED' | 'UNAVAILABLE';

export type HostApiProxyFailureEnvelope = {
  ok: false;
  error: { message: string; code?: HostApiProxyFailureCode } | string;
};

export type HostApiProxyEnvelope = HostApiProxySuccessEnvelope | HostApiProxyFailureEnvelope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHostApiProxyFailureCode(value: unknown): value is HostApiProxyFailureCode {
  return value === 'TIMEOUT' || value === 'ABORTED' || value === 'UNAVAILABLE';
}

function extractHostApiErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) {
    return fallback;
  }
  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error;
  }
  if (isRecord(payload.error) && typeof payload.error.message === 'string' && payload.error.message.trim()) {
    return payload.error.message;
  }
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }
  return fallback;
}

export function resolveHostApiProxyErrorMessage(error: HostApiProxyFailureEnvelope['error'] | undefined): string {
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return 'Host API proxy request failed';
}

export function resolveHostApiProxyErrorCode(
  error: HostApiProxyFailureEnvelope['error'] | undefined,
): HostApiProxyFailureCode | undefined {
  if (isRecord(error) && isHostApiProxyFailureCode(error.code)) {
    return error.code;
  }
  return undefined;
}

export function decodeHostApiProxyEnvelope(payload: unknown): HostApiProxyEnvelope {
  if (!isRecord(payload)) {
    throw new Error('Invalid hostapi proxy envelope: expected object');
  }

  if (payload.ok === true) {
    if (!isRecord(payload.data)) {
      throw new Error('Invalid hostapi proxy envelope: success response missing data object');
    }
    const status = payload.data.status;
    const ok = payload.data.ok;
    if (typeof status !== 'number' || !Number.isFinite(status)) {
      throw new Error('Invalid hostapi proxy envelope: success response missing numeric status');
    }
    if (typeof ok !== 'boolean') {
      throw new Error('Invalid hostapi proxy envelope: success response missing boolean ok');
    }
    if (payload.data.text !== undefined && typeof payload.data.text !== 'string') {
      throw new Error('Invalid hostapi proxy envelope: success response text must be string');
    }
    return {
      ok: true,
      data: {
        status,
        ok,
        ...(payload.data.json !== undefined ? { json: payload.data.json } : {}),
        ...(typeof payload.data.text === 'string' ? { text: payload.data.text } : {}),
      },
    };
  }

  if (payload.ok === false) {
    const error = payload.error;
    if (
      !(typeof error === 'string' && error.trim())
      && !(isRecord(error) && typeof error.message === 'string' && error.message.trim())
    ) {
      throw new Error('Invalid hostapi proxy envelope: failure response missing error message');
    }
    return {
      ok: false,
      error: typeof error === 'string'
        ? error
        : {
          message: error.message as string,
          ...(isHostApiProxyFailureCode(error.code) ? { code: error.code } : {}),
        },
    };
  }

  throw new Error('Invalid hostapi proxy envelope: missing boolean ok');
}

export function unwrapHostApiProxyEnvelope<T>(
  envelope: HostApiProxyEnvelope,
  context: { method: string; path: string },
): { status: number; data: T } {
  if (!envelope.ok) {
    const error = new Error(resolveHostApiProxyErrorMessage(envelope.error));
    const code = resolveHostApiProxyErrorCode(envelope.error);
    if (code) {
      Object.assign(error, { code });
    }
    throw error;
  }

  const { status, ok, json, text } = envelope.data;
  if (status >= 400 || ok === false) {
    const fallbackMessage = text || `Host API request failed: ${context.method} ${context.path} (HTTP ${status})`;
    throw normalizeAppError(new Error(extractHostApiErrorMessage(json, fallbackMessage)), { ...context, status });
  }

  if (status === 204) {
    return {
      status,
      data: undefined as T,
    };
  }
  if (json !== undefined) {
    return {
      status,
      data: json as T,
    };
  }
  return {
    status,
    data: text as T,
  };
}
