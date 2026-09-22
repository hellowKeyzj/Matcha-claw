import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const ROUTE = '/api/sessions';
const UNAVAILABLE = {
  success: false,
  error: 'Session catalog is unavailable',
} as const;

type RuntimeEndpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

type SessionIdentity = Readonly<{
  endpoint: RuntimeEndpoint;
  agentId: string;
  sessionKey: string;
}>;

type SessionSummary = Readonly<{
  key: string;
  agentId: string;
  sessionIdentity: SessionIdentity;
  kind: 'main' | 'session' | 'automation';
  preferred?: boolean;
  endpointSessionId?: string;
  model?: string;
  protocolId?: string;
  runtimeEndpointId?: string;
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
    endpoint: RuntimeEndpoint;
  }>;
  target: Readonly<{ kind: 'runtime-endpoint' }>;
  input: Readonly<{
    endpoint: RuntimeEndpoint;
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
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionListTransport {
  return {
    async list(request: unknown): Promise<SessionListTransportResponse> {
      if (!isSessionListRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE,
        issuer,
        decision: {
          endpoint: ROUTE,
          scope: 'sessions:read',
          capability: 'sessions.list',
          subject: 'session-catalog',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isSessionListResponse(response.body)) {
        return { status: 200, body: response.body };
      }
      if (response?.status === 503 && isUnavailable(response.body)) {
        return { status: 503, body: UNAVAILABLE };
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
    || !Object.keys(value).every((key) => [
      'key',
      'agentId',
      'sessionIdentity',
      'kind',
      'preferred',
      'endpointSessionId',
      'model',
      'protocolId',
      'runtimeEndpointId',
      'updatedAt',
    ].includes(key))
    || typeof value.key !== 'string'
    || typeof value.agentId !== 'string'
    || !isSessionIdentity(value.sessionIdentity)
    || typeof value.kind !== 'string'
    || !['main', 'session', 'automation'].includes(value.kind)) {
    return false;
  }
  return (value.preferred === undefined || typeof value.preferred === 'boolean')
    && (value.endpointSessionId === undefined || typeof value.endpointSessionId === 'string')
    && (value.model === undefined || typeof value.model === 'string')
    && (value.protocolId === undefined || typeof value.protocolId === 'string')
    && (value.runtimeEndpointId === undefined || typeof value.runtimeEndpointId === 'string')
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
    && isInput(value.input)
    && sameEndpoint(value.scope.endpoint, value.input.endpoint);
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

function isEndpoint(value: unknown): value is RuntimeEndpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

function sameEndpoint(left: RuntimeEndpoint, right: RuntimeEndpoint): boolean {
  return left.kind === right.kind
    && left.runtimeAdapterId === right.runtimeAdapterId
    && left.runtimeInstanceId === right.runtimeInstanceId;
}
