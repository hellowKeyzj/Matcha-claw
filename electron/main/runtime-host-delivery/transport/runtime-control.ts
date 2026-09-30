import type { CallReceipt } from '../../../../src/types/call-log';
import { decodeCallReceipt } from '../../../../src/types/call-log/receipt';
import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { hasExactKeys, isBoundedText, isRecord, sendLoopbackJson } from './client';

const RUNTIME_CONTROL_UNAVAILABLE = { success: false, error: 'Runtime control is unavailable' } as const;

export type RuntimeEndpointAddress = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: string;
  runtimeInstanceId: string;
}>;

export const OPEN_CLAW_RUNTIME_ENDPOINT: RuntimeEndpointAddress = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

export const MATCHA_AGENT_RUNTIME_ENDPOINT: RuntimeEndpointAddress = {
  kind: 'native-runtime',
  runtimeAdapterId: 'matcha-agent',
  runtimeInstanceId: 'local',
} as const;

export type RuntimeLifecycle =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'waitingToRestart'
  | 'failed'
  | 'shutDown';

export type RuntimeStateProjection = Readonly<{
  lifecycle: RuntimeLifecycle;
  failure?: string;
  startupDiagnostic?: string;
}>;

export type RuntimeLifecycleResponse = Readonly<{ result: RuntimeStateProjection }>;
export type RuntimeLogEntry = Readonly<{ source: string; line: string }>;
export type RuntimeLogsResponse = Readonly<{
  result: Readonly<{
    entries: readonly RuntimeLogEntry[];
    cursor: number;
    reset: boolean;
    truncated: boolean;
    lifecycleTailEvicted: boolean;
  }>;
}>;
export type RuntimeControlReadyResponse = Readonly<{
  ready: boolean;
  phase: 'ready' | 'starting' | 'unavailable';
  retryable: boolean;
}>;
export type RuntimeGatewayHealthResponse = Readonly<{
  result: Readonly<{
    ok: boolean;
    timestampMs: number;
    durationMs: number;
    channelCount: number;
    agentCount: number;
    sessionCount: number;
  }>;
}>;
export type RuntimeGatewayStatusResponse = Readonly<{
  result: Readonly<{
    sessionCount: number;
    channelCount: number;
    heartbeatEnabled: boolean;
  }>;
}>;
export type RuntimeControlUiUrlResponse = Readonly<{
  result: Readonly<{ url: string }>;
}>;

export type RuntimeControlTransportResponse<T, S extends 200 | 202 = 200> =
  | Readonly<{ status: S; body: T }>
  | Readonly<{ status: 400 | 401 | 422 | 500 | 503; body: typeof RUNTIME_CONTROL_UNAVAILABLE }>;

export interface RuntimeControlTransport {
  lifecycleStatus(endpoint?: RuntimeEndpointAddress): Promise<RuntimeControlTransportResponse<RuntimeLifecycleResponse>>;
  lifecycleStart(endpoint?: RuntimeEndpointAddress): Promise<RuntimeControlTransportResponse<CallReceipt, 202>>;
  lifecycleStop(endpoint?: RuntimeEndpointAddress): Promise<RuntimeControlTransportResponse<CallReceipt, 202>>;
  lifecycleRestart(endpoint?: RuntimeEndpointAddress): Promise<RuntimeControlTransportResponse<CallReceipt, 202>>;
  logs(input?: Readonly<{ endpoint?: RuntimeEndpointAddress; cursor?: number }>): Promise<RuntimeControlTransportResponse<RuntimeLogsResponse>>;
  controlReady(input?: Readonly<{ endpoint?: RuntimeEndpointAddress; timeoutMs?: number }>): Promise<RuntimeControlTransportResponse<RuntimeControlReadyResponse>>;
  gatewayHealth(input?: Readonly<{ endpoint?: RuntimeEndpointAddress; probe?: boolean }>): Promise<RuntimeControlTransportResponse<RuntimeGatewayHealthResponse>>;
  gatewayStatus(input?: Readonly<{ endpoint?: RuntimeEndpointAddress; includeChannelSummary?: boolean }>): Promise<RuntimeControlTransportResponse<RuntimeGatewayStatusResponse>>;
  controlUiUrl(endpoint?: RuntimeEndpointAddress): Promise<RuntimeControlTransportResponse<RuntimeControlUiUrlResponse>>;
}

type RuntimeControlOperation = Readonly<{
  path: string;
  scope: 'runtime-control:read' | 'runtime-control:write';
  capability: string;
  subject: string;
}>;

