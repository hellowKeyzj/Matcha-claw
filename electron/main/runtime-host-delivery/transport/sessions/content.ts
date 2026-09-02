import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';
import { decodeSessionContentLoadResponse } from './session-contract';
import { logSessionTrace, summarizeIdentifier, traceHeader } from './trace';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = { success: false, error: 'Session content is unavailable' } as const;
const ENDPOINT = '/api/sessions/content';
const MAX_CONTENT_REF_BYTES = 512;

export type SessionContentLoadTransportResponse = Readonly<{ status: 200 | 503; body: unknown }>;

export type SessionContentLoadRequest = Readonly<{
  id: 'session.management';
  operationId: 'sessions.content.load';
  scope: Readonly<{ kind: 'session'; identity: Identity }>;
  target: Readonly<{ kind: 'session'; identity: Identity }>;
  input: Readonly<{
    sessionKey: string;
    sessionIdentity: Identity;
    endpointSessionId?: string;
    contentRef: string;
    offset: number;
    limit?: number;
  }>;
}>;

export interface SessionContentTransport {
  load(request: unknown, traceId?: string | null): Promise<SessionContentLoadTransportResponse>;
}

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

type Identity = Readonly<{ endpoint: Endpoint; agentId: string; sessionKey: string }>;

export function createSessionContentTransport(
  issuer: RuntimeHostDeliveryIssuer,
  sessionTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionContentTransport {
  return {
    load: async (request, traceId) => {
      if (!isRequest(request)) {
        logSessionTrace('electron.content.rejected', traceId);
        return { status: 503, body: UNAVAILABLE };
      }
      const startedAt = Date.now();
      logSessionTrace('electron.content.request', traceId, {
        adapter: request.input.sessionIdentity.endpoint.runtimeAdapterId,
        sessionKey: summarizeIdentifier(request.input.sessionKey),
        endpointSessionId: summarizeIdentifier(request.input.endpointSessionId),
        contentRef: summarizeIdentifier(request.input.contentRef),
        offset: request.input.offset,
        limit: request.input.limit ?? null,
      });
      try {
        const response = await fetcher(`http://127.0.0.1:${sessionTransportPort}${ENDPOINT}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: ENDPOINT,
              scope: 'sessions:read',
              capability: 'session.management',
              subject: 'session-content',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
            ...traceHeader(traceId),
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        const loaded = response.status === 200 ? decodeSessionContentLoadResponse(body) : null;
        logSessionTrace('electron.content.response', traceId, {
          status: response.status,
          contract: loaded ? 'valid' : isUnavailable(body) ? 'unavailable' : 'invalid',
          elapsedMs: Date.now() - startedAt,
        });
        if (response.status === 200
          && loaded
          && loaded.contentRef === request.input.contentRef
          && loaded.offset === request.input.offset) {
          return { status: 200, body: loaded };
        }
        if (response.status === 503 && isUnavailable(body)) return { status: 503, body: UNAVAILABLE };
      } catch {
        logSessionTrace('electron.content.failure', traceId, { elapsedMs: Date.now() - startedAt });
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is SessionContentLoadRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.management'
    || value.operationId !== 'sessions.content.load'
    || !isScope(value.scope)
    || !isTarget(value.target)
    || !isInput(value.input)) return false;
  return sameIdentity(value.scope.identity, value.target.identity)
    && sameIdentity(value.scope.identity, value.input.sessionIdentity)
    && value.input.sessionKey === value.scope.identity.sessionKey;
}

function isScope(value: unknown): value is { kind: 'session'; identity: Identity } {
  return isRecord(value) && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session' && isIdentity(value.identity);
}

function isTarget(value: unknown): value is { kind: 'session'; identity: Identity } {
  return isRecord(value) && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session' && isIdentity(value.identity);
}

function isInput(value: unknown): value is SessionContentLoadRequest['input'] {
  return isRecord(value)
    && hasAllowedKeys(value, ['sessionKey', 'sessionIdentity', 'contentRef', 'offset'], ['endpointSessionId', 'limit'])
    && typeof value.sessionKey === 'string'
    && isIdentity(value.sessionIdentity)
    && isContentRef(value.contentRef)
    && isSafeNonNegativeInteger(value.offset)
    && (value.endpointSessionId === undefined || isBoundedId(value.endpointSessionId))
    && (value.limit === undefined || isContentLimit(value.limit));
}

function isIdentity(value: unknown): value is Identity {
  return isRecord(value) && hasExactKeys(value, ['endpoint', 'agentId', 'sessionKey'])
    && isEndpoint(value.endpoint)
    && isBoundedId(value.agentId)
    && isBoundedId(value.sessionKey);
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value) && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime' && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.agentId === right.agentId && left.sessionKey === right.sessionKey
    && left.endpoint.runtimeAdapterId === right.endpoint.runtimeAdapterId
    && left.endpoint.runtimeInstanceId === right.endpoint.runtimeInstanceId;
}

function isContentLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 64 * 1024;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 4096
    && value.trim() === value
    && !value.includes('\0');
}

function isContentRef(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_CONTENT_REF_BYTES
    && value.trim() === value
    && !value.includes('\0');
}

function isUnavailable(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['success', 'error'])
    && value.success === false && value.error === UNAVAILABLE.error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasAllowedKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}
