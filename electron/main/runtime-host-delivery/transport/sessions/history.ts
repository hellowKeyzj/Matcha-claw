import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from '../client';

const ROUTE_PATH = '/api/sessions/history';
const UNAVAILABLE = {
  success: false,
  error: 'Session history is unavailable',
} as const;

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

type SessionIdentity = Readonly<{ endpoint: Endpoint; agentId: string; sessionKey: string }>;

type SessionHistoryRequest = Readonly<{
  id: 'session.management';
  operationId: 'sessions.history';
  scope: Readonly<{ kind: 'session'; identity: SessionIdentity }>;
  target: Readonly<{ kind: 'session'; identity: SessionIdentity }>;
  input: Readonly<{
    sessionKey: string;
    sessionIdentity: SessionIdentity;
    endpointSessionId?: string;
    limit?: number;
  }>;
}>;

type SessionHistoryResponse = Readonly<{
  messages: readonly Readonly<{
    role: 'user' | 'assistant';
    text: string;
  }>[];
}>;

export type SessionHistoryTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: SessionHistoryResponse | typeof UNAVAILABLE;
}>;

export interface SessionHistoryTransport {
  read(request: unknown): Promise<SessionHistoryTransportResponse>;
}

export function createSessionHistoryTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionHistoryTransport {
  return {
    async read(request: unknown): Promise<SessionHistoryTransportResponse> {
      if (!isRequest(request)) return { status: 400, body: UNAVAILABLE };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE_PATH,
        issuer,
        decision: {
          endpoint: ROUTE_PATH,
          scope: 'sessions:read',
          capability: 'session.management',
          subject: 'session-history',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isResponse(response.body)) return { status: 200, body: response.body };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is SessionHistoryRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.management'
    || value.operationId !== 'sessions.history'
    || !isScope(value.scope)
    || !isTarget(value.target)
    || !isInput(value.input)) return false;
  return sameIdentity(value.scope.identity, value.target.identity)
    && sameIdentity(value.scope.identity, value.input.sessionIdentity)
    && value.input.sessionKey === value.scope.identity.sessionKey;
}

function isScope(value: unknown): value is SessionHistoryRequest['scope'] {
  return isRecord(value) && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session'
    && isIdentity(value.identity);
}

function isTarget(value: unknown): value is SessionHistoryRequest['target'] {
  return isRecord(value) && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session'
    && isIdentity(value.identity);
}

function isInput(value: unknown): value is SessionHistoryRequest['input'] {
  if (!isRecord(value)
    || !Object.keys(value).every((key) => ['sessionKey', 'sessionIdentity', 'endpointSessionId', 'limit'].includes(key))
    || !isBoundedId(value.sessionKey)
    || !isIdentity(value.sessionIdentity)) return false;
  return (value.endpointSessionId === undefined || isBoundedId(value.endpointSessionId))
    && (value.limit === undefined || isSafeNonNegativeInteger(value.limit));
}

function isIdentity(value: unknown): value is SessionIdentity {
  return isRecord(value) && hasExactKeys(value, ['endpoint', 'agentId', 'sessionKey'])
    && isEndpoint(value.endpoint)
    && isBoundedId(value.agentId)
    && isBoundedId(value.sessionKey);
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value) && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

function sameIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
  return left.agentId === right.agentId
    && left.sessionKey === right.sessionKey
    && left.endpoint.runtimeAdapterId === right.endpoint.runtimeAdapterId
    && left.endpoint.runtimeInstanceId === right.endpoint.runtimeInstanceId;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !value.includes('\0');
}

function isResponse(value: unknown): value is SessionHistoryResponse {
  return isRecord(value)
    && hasExactKeys(value, ['messages'])
    && Array.isArray(value.messages)
    && value.messages.every((message) => isRecord(message)
      && hasExactKeys(message, ['role', 'text'])
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.text === 'string');
}
