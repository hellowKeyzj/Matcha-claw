import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = {
  success: false,
  error: 'Session catalog is unavailable',
} as const;

type SessionIdentity = Readonly<{
  endpoint: Readonly<{
    kind: 'native-runtime';
    runtimeAdapterId: 'openclaw';
    runtimeInstanceId: 'local';
  }>;
  agentId: string;
  sessionKey: string;
}>;

type SessionSummary = Readonly<{
  key: string;
  agentId: string;
  sessionIdentity: SessionIdentity;
  kind: 'main' | 'session';
  endpointSessionId?: string;
  updatedAt?: number;
}>;

type SessionListResponse = Readonly<{
  sessions: readonly SessionSummary[];
}>;

type SessionListRequest = Readonly<{
  id: 'session.management';
  operationId: 'sessions.list';
  scope: Readonly<{
    kind: 'runtime-instance';
    endpoint: Readonly<{
      kind: 'native-runtime';
      runtimeAdapterId: 'openclaw';
      runtimeInstanceId: 'local';
    }>;
  }>;
  target: Readonly<{ kind: 'runtime-endpoint' }>;
  input: Readonly<{
    endpoint: Readonly<{
      kind: 'native-runtime';
      runtimeAdapterId: 'openclaw';
      runtimeInstanceId: 'local';
    }>;
  }>;
}>;

export type SessionListTransportResponse = Readonly<{
  status: 200 | 503;
  body: unknown;
}>;

export interface SessionListTransport {
  list(request: unknown): Promise<SessionListTransportResponse>;
}

export function createSessionListTransport(
  issuer: RuntimeHostDeliveryIssuer,
  sessionTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionListTransport {
  const url = `http://127.0.0.1:${sessionTransportPort}/api/sessions`;
  return {
    async list(request: unknown): Promise<SessionListTransportResponse> {
      if (!isSessionListRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/sessions',
              scope: 'sessions:read',
              capability: 'sessions.list',
              subject: 'session-catalog',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isSessionListResponse(body)) {
          return { status: 200, body };
        }
        if (response.status === 503 && isUnavailable(body)) {
          return { status: 503, body: UNAVAILABLE };
        }
      } catch {
        // The public contract deliberately suppresses transport details.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isSessionListResponse(value: unknown): value is SessionListResponse {
  return isRecord(value)
    && hasExactKeys(value, ['sessions'])
    && Array.isArray(value.sessions)
    && value.sessions.every(isSessionSummary);
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (!isRecord(value)
    || !Object.hasOwn(value, 'key')
    || !Object.hasOwn(value, 'agentId')
    || !Object.hasOwn(value, 'sessionIdentity')
    || !Object.hasOwn(value, 'kind')
    || !Object.keys(value).every((key) => ['key', 'agentId', 'sessionIdentity', 'kind', 'endpointSessionId', 'updatedAt'].includes(key))
    || typeof value.key !== 'string'
    || typeof value.agentId !== 'string'
    || !isSessionIdentity(value.sessionIdentity)
    || typeof value.kind !== 'string'
    || !['main', 'session'].includes(value.kind)) {
    return false;
  }
  return (value.endpointSessionId === undefined || typeof value.endpointSessionId === 'string')
    && (value.updatedAt === undefined || typeof value.updatedAt === 'number')
    && value.sessionIdentity.agentId === value.agentId
    && value.sessionIdentity.sessionKey === value.key;
}

function isSessionIdentity(value: unknown): value is SessionIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'agentId', 'sessionKey'])
    && isEndpoint(value.endpoint)
    && typeof value.agentId === 'string'
    && typeof value.sessionKey === 'string';
}

function isUnavailable(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && value.error === UNAVAILABLE.error;
}

function isSessionListRequest(value: unknown): value is SessionListRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])) {
    return false;
  }
  return value.id === 'session.management'
    && value.operationId === 'sessions.list'
    && isScope(value.scope)
    && isTarget(value.target)
    && isInput(value.input);
}

function isScope(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint'])
    && value.kind === 'runtime-instance'
    && isEndpoint(value.endpoint);
}

function isTarget(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind']) && value.kind === 'runtime-endpoint';
}

function isInput(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['endpoint']) && isEndpoint(value.endpoint);
}

function isEndpoint(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && value.runtimeAdapterId === 'openclaw'
    && value.runtimeInstanceId === 'local';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