const operations = {
  lifecycleStatus: {
    path: '/api/runtime-control/lifecycle/status',
    scope: 'runtime-control:read',
    capability: 'runtime.lifecycle.status',
    subject: 'runtime-lifecycle-status',
  },
  lifecycleStart: {
    path: '/api/runtime-control/lifecycle/start',
    scope: 'runtime-control:write',
    capability: 'runtime.lifecycle.start',
    subject: 'runtime-lifecycle-start',
  },
  lifecycleStop: {
    path: '/api/runtime-control/lifecycle/stop',
    scope: 'runtime-control:write',
    capability: 'runtime.lifecycle.stop',
    subject: 'runtime-lifecycle-stop',
  },
  lifecycleRestart: {
    path: '/api/runtime-control/lifecycle/restart',
    scope: 'runtime-control:write',
    capability: 'runtime.lifecycle.restart',
    subject: 'runtime-lifecycle-restart',
  },
  logs: {
    path: '/api/runtime-control/logs',
    scope: 'runtime-control:read',
    capability: 'runtime.logs',
    subject: 'runtime-logs',
  },
  controlReady: {
    path: '/api/runtime-control/control/ready',
    scope: 'runtime-control:read',
    capability: 'runtime.control.ready',
    subject: 'runtime-control-ready',
  },
  gatewayHealth: {
    path: '/api/runtime-control/gateway/health',
    scope: 'runtime-control:read',
    capability: 'runtime.gateway.health',
    subject: 'runtime-gateway-health',
  },
  gatewayStatus: {
    path: '/api/runtime-control/gateway/status',
    scope: 'runtime-control:read',
    capability: 'runtime.gateway.status',
    subject: 'runtime-gateway-status',
  },
  controlUiUrl: {
    path: '/api/runtime-control/control-ui/url',
    scope: 'runtime-control:read',
    capability: 'runtime.control-ui.url',
    subject: 'runtime-control-ui-url',
  },
} satisfies Record<string, RuntimeControlOperation>;

export function createRuntimeControlTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): RuntimeControlTransport {
  const send = async <T, S extends 200 | 202>(
    operation: RuntimeControlOperation,
    body: unknown,
    validate: (value: unknown) => value is T,
    status: S,
    timeoutMs?: number,
  ): Promise<RuntimeControlTransportResponse<T, S>> => {
    const response = await sendLoopbackJson({
      port: runtimeHostTransportPort,
      path: operation.path,
      issuer,
      decision: {
        endpoint: operation.path,
        scope: operation.scope,
        capability: operation.capability,
        subject: operation.subject,
      },
      method: 'POST',
      fetcher,
      body,
      timeoutMs,
    });
    if (response?.status === status && validate(response.body)) return { status, body: response.body };
    return { status: response?.status === 400 || response?.status === 401 || response?.status === 422 || response?.status === 500 ? response.status : 503, body: RUNTIME_CONTROL_UNAVAILABLE };
  };

  return {
    lifecycleStatus(endpoint = OPEN_CLAW_RUNTIME_ENDPOINT) {
      return send(operations.lifecycleStatus, { endpoint }, isRuntimeLifecycleResponse, 200);
    },
    lifecycleStart(endpoint = OPEN_CLAW_RUNTIME_ENDPOINT) {
      return send(operations.lifecycleStart, { endpoint }, isRuntimeControlCallReceipt, 202);
    },
    lifecycleStop(endpoint = OPEN_CLAW_RUNTIME_ENDPOINT) {
      return send(operations.lifecycleStop, { endpoint }, isRuntimeControlCallReceipt, 202);
    },
    lifecycleRestart(endpoint = OPEN_CLAW_RUNTIME_ENDPOINT) {
      return send(operations.lifecycleRestart, { endpoint }, isRuntimeControlCallReceipt, 202);
    },
    logs(input) {
      return send(operations.logs, body(input?.endpoint, { cursor: input?.cursor }), isRuntimeLogsResponse, 200);
    },
    controlReady(input) {
      return send(
        operations.controlReady,
        { endpoint: input?.endpoint ?? OPEN_CLAW_RUNTIME_ENDPOINT },
        isRuntimeControlReadyResponse,
        200,
        input?.timeoutMs,
      );
    },
    gatewayHealth(input) {
      return send(operations.gatewayHealth, body(input?.endpoint, { probe: input?.probe }), isRuntimeGatewayHealthResponse, 200);
    },
    gatewayStatus(input) {
      return send(operations.gatewayStatus, body(input?.endpoint, { includeChannelSummary: input?.includeChannelSummary }), isRuntimeGatewayStatusResponse, 200);
    },
    controlUiUrl(endpoint = OPEN_CLAW_RUNTIME_ENDPOINT) {
      return send(operations.controlUiUrl, { endpoint }, isRuntimeControlUiUrlResponse, 200);
    },
  };
}

