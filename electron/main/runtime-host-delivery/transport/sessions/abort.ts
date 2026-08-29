import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const MAX_SESSION_KEY_BYTES = 4096;
const MAX_RUN_ID_BYTES = 4096;
const MAX_ENDPOINT_SESSION_ID_BYTES = 4096;
const MAX_APPROVAL_IDS = 32;
const MAX_APPROVAL_ID_BYTES = 4096;

export type SessionAbortOutcome = 'succeeded' | 'target_rejected' | 'unknown';

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

export type SessionAbortRequest = Readonly<{
  id: 'session.abort';
  operationId: 'sessions.abort';
  scope: Readonly<{
    kind: 'session';
    endpoint: Endpoint;
    sessionKey: string;
  }>;
  target: Readonly<{ kind: 'session' }>;
  input: Readonly<{
    endpoint: Endpoint;
    sessionKey: string;
    endpointSessionId?: string;
    runId?: string;
    approvalIds?: readonly string[];
  }>;
}>;

export type SessionAbortTransportResponse = Readonly<{
  status: 200;
  body: Readonly<{ outcome: SessionAbortOutcome }>;
}>;

export interface SessionAbortTransport {
  abort(request: unknown): Promise<SessionAbortTransportResponse>;
}

export function createSessionAbortTransport(
  issuer: RuntimeHostDeliveryIssuer,
  sessionAbortTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionAbortTransport {
  const url = `http://127.0.0.1:${sessionAbortTransportPort}/api/sessions/abort`;
  return {
    async abort(request: unknown): Promise<SessionAbortTransportResponse> {
      if (!isSessionAbortRequest(request)) {
        return unknownOutcome();
      }
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/sessions/abort',
              scope: 'sessions:write',
              capability: 'sessions.abort',
              subject: 'session-abort',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isSessionAbortResponse(body)) {
          return { status: 200, body };
        }
      } catch {
        // An interrupted native mutation never gives the renderer a terminal fact.
      }
      return unknownOutcome();
    },
  };
}

function unknownOutcome(): SessionAbortTransportResponse {
  return { status: 200, body: { outcome: 'unknown' } };
}

function isSessionAbortResponse(value: unknown): value is Readonly<{ outcome: SessionAbortOutcome }> {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'succeeded' || value.outcome === 'target_rejected' || value.outcome === 'unknown');
}

function isSessionAbortRequest(value: unknown): value is SessionAbortRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.abort'
    || value.operationId !== 'sessions.abort'
    || !isSessionScope(value.scope)
    || !isRecord(value.target)
    || !hasExactKeys(value.target, ['kind'])
    || value.target.kind !== 'session'
    || !isRecord(value.input)
    || !hasAllowedKeys(value.input, ['endpoint', 'sessionKey'], ['endpointSessionId', 'runId', 'approvalIds'])
    || !isEndpoint(value.input.endpoint)
    || value.scope.endpoint.runtimeAdapterId !== value.input.endpoint.runtimeAdapterId
    || value.scope.endpoint.runtimeInstanceId !== value.input.endpoint.runtimeInstanceId
    || value.scope.sessionKey !== value.input.sessionKey
    || !isIdentity(value.input.sessionKey, MAX_SESSION_KEY_BYTES)
    || (value.input.endpointSessionId !== undefined
      && !isIdentity(value.input.endpointSessionId, MAX_ENDPOINT_SESSION_ID_BYTES))
    || (value.input.runId !== undefined && !isIdentity(value.input.runId, MAX_RUN_ID_BYTES))
    || (value.input.approvalIds !== undefined
      && (!Array.isArray(value.input.approvalIds)
        || value.input.approvalIds.length > MAX_APPROVAL_IDS
        || value.input.approvalIds.some((approvalId) => !isApprovalId(approvalId))))) {
    return false;
  }
  return isEndpoint(value.scope.endpoint);
}

function isSessionScope(value: unknown): value is SessionAbortRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'sessionKey'])
    && value.kind === 'session'
    && isEndpoint(value.endpoint)
    && typeof value.sessionKey === 'string'
    && value.sessionKey.length > 0;
}

function isApprovalId(value: unknown): value is string {
  return isIdentity(value, MAX_APPROVAL_ID_BYTES);
}

function isIdentity(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && value.trim() === value
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
    });
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}
