import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from '../client';
import { decodeSessionView } from './session-contract';
import { logSessionTrace, summarizeIdentifier, traceHeader } from './trace';
const UNAVAILABLE = { success: false, error: 'Session timeline is unavailable' } as const;

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

type Identity = Readonly<{ endpoint: Endpoint; agentId: string; sessionKey: string }>;
type Direction = 'latest' | 'older' | 'newer';

type TimelineRequest = Readonly<{
  id: 'session.management';
  operationId: 'sessions.load' | 'sessions.window';
  scope: Readonly<{ kind: 'session'; identity: Identity }>;
  target: Readonly<{ kind: 'session'; identity: Identity }>;
  input: Readonly<{
    sessionKey: string;
    sessionIdentity: Identity;
    endpointSessionId?: string;
    mode?: Direction;
    limit?: number;
    offset?: number;
    includeCanonical?: boolean;
  }>;
}>;

export type SessionTimelineTransportResponse = Readonly<{ status: 200 | 503; body: unknown }>;

export interface SessionTimelineTransport {
  load(request: unknown, traceId?: string | null): Promise<SessionTimelineTransportResponse>;
  window(request: unknown, traceId?: string | null): Promise<SessionTimelineTransportResponse>;
}

export function createSessionTimelineTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionTimelineTransport {
  const execute = async (request: unknown, operation: TimelineRequest['operationId'], traceId?: string | null): Promise<SessionTimelineTransportResponse> => {
    if (!isRequest(request, operation)) {
      logSessionTrace('electron.timeline.rejected', traceId, { operation });
      return { status: 503, body: UNAVAILABLE };
    }
    const endpoint = operation === 'sessions.load' ? '/api/sessions/load' : '/api/sessions/window';
    const startedAt = Date.now();
    logSessionTrace('electron.timeline.request', traceId, {
      operation,
      adapter: request.input.sessionIdentity.endpoint.runtimeAdapterId,
      sessionKey: summarizeIdentifier(request.input.sessionKey),
      endpointSessionId: summarizeIdentifier(request.input.endpointSessionId),
      limit: request.input.limit ?? null,
      mode: request.input.mode ?? null,
    });
    const response = await sendLoopbackJson({
      port: runtimeHostTransportPort,
      path: endpoint,
      issuer,
      decision: {
        endpoint,
        scope: 'sessions:read',
        capability: 'session.management',
        subject: 'session-timeline',
      },
      method: 'POST',
      fetcher,
      body: request,
      headers: traceHeader(traceId),
    });
    if (response === null) {
      logSessionTrace('electron.timeline.failure', traceId, {
        operation,
        elapsedMs: Date.now() - startedAt,
      });
      return { status: 503, body: UNAVAILABLE };
    }
    const body = response.body;
    const view = response.status === 200 ? decodeSessionView(body) : null;
    logSessionTrace('electron.timeline.response', traceId, {
      operation,
      status: response.status,
      contract: view ? 'valid' : isUnavailable(body) ? 'unavailable' : 'invalid',
      elapsedMs: Date.now() - startedAt,
    });
    if (response.status === 200 && view && view.sessionKey === request.input.sessionKey) {
      return { status: 200, body: view };
    }
    if (response.status === 503 && isUnavailable(body)) return { status: 503, body: UNAVAILABLE };
    return { status: 503, body: UNAVAILABLE };
  };
  return {
    load: async (request, traceId) => await execute(request, 'sessions.load', traceId),
    window: async (request, traceId) => await execute(request, 'sessions.window', traceId),
  };
}

function isRequest(value: unknown, operation: TimelineRequest['operationId']): value is TimelineRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.management' || value.operationId !== operation
    || !isScope(value.scope) || !isTarget(value.target) || !isInput(value.input, operation)) return false;
  return sameIdentity(value.scope.identity, value.target.identity)
    && sameIdentity(value.scope.identity, value.input.sessionIdentity)
    && value.input.sessionKey === value.scope.identity.sessionKey;
}

function isScope(value: unknown): value is { kind: 'session'; identity: Identity } {
  return isRecord(value) && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session' && isIdentity(value.identity);
}

function isTarget(value: unknown): value is { kind: 'session'; identity: Identity } {
  return isRecord(value) && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session' && isIdentity(value.identity);
}

function isInput(value: unknown, operation: TimelineRequest['operationId']): value is TimelineRequest['input'] {
  if (!isRecord(value) || !isIdentity(value.sessionIdentity) || typeof value.sessionKey !== 'string' || !value.sessionKey) return false;
  const allowed = operation === 'sessions.load'
    ? ['sessionKey', 'sessionIdentity', 'endpointSessionId', 'limit']
    : ['sessionKey', 'sessionIdentity', 'endpointSessionId', 'mode', 'limit', 'offset', 'includeCanonical'];
  if (!Object.keys(value).every((key) => allowed.includes(key))) return false;
  if (value.limit !== undefined && (!isSafeNonNegativeInteger(value.limit) || value.limit > 200)) return false;
  if (value.endpointSessionId !== undefined && !isBoundedId(value.endpointSessionId)) return false;
  if (operation === 'sessions.load') {
    return value.mode === undefined && value.offset === undefined && value.includeCanonical === undefined;
  }
  return (value.mode === 'latest' || value.mode === 'older' || value.mode === 'newer')
    && (value.includeCanonical === undefined || typeof value.includeCanonical === 'boolean')
    && (value.mode === 'latest'
      ? value.offset === undefined
      : value.offset === undefined
        || isSafeNonNegativeInteger(value.offset));
}

function isIdentity(value: unknown): value is Identity {
  return isRecord(value) && hasExactKeys(value, ['endpoint', 'agentId', 'sessionKey'])
    && isEndpoint(value.endpoint)
    && isBoundedId(value.agentId)
    && isBoundedId(value.sessionKey);
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value) && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime' && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.agentId === right.agentId && left.sessionKey === right.sessionKey
    && left.endpoint.runtimeAdapterId === right.endpoint.runtimeAdapterId
    && left.endpoint.runtimeInstanceId === right.endpoint.runtimeInstanceId;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 4096
    && value.trim() === value
    && !value.includes('\0');
}

function isUnavailable(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['success', 'error'])
    && value.success === false && value.error === UNAVAILABLE.error;
}
