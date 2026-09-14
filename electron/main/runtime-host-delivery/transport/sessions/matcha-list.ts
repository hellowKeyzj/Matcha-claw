import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = {
  success: false,
  error: 'Matcha session catalog is unavailable',
} as const;

const MATCHA_ENDPOINT = {
  kind: 'native-runtime',
  runtimeAdapterId: 'matcha-agent',
  runtimeInstanceId: 'local',
} as const;

type MatchaSessionListRequest = Readonly<{
  id: 'session.management';
  operationId: 'sessions.list';
  scope: Readonly<{
    kind: 'runtime-instance';
    endpoint: typeof MATCHA_ENDPOINT;
  }>;
  target: Readonly<{
    kind: 'runtime-endpoint';
  }>;
  input: Readonly<{
    endpoint: typeof MATCHA_ENDPOINT;
  }>;
}>;

type MatchaSessionCatalogItem = Readonly<{
  endpoint: typeof MATCHA_ENDPOINT;
  nativeSessionHandle: string;
  updatedAt?: number;
}>;

type MatchaSessionListResponse = Readonly<{
  sessions: readonly MatchaSessionCatalogItem[];
}>;

type SessionListResponse = Readonly<{
  sessions: readonly Readonly<{
    key: string;
    agentId: 'matcha';
    sessionIdentity: Readonly<{
      endpoint: typeof MATCHA_ENDPOINT;
      agentId: 'matcha';
      sessionKey: string;
    }>;
    kind: 'session';
    preferred: false;
    endpointSessionId: string;
    protocolId: 'matcha-agent-app-server';
    runtimeEndpointId: 'matcha-agent-local';
    updatedAt?: number;
  }>[];
}>;

export type MatchaSessionListTransportResponse = Readonly<{
  status: 200 | 503;
  body: unknown;
}>;

export interface MatchaSessionListTransport {
  list(request: unknown): Promise<MatchaSessionListTransportResponse>;
}

export function createMatchaSessionListTransport(
  issuer: RuntimeHostDeliveryIssuer,
  sessionTransportPort: number,
  fetcher: typeof fetch = fetch,
): MatchaSessionListTransport {
  const url = `http://127.0.0.1:${sessionTransportPort}/api/matcha/sessions`;
  return {
    async list(request: unknown): Promise<MatchaSessionListTransportResponse> {
      if (!isMatchaSessionListRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/matcha/sessions',
              scope: 'sessions:read',
              capability: 'sessions.list',
              subject: 'matcha-session-catalog',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isMatchaSessionListResponse(body)) {
          return { status: 200, body: projectMatchaSessionList(body) };
        }
      } catch {
        // The public contract deliberately suppresses transport details.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function projectMatchaSessionList(value: MatchaSessionListResponse): SessionListResponse {
  return {
    sessions: value.sessions.map((session) => ({
      key: `matcha-agent:matcha:${session.nativeSessionHandle}`,
      agentId: 'matcha',
      sessionIdentity: {
        endpoint: MATCHA_ENDPOINT,
        agentId: 'matcha',
        sessionKey: `matcha-agent:matcha:${session.nativeSessionHandle}`,
      },
      kind: 'session',
      preferred: false,
      endpointSessionId: session.nativeSessionHandle,
      protocolId: 'matcha-agent-app-server',
      runtimeEndpointId: 'matcha-agent-local',
      ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
    })),
  };
}

function isMatchaSessionListRequest(value: unknown): value is MatchaSessionListRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'session.management'
    && value.operationId === 'sessions.list'
    && isScope(value.scope)
    && isTarget(value.target)
    && isInput(value.input);
}

function isMatchaSessionListResponse(value: unknown): value is MatchaSessionListResponse {
  return isRecord(value)
    && hasExactKeys(value, ['sessions'])
    && Array.isArray(value.sessions)
    && value.sessions.every(isMatchaSessionCatalogItem);
}

function isMatchaSessionCatalogItem(value: unknown): value is MatchaSessionCatalogItem {
  return isRecord(value)
    && Object.keys(value).every((key) => ['endpoint', 'nativeSessionHandle', 'updatedAt'].includes(key))
    && Object.hasOwn(value, 'endpoint')
    && Object.hasOwn(value, 'nativeSessionHandle')
    && isMatchaEndpoint(value.endpoint)
    && typeof value.nativeSessionHandle === 'string'
    && value.nativeSessionHandle.length > 0
    && (value.updatedAt === undefined || (typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)));
}

function isScope(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint'])
    && value.kind === 'runtime-instance'
    && isMatchaEndpoint(value.endpoint);
}

function isTarget(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind'])
    && value.kind === 'runtime-endpoint';
}

function isInput(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint'])
    && isMatchaEndpoint(value.endpoint);
}

function isMatchaEndpoint(value: unknown): value is typeof MATCHA_ENDPOINT {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === MATCHA_ENDPOINT.kind
    && value.runtimeAdapterId === MATCHA_ENDPOINT.runtimeAdapterId
    && value.runtimeInstanceId === MATCHA_ENDPOINT.runtimeInstanceId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
