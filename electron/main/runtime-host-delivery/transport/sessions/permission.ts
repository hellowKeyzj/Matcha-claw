import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';
import { logSessionTrace, summarizeIdentifier, traceHeader } from './trace';

const DECISION_TTL_MS = 30_000;
const ENDPOINT = '/api/sessions/permission';
const MAX_SESSION_KEY_BYTES = 4096;
const MAX_AGENT_ID_BYTES = 256;

const UNAVAILABLE = { success: false, error: 'Session permission is unavailable' } as const;
const SESSION_PERMISSION_OPTIONS = ['read-only', 'guarded', 'workspace', 'full'] as const;
export type SessionPermissionMode = null | 'read-only' | 'guarded' | 'workspace' | 'full';
export type SessionPermissionOperationId = 'sessions.permission.get' | 'sessions.permission.set';

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

export type SessionPermissionIdentity = Readonly<{
  endpoint: Endpoint;
  agentId: string;
  sessionKey: string;
}>;

type SessionPermissionScope = Readonly<{ kind: 'session'; identity: SessionPermissionIdentity }>;
type SessionPermissionTarget = Readonly<{ kind: 'session'; identity: SessionPermissionIdentity }>;

type SessionPermissionGetRequest = Readonly<{
  id: 'session.management';
  operationId: 'sessions.permission.get';
  scope: SessionPermissionScope;
  target: SessionPermissionTarget;
  input: Readonly<{
    sessionKey: string;
    sessionIdentity: SessionPermissionIdentity;
  }>;
}>;

type SessionPermissionSetRequest = Readonly<{
  id: 'session.management';
  operationId: 'sessions.permission.set';
  scope: SessionPermissionScope;
  target: SessionPermissionTarget;
  input: Readonly<{
    sessionKey: string;
    sessionIdentity: SessionPermissionIdentity;
    permissionMode: SessionPermissionMode;
  }>;
}>;

export type SessionPermissionRequest = SessionPermissionGetRequest | SessionPermissionSetRequest;

export type SessionPermissionProjection = Readonly<{
  supported: true;
  mode: SessionPermissionMode;
  defaultMode?: Exclude<SessionPermissionMode, null>;
  pending: boolean;
  canSelectFull: boolean;
  options: readonly Exclude<SessionPermissionMode, null>[];
}> | Readonly<{
  supported: false;
  mode: null;
  pending: false;
  canSelectFull: false;
  options: readonly [];
  reason?: string;
}>;

export type SessionPermissionTransportResponse = Readonly<{
  status: 200 | 503;
  body: SessionPermissionProjection | typeof UNAVAILABLE;
}>;

export interface SessionPermissionTransport {
  get(request: unknown, traceId?: string | null): Promise<SessionPermissionTransportResponse>;
  set(request: unknown, traceId?: string | null): Promise<SessionPermissionTransportResponse>;
}

export function createSessionPermissionTransport(
  issuer: RuntimeHostDeliveryIssuer,
  sessionTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionPermissionTransport {
  const execute = async (
    value: unknown,
    operationId: SessionPermissionOperationId,
    traceId?: string | null,
  ): Promise<SessionPermissionTransportResponse> => {
    const request = decodeSessionPermissionRequest(value);
    if (!request || request.operationId !== operationId) {
      logSessionTrace('electron.permission.rejected', traceId, { operationId });
      return { status: 503, body: UNAVAILABLE };
    }
    const startedAt = Date.now();
    logSessionTrace('electron.permission.request', traceId, {
      operationId,
      adapter: request.input.sessionIdentity.endpoint.runtimeAdapterId,
      sessionKey: summarizeIdentifier(request.input.sessionKey),
      permissionMode: request.operationId === 'sessions.permission.set'
        ? request.input.permissionMode
        : null,
    });
    try {
      const response = await fetcher(`http://127.0.0.1:${sessionTransportPort}${ENDPOINT}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${issuer.signDecision({
            principal: 'electron-main-local',
            endpoint: ENDPOINT,
            scope: operationId === 'sessions.permission.get' ? 'sessions:read' : 'sessions:write',
            capability: 'session.management',
            subject: 'session-permission',
            expiresAt: Date.now() + DECISION_TTL_MS,
            revision: '1',
          })}`,
          'Content-Type': 'application/json',
          ...traceHeader(traceId),
        },
        body: JSON.stringify(request),
      });
      const body: unknown = await response.json();
      const projection = response.status === 200 ? decodeSessionPermissionProjection(body) : null;
      logSessionTrace('electron.permission.response', traceId, {
        operationId,
        status: response.status,
        contract: projection ? 'valid' : isUnavailable(body) ? 'unavailable' : 'invalid',
        elapsedMs: Date.now() - startedAt,
      });
      if (response.status === 200 && projection) {
        return { status: 200, body: projection };
      }
      if (response.status === 503 && isUnavailable(body)) {
        return { status: 503, body: UNAVAILABLE };
      }
    } catch {
      logSessionTrace('electron.permission.failure', traceId, {
        operationId,
        elapsedMs: Date.now() - startedAt,
      });
    }
    return { status: 503, body: UNAVAILABLE };
  };

  return {
    get: async (request, traceId) => await execute(request, 'sessions.permission.get', traceId),
    set: async (request, traceId) => await execute(request, 'sessions.permission.set', traceId),
  };
}