function body(endpoint: RuntimeEndpointAddress | undefined, extra: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({ endpoint: endpoint ?? OPEN_CLAW_RUNTIME_ENDPOINT, ...extra }).filter(([, value]) => value !== undefined),
  );
}

function isRuntimeControlCallReceipt(value: unknown): value is CallReceipt {
  try {
    decodeCallReceipt(value);
    return true;
  } catch {
    return false;
  }
}

function isRuntimeLifecycleResponse(value: unknown): value is RuntimeLifecycleResponse {
  return isRecord(value)
    && hasExactKeys(value, ['result'])
    && isRuntimeStateProjection(value.result);
}

function isRuntimeStateProjection(value: unknown): value is RuntimeStateProjection {
  return isRecord(value)
    && hasOnlyKeys(value, ['lifecycle', 'failure', 'startupDiagnostic'])
    && isRuntimeLifecycle(value.lifecycle)
    && (value.failure === undefined || isBoundedText(value.failure, 128))
    && (value.startupDiagnostic === undefined || isBoundedText(value.startupDiagnostic, 128));
}

function isRuntimeLogsResponse(value: unknown): value is RuntimeLogsResponse {
  return isRecord(value)
    && hasExactKeys(value, ['result'])
    && isRecord(value.result)
    && hasExactKeys(value.result, ['entries', 'cursor', 'reset', 'truncated', 'lifecycleTailEvicted'])
    && Array.isArray(value.result.entries)
    && value.result.entries.every(isRuntimeLogEntry)
    && Number.isSafeInteger(value.result.cursor)
    && typeof value.result.reset === 'boolean'
    && typeof value.result.truncated === 'boolean'
    && typeof value.result.lifecycleTailEvicted === 'boolean';
}

function isRuntimeLogEntry(value: unknown): value is RuntimeLogEntry {
  return isRecord(value)
    && hasExactKeys(value, ['source', 'line'])
    && isBoundedText(value.source, 64)
    && isBoundedText(value.line, 16_384);
}

function isRuntimeControlReadyResponse(value: unknown): value is RuntimeControlReadyResponse {
  return isRecord(value)
    && hasExactKeys(value, ['ready', 'phase', 'retryable'])
    && typeof value.ready === 'boolean'
    && (value.phase === 'ready' || value.phase === 'starting' || value.phase === 'unavailable')
    && typeof value.retryable === 'boolean';
}

function isRuntimeGatewayHealthResponse(value: unknown): value is RuntimeGatewayHealthResponse {
  return isRecord(value)
    && hasExactKeys(value, ['result'])
    && isRecord(value.result)
    && hasExactKeys(value.result, ['ok', 'timestampMs', 'durationMs', 'channelCount', 'agentCount', 'sessionCount'])
    && typeof value.result.ok === 'boolean'
    && Number.isSafeInteger(value.result.timestampMs)
    && Number.isSafeInteger(value.result.durationMs)
    && Number.isSafeInteger(value.result.channelCount)
    && Number.isSafeInteger(value.result.agentCount)
    && Number.isSafeInteger(value.result.sessionCount);
}

function isRuntimeGatewayStatusResponse(value: unknown): value is RuntimeGatewayStatusResponse {
  return isRecord(value)
    && hasExactKeys(value, ['result'])
    && isRecord(value.result)
    && hasExactKeys(value.result, ['sessionCount', 'channelCount', 'heartbeatEnabled'])
    && Number.isSafeInteger(value.result.sessionCount)
    && Number.isSafeInteger(value.result.channelCount)
    && typeof value.result.heartbeatEnabled === 'boolean';
}

function isRuntimeControlUiUrlResponse(value: unknown): value is RuntimeControlUiUrlResponse {
  return isRecord(value)
    && hasExactKeys(value, ['result'])
    && isRecord(value.result)
    && hasExactKeys(value.result, ['url'])
    && isBoundedText(value.result.url, 4096);
}

function isRuntimeLifecycle(value: unknown): value is RuntimeLifecycle {
  return value === 'unavailable'
    || value === 'idle'
    || value === 'starting'
    || value === 'running'
    || value === 'stopping'
    || value === 'waitingToRestart'
    || value === 'failed'
    || value === 'shutDown';
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
