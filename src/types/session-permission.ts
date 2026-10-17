import { sessionIdentitiesEqual, validateSessionIdentity, type SessionIdentity, type SessionScope } from './desktop/runtime-address';
import { NATIVE_PERMISSION_MODES, type NativePermissionMode } from './native-policy';

export const OPENCLAW_PERMISSION_MODES = ['read-only', 'guarded', 'workspace', 'full'] as const;
export type OpenClawPermissionMode = typeof OPENCLAW_PERMISSION_MODES[number];
export type SessionPermissionSelection =
  | { runtime: 'openclaw'; mode: OpenClawPermissionMode | null }
  | { runtime: 'matcha-agent'; mode: NativePermissionMode };

type PermissionRuntime = SessionPermissionSelection['runtime'];
type PermissionIdentity<R extends PermissionRuntime> = SessionIdentity & {
  endpoint: { kind: 'native-runtime'; runtimeAdapterId: R; runtimeInstanceId: 'local' };
};
type PermissionEnvelope<R extends PermissionRuntime> = {
  id: 'session.management';
  scope: SessionScope & { identity: PermissionIdentity<R> };
  target: { kind: 'session'; identity: PermissionIdentity<R> };
};
type PermissionInput<R extends PermissionRuntime> = { sessionKey: string; sessionIdentity: PermissionIdentity<R> };
type GetRequest<R extends PermissionRuntime> = PermissionEnvelope<R> & {
  operationId: 'sessions.permission.get'; input: PermissionInput<R>;
};
type SetRequest<R extends PermissionRuntime, M> = PermissionEnvelope<R> & {
  operationId: 'sessions.permission.set'; input: PermissionInput<R> & { permissionMode: M };
};
export type SessionPermissionGetRequest = GetRequest<'openclaw'> | GetRequest<'matcha-agent'>;
export type SessionPermissionSetRequest = SetRequest<'openclaw', OpenClawPermissionMode | null> | SetRequest<'matcha-agent', NativePermissionMode>;
export type SessionPermissionRequest = SessionPermissionGetRequest | SessionPermissionSetRequest;
export type SessionPermissionFailure = {
  runtime: 'openclaw' | 'matcha-agent';
  outcome: 'unsupported' | 'unavailable' | 'rejected' | 'unknown';
};
export type OpenClawSessionPermissionResult = {
  runtime: 'openclaw'; outcome: 'available'; supported: true;
  mode: OpenClawPermissionMode | null; defaultMode?: OpenClawPermissionMode;
  pending: boolean; canSelectFull: boolean; options: readonly OpenClawPermissionMode[]; reason?: string;
};
export type MatchaSessionPermissionSnapshot = {
  runtime: 'matcha-agent'; outcome: 'available'; mode: NativePermissionMode | null;
};
export type MatchaSessionPermissionUpdated = {
  runtime: 'matcha-agent'; outcome: 'confirmed'; mode: NativePermissionMode; persisted: true; applied: boolean;
};
export type SessionPermissionGetResult = OpenClawSessionPermissionResult | MatchaSessionPermissionSnapshot | SessionPermissionFailure;
export type SessionPermissionSetResult = (OpenClawSessionPermissionResult & { changed?: boolean }) | MatchaSessionPermissionUpdated | SessionPermissionFailure;
export type SessionPermissionResult = SessionPermissionGetResult | SessionPermissionSetResult;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
export function isOpenClawPermissionMode(value: unknown): value is OpenClawPermissionMode {
  return typeof value === 'string' && (OPENCLAW_PERMISSION_MODES as readonly string[]).includes(value);
}
function nativeMode(value: unknown): value is NativePermissionMode {
  return typeof value === 'string' && (NATIVE_PERMISSION_MODES as readonly string[]).includes(value);
}
function runtime(identity: SessionIdentity): 'openclaw' | 'matcha-agent' | null {
  const endpoint = identity.endpoint;
  return endpoint.kind === 'native-runtime' && endpoint.runtimeInstanceId === 'local'
    && (endpoint.runtimeAdapterId === 'openclaw' || endpoint.runtimeAdapterId === 'matcha-agent')
    ? endpoint.runtimeAdapterId : null;
}
function bounded(value: string, limit: number): boolean {
  // eslint-disable-next-line no-control-regex -- Reject C0/C1 controls at the session identity boundary.
  return value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    && new TextEncoder().encode(value).length <= limit;
}
function identity(value: unknown): value is SessionIdentity {
  return validateSessionIdentity(value) === null
    && bounded((value as SessionIdentity).agentId, 256) && bounded((value as SessionIdentity).sessionKey, 4096)
    && runtime(value as SessionIdentity) !== null;
}
export function isSessionPermissionSelection(value: unknown): value is SessionPermissionSelection {
  return record(value) && keys(value, ['runtime', 'mode'])
    && (value.runtime === 'openclaw' ? value.mode === null || isOpenClawPermissionMode(value.mode)
      : value.runtime === 'matcha-agent' && nativeMode(value.mode));
}
export function isSessionPermissionRequest(value: unknown): value is SessionPermissionRequest {
  if (!record(value) || !keys(value, ['id', 'operationId', 'scope', 'target', 'input']) || value.id !== 'session.management'
    || (value.operationId !== 'sessions.permission.get' && value.operationId !== 'sessions.permission.set')
    || !record(value.scope) || !keys(value.scope, ['kind', 'identity']) || value.scope.kind !== 'session' || !identity(value.scope.identity)
    || !record(value.target) || !keys(value.target, ['kind', 'identity']) || value.target.kind !== 'session' || !identity(value.target.identity)
    || !record(value.input) || !keys(value.input, value.operationId === 'sessions.permission.get'
      ? ['sessionKey', 'sessionIdentity'] : ['sessionKey', 'sessionIdentity', 'permissionMode']) || !identity(value.input.sessionIdentity)
    || !sessionIdentitiesEqual(value.scope.identity, value.target.identity)
    || !sessionIdentitiesEqual(value.scope.identity, value.input.sessionIdentity)
    || value.input.sessionKey !== value.scope.identity.sessionKey) return false;
  return value.operationId === 'sessions.permission.get'
    || (runtime(value.scope.identity) === 'openclaw'
      ? value.input.permissionMode === null || isOpenClawPermissionMode(value.input.permissionMode)
      : nativeMode(value.input.permissionMode));
}