export function decodeSessionPermissionRequest(value: unknown): SessionPermissionRequest | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.management'
    || !isSessionPermissionOperationId(value.operationId)
    || !isSessionScope(value.scope)
    || !isSessionTarget(value.target)
    || !isSessionInput(value.input, value.operationId)
    || !sameIdentity(value.scope.identity, value.target.identity)
    || !sameIdentity(value.scope.identity, value.input.sessionIdentity)
    || value.input.sessionKey !== value.scope.identity.sessionKey) {
    return null;
  }
  return value as SessionPermissionRequest;
}

export function decodeSessionPermissionProjection(value: unknown): SessionPermissionProjection | null {
  if (!isRecord(value)
    || !hasAllowedKeys(value, ['supported', 'mode', 'pending', 'canSelectFull', 'options'], ['defaultMode', 'reason'])
    || typeof value.supported !== 'boolean'
    || !isPermissionMode(value.mode)
    || typeof value.pending !== 'boolean'
    || typeof value.canSelectFull !== 'boolean'
    || !Array.isArray(value.options)
    || !value.options.every(isConcretePermissionMode)
    || (value.reason !== undefined && typeof value.reason !== 'string')) {
    return null;
  }
  if (!value.supported) {
    return value.mode === null
      && !value.pending
      && !value.canSelectFull
      && value.options.length === 0
      ? value as SessionPermissionProjection
      : null;
  }
  return value.defaultMode === undefined || isConcretePermissionMode(value.defaultMode)
    ? value as SessionPermissionProjection
    : null;
}

function isSessionPermissionOperationId(value: unknown): value is SessionPermissionOperationId {
  return value === 'sessions.permission.get' || value === 'sessions.permission.set';
}

function isSessionScope(value: unknown): value is SessionPermissionScope {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session'
    && isSessionIdentity(value.identity);
}

function isSessionTarget(value: unknown): value is SessionPermissionTarget {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session'
    && isSessionIdentity(value.identity);
}

function isSessionInput(
  value: unknown,
  operationId: SessionPermissionOperationId,
): value is SessionPermissionRequest['input'] {
  if (!isRecord(value)
    || !isSessionKey(value.sessionKey)
    || !isSessionIdentity(value.sessionIdentity)) {
    return false;
  }
  if (operationId === 'sessions.permission.get') {
    return hasExactKeys(value, ['sessionKey', 'sessionIdentity']);
  }
  return hasExactKeys(value, ['sessionKey', 'sessionIdentity', 'permissionMode'])
    && isPermissionMode(value.permissionMode);
}

function isSessionIdentity(value: unknown): value is SessionPermissionIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'agentId', 'sessionKey'])
    && isEndpoint(value.endpoint)
    && isBoundedString(value.agentId, MAX_AGENT_ID_BYTES)
    && isSessionKey(value.sessionKey);
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

function sameIdentity(left: SessionPermissionIdentity, right: SessionPermissionIdentity): boolean {
  return left.agentId === right.agentId
    && left.sessionKey === right.sessionKey
    && left.endpoint.kind === right.endpoint.kind
    && left.endpoint.runtimeAdapterId === right.endpoint.runtimeAdapterId
    && left.endpoint.runtimeInstanceId === right.endpoint.runtimeInstanceId;
}

function isPermissionMode(value: unknown): value is SessionPermissionMode {
  return value === null || isConcretePermissionMode(value);
}

function isConcretePermissionMode(value: unknown): value is Exclude<SessionPermissionMode, null> {
  return typeof value === 'string' && SESSION_PERMISSION_OPTIONS.includes(value as Exclude<SessionPermissionMode, null>);
}

function isSessionKey(value: unknown): value is string {
  return typeof value === 'string' && isBoundedString(value, MAX_SESSION_KEY_BYTES);
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && value.trim() === value
    && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
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

function hasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}
