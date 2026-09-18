import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const ROUTE = '/api/sessions/delete';
const UNAVAILABLE = {
  success: false,
  error: 'Session delete is unavailable',
} as const;

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw';
  runtimeInstanceId: 'local';
}>;

type SessionIdentity = Readonly<{
  endpoint: Endpoint;
  agentId: string;
  sessionKey: string;
}>;

export type SessionDeleteRequest = Readonly<{
  id: 'session.management';
  operationId: 'sessions.delete';
  scope: Readonly<{
    kind: 'session';
    identity: SessionIdentity;
  }>;
  target: Readonly<{
    kind: 'session';
    identity: SessionIdentity;
  }>;
  input: Readonly<{
    sessionIdentity: SessionIdentity;
  }>;
}>;

export type SessionDeleteResponse = Readonly<{
  outcome: 'succeeded' | 'target_rejected' | 'unknown';
}>;

export type SessionDeleteTransportResponse = Readonly<{
  status: 200 | 503;
  body: SessionDeleteResponse | typeof UNAVAILABLE;
}>;

export interface SessionDeleteTransport {
  delete(request: unknown): Promise<SessionDeleteTransportResponse>;
}

export function createSessionDeleteTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionDeleteTransport {
  return {
    async delete(request: unknown): Promise<SessionDeleteTransportResponse> {
      if (!isSessionDeleteRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE,
        issuer,
        decision: {
          endpoint: ROUTE,
          scope: 'sessions:write',
          capability: 'sessions.delete',
          subject: 'session-delete',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isSessionDeleteResponse(response.body)) {
        return { status: 200, body: response.body };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isSessionDeleteResponse(value: unknown): value is SessionDeleteResponse {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'succeeded'
      || value.outcome === 'target_rejected'
      || value.outcome === 'unknown');
}

function isSessionDeleteRequest(value: unknown): value is SessionDeleteRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.management'
    || value.operationId !== 'sessions.delete'
    || !isSessionScope(value.scope)
    || !isSessionTarget(value.target)
    || !isSessionDeleteInput(value.input)
    || !sameIdentity(value.scope.identity, value.target.identity)
    || !sameIdentity(value.scope.identity, value.input.sessionIdentity)) {
    return false;
  }
  return true;
}

function isSessionScope(value: unknown): value is SessionDeleteRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session'
    && isSessionIdentity(value.identity);
}

function isSessionTarget(value: unknown): value is SessionDeleteRequest['target'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session'
    && isSessionIdentity(value.identity);
}

function isSessionDeleteInput(value: unknown): value is SessionDeleteRequest['input'] {
  return isRecord(value)
    && hasExactKeys(value, ['sessionIdentity'])
    && isSessionIdentity(value.sessionIdentity);
}

function isSessionIdentity(value: unknown): value is SessionIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'agentId', 'sessionKey'])
    && isEndpoint(value.endpoint)
    && typeof value.agentId === 'string'
    && value.agentId.length > 0
    && typeof value.sessionKey === 'string'
    && value.sessionKey.length > 0;
}

function sameIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
  return left.agentId === right.agentId
    && left.sessionKey === right.sessionKey
    && left.endpoint.kind === right.endpoint.kind
    && left.endpoint.runtimeAdapterId === right.endpoint.runtimeAdapterId
    && left.endpoint.runtimeInstanceId === right.endpoint.runtimeInstanceId;
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && value.runtimeAdapterId === 'openclaw'
    && value.runtimeInstanceId === 'local';
}
