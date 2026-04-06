export const RUNTIME_HOST_TRANSPORT_VERSION = 1 as const;

export type RuntimeHostRequestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type RuntimeHostTransportErrorCode =
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'NOT_IMPLEMENTED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface RuntimeHostTransportRequest {
  readonly version: typeof RUNTIME_HOST_TRANSPORT_VERSION;
  readonly method: RuntimeHostRequestMethod;
  readonly route: string;
  readonly payload?: unknown;
}

export interface RuntimeHostTransportError {
  readonly code: RuntimeHostTransportErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface RuntimeHostTransportSuccess<TData = unknown> {
  readonly version: typeof RUNTIME_HOST_TRANSPORT_VERSION;
  readonly success: true;
  readonly status: number;
  readonly data: TData;
}

export interface RuntimeHostTransportFailure {
  readonly version: typeof RUNTIME_HOST_TRANSPORT_VERSION;
  readonly success: false;
  readonly status: number;
  readonly error: RuntimeHostTransportError;
}

export type RuntimeHostTransportResponse<TData = unknown> =
  | RuntimeHostTransportSuccess<TData>
  | RuntimeHostTransportFailure;

export interface RuntimeHostTransportHealth {
  readonly version: typeof RUNTIME_HOST_TRANSPORT_VERSION;
  readonly ok: boolean;
  readonly lifecycle: 'idle' | 'starting' | 'running' | 'stopped' | 'error';
  readonly pid?: number;
  readonly uptimeSec?: number;
  readonly error?: string;
}
