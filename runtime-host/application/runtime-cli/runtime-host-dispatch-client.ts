import { DEFAULT_PORT, DISPATCH_TIMEOUT_MS, TRANSPORT_VERSION } from '../../shared/runtime-host-constants';
import type { CapabilityTarget, RuntimeScope } from '../agent-runtime/contracts/runtime-address';

export type RuntimeHostRouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type RuntimeHostDispatchErrorKind =
  | 'timeout'
  | 'network'
  | 'invalidResponse'
  | 'dispatchFailure'
  | 'applicationFailure';

export interface RuntimeHostDispatchClientOptions {
  readonly runtimeHostBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface RuntimeHostRouteDispatchInput extends RuntimeHostDispatchClientOptions {
  readonly method: RuntimeHostRouteMethod;
  readonly route: string;
  readonly payload?: unknown;
}

export interface RuntimeCapabilityInvokeInput extends RuntimeHostDispatchClientOptions {
  readonly id: string;
  readonly operationId: string;
  readonly scope: RuntimeScope;
  readonly target: CapabilityTarget | null;
  readonly capabilityInput: unknown;
}

export class RuntimeHostDispatchClientError extends Error {
  readonly kind: RuntimeHostDispatchErrorKind;
  readonly status?: number;
  readonly code?: string;

  constructor(input: {
    readonly kind: RuntimeHostDispatchErrorKind;
    readonly message: string;
    readonly status?: number;
    readonly code?: string;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'RuntimeHostDispatchClientError';
    this.kind = input.kind;
    this.status = input.status;
    this.code = input.code;
  }
}

const DEFAULT_RUNTIME_HOST_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

export function resolveRuntimeHostBaseUrl(explicitBaseUrl?: string): string {
  const explicit = explicitBaseUrl?.trim() || process.env.MATCHACLAW_RUNTIME_HOST_BASE_URL?.trim();
  if (explicit) {
    return normalizeRuntimeHostBaseUrl(explicit);
  }
  const port = process.env.MATCHACLAW_RUNTIME_HOST_PORT?.trim();
  return port ? `http://127.0.0.1:${port}` : DEFAULT_RUNTIME_HOST_BASE_URL;
}

export function normalizeRuntimeHostBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function resolveRuntimeHostTimeoutMs(explicitTimeoutMs?: number): number {
  return explicitTimeoutMs ?? DISPATCH_TIMEOUT_MS;
}

export function parseRuntimeHostTimeoutMs(rawTimeoutMs: string): number | null {
  if (!/^\d+$/.test(rawTimeoutMs.trim())) {
    return null;
  }
  const timeoutMs = Number(rawTimeoutMs);
  return Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
}

export async function dispatchRuntimeHostRoute(input: RuntimeHostRouteDispatchInput): Promise<unknown> {
  const runtimeHostBaseUrl = resolveRuntimeHostBaseUrl(input.runtimeHostBaseUrl);
  const timeoutMs = resolveRuntimeHostTimeoutMs(input.timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await (input.fetchImpl ?? fetch)(`${runtimeHostBaseUrl}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: TRANSPORT_VERSION,
        method: input.method,
        route: input.route,
        payload: input.payload,
      }),
      signal: controller.signal,
    });
    const body = await readRuntimeHostResponseBody(response);
    const bodyRecord = readRecord(body);
    if (!response.ok || bodyRecord.success !== true) {
      throw new RuntimeHostDispatchClientError({
        kind: 'dispatchFailure',
        status: response.status,
        code: readResponseErrorCode(bodyRecord),
        message: readResponseErrorMessage(bodyRecord) ?? `runtime-host dispatch failed with status ${response.status}`,
      });
    }
    return bodyRecord.data;
  } catch (error) {
    if (error instanceof RuntimeHostDispatchClientError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new RuntimeHostDispatchClientError({
        kind: 'timeout',
        message: `runtime-host dispatch timed out after ${timeoutMs}ms`,
        cause: error,
      });
    }
    throw new RuntimeHostDispatchClientError({
      kind: 'network',
      message: `runtime-host dispatch request failed: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function invokeRuntimeCapability(input: RuntimeCapabilityInvokeInput): Promise<unknown> {
  const data = await dispatchRuntimeHostRoute({
    runtimeHostBaseUrl: input.runtimeHostBaseUrl,
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
    method: 'POST',
    route: '/api/capabilities/execute',
    payload: {
      id: input.id,
      operationId: input.operationId,
      scope: input.scope,
      target: input.target,
      input: input.capabilityInput,
    },
  });
  const dataRecord = readRecord(data);
  if (dataRecord.success === false) {
    throw new RuntimeHostDispatchClientError({
      kind: 'applicationFailure',
      code: readResponseErrorCode(dataRecord),
      message: readResponseErrorMessage(dataRecord) ?? 'runtime capability rejected the request',
    });
  }
  return data;
}

export function formatRuntimeHostDispatchError(error: unknown): string {
  if (error instanceof RuntimeHostDispatchClientError) {
    const status = error.status === undefined ? '' : ` status=${error.status}`;
    const code = error.code ? ` code=${error.code}` : '';
    return `${error.kind}${status}${code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function readRuntimeHostResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new RuntimeHostDispatchClientError({
      kind: 'invalidResponse',
      status: response.status,
      message: `runtime-host dispatch returned non-JSON response with status ${response.status}`,
      cause: error,
    });
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readResponseErrorCode(value: Record<string, unknown>): string | undefined {
  const error = value.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return undefined;
  }
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}

function readResponseErrorMessage(value: Record<string, unknown>): string | null {
  const error = value.error;
  if (typeof error === 'string') {
    return error;
  }
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return null;
  }
  const message = (error as Record<string, unknown>).message;
  return typeof message === 'string' && message.trim() ? message.trim() : null;
}
