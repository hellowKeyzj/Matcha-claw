export const RUNTIME_HOST_TRANSPORT_VERSION = 1 as const;

export type RuntimeHostRequestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RuntimeHostRouteResult<TData = unknown> {
  readonly status: number;
  readonly data: TData;
}

export interface RuntimeHostTransportRequest {
  readonly version: typeof RUNTIME_HOST_TRANSPORT_VERSION;
  readonly method: RuntimeHostRequestMethod;
  readonly route: string;
  readonly payload?: unknown;
}

export interface RuntimeHostTransportError {
  readonly code: string;
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

export interface RuntimeHostCatalogPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: 'builtin' | 'third-party';
  readonly platform: 'openclaw' | 'matchaclaw';
  readonly category: string;
  readonly description?: string;
  readonly companionSkillSlugs?: readonly string[];
}

export interface RuntimeHostExecutionState {
  readonly enabledPluginIds: readonly string[];
}

export const DEFAULT_ENABLED_PLUGIN_IDS: readonly string[] = [];

export function normalizePluginIds(ids: readonly string[]): string[] {
  return Array.from(new Set(
    ids
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  ));
}
