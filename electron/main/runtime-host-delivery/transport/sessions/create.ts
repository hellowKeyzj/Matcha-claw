import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';
import { decodeSessionView, type SessionView } from './session-contract';
import { logSessionTrace, summarizeIdentifier, traceHeader } from './trace';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = {
  success: false,
  error: 'Session create is unavailable',
} as const;

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

export type SessionCreateRequest = Readonly<{
  id: 'session.prompt';
  operationId: 'sessions.create';
  scope: Readonly<{
    kind: 'agent';
    endpoint: Endpoint;
    agentId: string;
  }>;
  target: Readonly<{
    kind: 'agent';
    agentId: string;
  }>;
  input: Readonly<{
    endpoint: Endpoint;
    agentId: string;
    endpointSessionId?: string;
  }>;
}>;

export type SessionCreateResponse = SessionView | Readonly<{
  outcome: 'target_rejected' | 'unknown';
}>;

export type SessionCreateTransportResponse = Readonly<{
  status: 200 | 503;
  body: SessionCreateResponse | typeof UNAVAILABLE;
}>;

export interface SessionCreateTransport {
  create(request: unknown, traceId?: string | null): Promise<SessionCreateTransportResponse>;
}

export function createSessionCreateTransport(
  issuer: RuntimeHostDeliveryIssuer,
  sessionTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionCreateTransport {
  const url = `http://127.0.0.1:${sessionTransportPort}/api/sessions/create`;
  return {
    async create(request: unknown, traceId?: string | null): Promise<SessionCreateTransportResponse> {
      if (!isSessionCreateRequest(request)) {
        logSessionTrace('electron.create.rejected', traceId, {});
        return { status: 503, body: UNAVAILABLE };
      }
      const startedAt = Date.now();
      logSessionTrace('electron.create.request', traceId, {
        adapter: request.input.endpoint.runtimeAdapterId,
        agentId: summarizeIdentifier(request.input.agentId),
        endpointSessionId: summarizeIdentifier(request.input.endpointSessionId),
      });
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/sessions/create',
              scope: 'sessions:write',
              capability: 'session.prompt',
              subject: 'session-create',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
            ...traceHeader(traceId),
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        logSessionTrace('electron.create.response', traceId, {
          status: response.status,
          contract: isSessionCreateResponse(body) ? 'valid' : 'invalid',
          elapsedMs: Date.now() - startedAt,
        });
        if (response.status === 200 && isSessionCreateResponse(body)) {
          return { status: 200, body };
        }
      } catch {
        logSessionTrace('electron.create.failure', traceId, {
          elapsedMs: Date.now() - startedAt,
        });
        // The public contract deliberately suppresses transport details.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isSessionCreateResponse(value: unknown): value is SessionCreateResponse {
  const view = decodeSessionView(value);
  if (view) return true;
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'target_rejected' || value.outcome === 'unknown');
}

function isSessionCreateRequest(value: unknown): value is SessionCreateRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'session.prompt'
    && value.operationId === 'sessions.create'
    && isScope(value.scope)
    && isTarget(value.target)
    && isInput(value.input)
    && value.scope.agentId === value.target.agentId
    && value.scope.agentId === value.input.agentId
    && sameEndpoint(value.scope.endpoint, value.input.endpoint);
}

function isScope(value: unknown): value is SessionCreateRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'agentId'])
    && value.kind === 'agent'
    && isEndpoint(value.endpoint)
    && isNonEmptyString(value.agentId);
}

function isTarget(value: unknown): value is SessionCreateRequest['target'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'agentId'])
    && value.kind === 'agent'
    && isNonEmptyString(value.agentId);
}

function isInput(value: unknown): value is SessionCreateRequest['input'] {
  return isRecord(value)
    && (hasExactKeys(value, ['endpoint', 'agentId'])
      || hasExactKeys(value, ['endpoint', 'agentId', 'endpointSessionId']))
    && isEndpoint(value.endpoint)
    && isNonEmptyString(value.agentId)
    && (value.endpointSessionId === undefined || isNonEmptyString(value.endpointSessionId));
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

function sameEndpoint(left: Endpoint, right: Endpoint): boolean {
  return left.kind === right.kind
    && left.runtimeAdapterId === right.runtimeAdapterId
    && left.runtimeInstanceId === right.runtimeInstanceId;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
