import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from '../client';
import { decodeSessionView, sameSessionIdentity, type SessionIdentity } from './session-contract';
import { isBoundedId, isTimelineIdentity, isTimelineScope } from './timeline-contract';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, traceHeader } from './trace';
const UNAVAILABLE = { success: false, error: 'Session timeline is unavailable' } as const;

type Direction = 'latest' | 'older' | 'newer';

type TimelineRequest = Readonly<{
  id: 'session.management';
  operationId: 'sessions.load' | 'sessions.window';
  scope: Readonly<{ kind: 'session'; identity: SessionIdentity }>;
  target: Readonly<{ kind: 'session'; identity: SessionIdentity }>;
  input: Readonly<{
    sessionKey: string;
    sessionIdentity: SessionIdentity;
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
      logSessionTrace('electron.timeline.rejected', traceId, () => ({ operation }));
      return { status: 503, body: UNAVAILABLE };
    }
    const endpoint = operation === 'sessions.load' ? '/api/sessions/load' : '/api/sessions/window';
    const startedAt = traceId && isSessionTraceEnabled() ? Date.now() : 0;
    logSessionTrace('electron.timeline.request', traceId, () => ({
      operation,
      adapter: request.input.sessionIdentity.endpoint.runtimeAdapterId,
      sessionKey: summarizeIdentifier(request.input.sessionKey),
      endpointSessionId: summarizeIdentifier(request.input.endpointSessionId),
      limit: request.input.limit ?? null,
      mode: request.input.mode ?? null,
    }));
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
      logSessionTrace('electron.timeline.failure', traceId, () => ({
        operation,
        elapsedMs: Date.now() - startedAt,
      }));
      return { status: 503, body: UNAVAILABLE };
    }
    const body = response.body;
    const decodeStartedAt = traceId && isSessionTraceEnabled() ? performance.now() : null;
    const view = response.status === 200 ? decodeSessionView(body) : null;
    const decodeElapsedMs = decodeStartedAt === null ? null : performance.now() - decodeStartedAt;
    logSessionTrace('electron.timeline.response', traceId, () => ({
      operation,
      status: response.status,
      contract: view ? 'valid' : isUnavailable(body) ? 'unavailable' : 'invalid',
      elapsedMs: Date.now() - startedAt,
      decodeElapsedMs,
    }));
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
    || !isTimelineScope(value.scope) || !isTimelineScope(value.target) || !isInput(value.input, operation)) return false;
  return sameSessionIdentity(value.scope.identity, value.target.identity)
    && sameSessionIdentity(value.scope.identity, value.input.sessionIdentity)
    && value.input.sessionKey === value.scope.identity.sessionKey;
}

function isInput(value: unknown, operation: TimelineRequest['operationId']): value is TimelineRequest['input'] {
  if (!isRecord(value) || !isTimelineIdentity(value.sessionIdentity) || typeof value.sessionKey !== 'string' || !value.sessionKey) return false;
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

function isUnavailable(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['success', 'error'])
    && value.success === false && value.error === UNAVAILABLE.error;
}
