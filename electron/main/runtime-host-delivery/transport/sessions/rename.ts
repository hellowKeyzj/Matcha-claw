import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = {
  success: false,
  error: 'Session rename is unavailable',
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
  sessionTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionRenameTransport {
  const url = `http://127.0.0.1:${sessionTransportPort}/api/sessions/rename`;
  return {
    async rename(request: unknown): Promise<SessionRenameTransportResponse> {
      if (!isSessionRenameRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/sessions/rename',
              scope: 'sessions:write',
              capability: 'sessions.rename',
              subject: 'session-rename',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isSessionRenameResponse(body)) {
          return { status: 200, body };
        }
      } catch {
        // The public contract deliberately suppresses transport details.
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
    && isSessionScope(value.scope)
    && isSessionTarget(value.target)
    && isSessionRenameInput(value.input)
    && sameIdentity(value.scope.identity, value.target.identity)
    && sameIdentity(value.scope.identity, value.input.sessionIdentity);
}

function isSessionScope(value: unknown): value is SessionRenameRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session'
    && isSessionIdentity(value.identity);
}

function isSessionTarget(value: unknown): value is SessionRenameRequest['target'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session'
    && isSessionIdentity(value.identity);
}

function isSessionRenameInput(value: unknown): value is SessionRenameRequest['input'] {
  return isRecord(value)
    && hasExactKeys(value, ['sessionIdentity', 'label'])
    && isSessionIdentity(value.sessionIdentity)
    && typeof value.label === 'string'
    && value.label.trim().length > 0;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
