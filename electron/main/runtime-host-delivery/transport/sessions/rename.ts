import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
import { isOpenClawSessionIdentity, isOpenClawSessionScope, type OpenClawSessionIdentity as SessionIdentity } from './management-contract';
import { sameSessionIdentity } from './session-contract';

const ROUTE = '/api/sessions/rename';
const UNAVAILABLE = {
  success: false,
  error: 'Session rename is unavailable',
} as const;

export type SessionRenameRequest = Readonly<{
  id: 'session.management';
  operationId: 'sessions.rename';
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
    label: string;
  }>;
}>;

export type SessionRenameResponse = Readonly<{
  outcome: 'succeeded' | 'target_rejected' | 'unknown';
}>;

export type SessionRenameTransportResponse = Readonly<{
  status: 200 | 503;
  body: SessionRenameResponse | typeof UNAVAILABLE;
}>;

export interface SessionRenameTransport {
  rename(request: unknown): Promise<SessionRenameTransportResponse>;
}

export function createSessionRenameTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionRenameTransport {
  return {
    async rename(request: unknown): Promise<SessionRenameTransportResponse> {
      if (!isSessionRenameRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE,
        issuer,
        decision: {
          endpoint: ROUTE,
          scope: 'sessions:write',
          capability: 'sessions.rename',
          subject: 'session-rename',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isSessionRenameResponse(response.body)) {
        return { status: 200, body: response.body };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isSessionRenameResponse(value: unknown): value is SessionRenameResponse {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'succeeded'
      || value.outcome === 'target_rejected'
      || value.outcome === 'unknown');
}

function isSessionRenameRequest(value: unknown): value is SessionRenameRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'session.management'
    && value.operationId === 'sessions.rename'
    && isOpenClawSessionScope(value.scope)
    && isOpenClawSessionScope(value.target)
    && isSessionRenameInput(value.input)
    && sameSessionIdentity(value.scope.identity, value.target.identity)
    && sameSessionIdentity(value.scope.identity, value.input.sessionIdentity);
}

function isSessionRenameInput(value: unknown): value is SessionRenameRequest['input'] {
  return isRecord(value)
    && hasExactKeys(value, ['sessionIdentity', 'label'])
    && isOpenClawSessionIdentity(value.sessionIdentity)
    && typeof value.label === 'string'
    && value.label.trim().length > 0;
}
