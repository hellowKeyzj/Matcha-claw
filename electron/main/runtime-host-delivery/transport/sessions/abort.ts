import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const ROUTE = '/api/sessions/abort';
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
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionAbortTransport {
  return {
    async abort(request: unknown): Promise<SessionAbortTransportResponse> {
      if (!isSessionAbortRequest(request)) {
        return unknownOutcome();
      }
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE,
        issuer,
        decision: {
          endpoint: ROUTE,
          scope: 'sessions:write',
          capability: 'sessions.abort',
          subject: 'session-abort',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isSessionAbortResponse(response.body)) {
        return { status: 200, body: response.body };
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
    || !isSessionAbortInput(value.input)
    || value.scope.endpoint.runtimeAdapterId !== value.input.endpoint.runtimeAdapterId
    || value.scope.endpoint.runtimeInstanceId !== value.input.endpoint.runtimeInstanceId
    || value.scope.sessionKey !== value.input.sessionKey) {
    return false;
  }
  return true;
}

function isSessionScope(value: unknown): value is SessionAbortRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'sessionKey'])
    && value.kind === 'session'
    && isEndpoint(value.endpoint)
    && typeof value.sessionKey === 'string'
    && value.sessionKey.length > 0;
}

function isSessionAbortInput(value: unknown): value is SessionAbortRequest['input'] {
  return isRecord(value)
    && Object.hasOwn(value, 'endpoint')
    && Object.hasOwn(value, 'sessionKey')
    && Object.keys(value).every((key) => ['endpoint', 'sessionKey', 'endpointSessionId', 'runId', 'approvalIds'].includes(key))
    && isEndpoint(value.endpoint)
    && isIdentity(value.sessionKey, MAX_SESSION_KEY_BYTES)
    && (value.endpointSessionId === undefined
      || isIdentity(value.endpointSessionId, MAX_ENDPOINT_SESSION_ID_BYTES))
    && (value.runId === undefined || isIdentity(value.runId, MAX_RUN_ID_BYTES))
    && (value.approvalIds === undefined
      || (Array.isArray(value.approvalIds)
        && value.approvalIds.length <= MAX_APPROVAL_IDS
        && value.approvalIds.every(isApprovalId)));
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