/* eslint-disable no-redeclare -- TypeScript overloads preserve GET/SET request and result correlations. */
export function createSessionPermissionRequest(identity: SessionIdentity): SessionPermissionGetRequest;
export function createSessionPermissionRequest(identity: SessionIdentity, selection: SessionPermissionSelection): SessionPermissionSetRequest;
export function createSessionPermissionRequest(identity: SessionIdentity, selection?: SessionPermissionSelection): SessionPermissionRequest {
  if (!identity || validateSessionIdentity(identity) || (selection !== undefined
    && (!isSessionPermissionSelection(selection) || selection.runtime !== runtime(identity)))) throw new Error('Invalid session permission selection');
  const envelope = { id: 'session.management', scope: { kind: 'session', identity }, target: { kind: 'session', identity } };
  const input = { sessionKey: identity.sessionKey, sessionIdentity: identity };
  const request = selection === undefined
    ? { ...envelope, operationId: 'sessions.permission.get', input }
    : { ...envelope, operationId: 'sessions.permission.set', input: { ...input, permissionMode: selection.mode } };
  if (!isSessionPermissionRequest(request)) throw new Error('Invalid session permission request');
  return request;
}

export function decodeSessionPermissionResult(status: number, value: unknown, request: SessionPermissionGetRequest): SessionPermissionGetResult | null;
export function decodeSessionPermissionResult(status: number, value: unknown, request: SessionPermissionSetRequest): SessionPermissionSetResult | null;
export function decodeSessionPermissionResult(status: number, value: unknown, request: SessionPermissionRequest): SessionPermissionResult | null;
export function decodeSessionPermissionResult(status: number, value: unknown, request: SessionPermissionRequest): SessionPermissionResult | null {
  if (!isSessionPermissionRequest(request) || !record(value)) return null;
  const peer = runtime(request.scope.identity)!;
  if (keys(value, ['outcome'])) {
    const outcome = value.outcome;
    return (status === 422 && outcome === 'rejected') || (status === 503 && outcome === 'unknown')
      || (peer === 'matcha-agent' && ((status === 501 && outcome === 'unsupported') || (status === 503 && outcome === 'unavailable')))
      ? { runtime: peer, outcome: outcome as SessionPermissionFailure['outcome'] } : null;
  }
  if (peer === 'openclaw' && status === 503 && keys(value, ['success', 'error'])
    && value.success === false && value.error === 'Session permission is unavailable') return { runtime: peer, outcome: 'unavailable' };
  if (status !== 200) return null;
  if (peer === 'matcha-agent') {
    if (value.runtime !== peer) return null;
    if (request.operationId === 'sessions.permission.get') {
      return keys(value, ['runtime', 'mode']) && (value.mode === null || nativeMode(value.mode))
        ? { runtime: peer, outcome: 'available', mode: value.mode } : null;
    }
    return keys(value, ['runtime', 'mode', 'persisted', 'applied']) && nativeMode(value.mode)
      && value.mode === request.input.permissionMode && value.persisted === true && typeof value.applied === 'boolean'
      ? { runtime: peer, outcome: 'confirmed', mode: value.mode, persisted: true, applied: value.applied } : null;
  }
  if (!keys(value, ['supported', 'mode', 'pending', 'canSelectFull', 'options'],
    ['defaultMode', 'reason', ...(request.operationId === 'sessions.permission.set' ? ['changed'] : [])])
    || typeof value.supported !== 'boolean' || (value.mode !== null && !isOpenClawPermissionMode(value.mode))
    || typeof value.pending !== 'boolean' || typeof value.canSelectFull !== 'boolean'
    || !Array.isArray(value.options) || !value.options.every(isOpenClawPermissionMode)
    || (Object.hasOwn(value, 'defaultMode') && !isOpenClawPermissionMode(value.defaultMode))
    || (Object.hasOwn(value, 'reason') && typeof value.reason !== 'string')
    || (Object.hasOwn(value, 'changed') && typeof value.changed !== 'boolean')) return null;
  if (!value.supported) {
    return value.mode === null && !value.pending && !value.canSelectFull && value.options.length === 0 && !Object.hasOwn(value, 'defaultMode')
      ? { runtime: peer, outcome: 'unsupported' } : null;
  }
  if (request.operationId === 'sessions.permission.set' && value.mode !== request.input.permissionMode) return null;
  return {
    runtime: peer, outcome: 'available', supported: true, mode: value.mode,
    ...(value.defaultMode === undefined ? {} : { defaultMode: value.defaultMode as OpenClawPermissionMode }),
    pending: value.pending, canSelectFull: value.canSelectFull, options: value.options,
    ...(value.reason === undefined ? {} : { reason: value.reason as string }),
    ...(value.changed === undefined ? {} : { changed: value.changed as boolean }),
  };
}
/* eslint-enable no-redeclare */
