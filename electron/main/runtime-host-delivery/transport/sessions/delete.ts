import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
import { isSessionIdentity, sameSessionIdentity, type SessionIdentity } from './session-contract';

const ROUTE = '/api/sessions/delete';
const UNAVAILABLE = {
  success: false,
  error: 'Session delete is unavailable',
} as const;

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
    || !isSessionScope(value.target)
    || !isSessionDeleteInput(value.input)
    || !sameSessionIdentity(value.scope.identity, value.target.identity)
    || !sameSessionIdentity(value.scope.identity, value.input.sessionIdentity)) {
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

function isSessionDeleteInput(value: unknown): value is SessionDeleteRequest['input'] {
  return isRecord(value)
    && hasExactKeys(value, ['sessionIdentity'])
    && isSessionIdentity(value.sessionIdentity);
}
