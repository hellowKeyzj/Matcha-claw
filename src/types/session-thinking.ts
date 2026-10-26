import { buildCapabilityScopeKey, validateRuntimeScope, type AgentScope, type SessionScope } from './desktop/runtime-address';

export type SessionThinkingScope = AgentScope | SessionScope;
export type ThinkingRuntime = 'openclaw' | 'matcha-agent';
export type SessionThinkingSnapshot = {
  runtime: ThinkingRuntime;
  level: string | null;
  effectiveLevel: string | null;
  options: string[];
};
export type SessionThinkingResult =
  | (SessionThinkingSnapshot & { outcome: 'available' })
  | (SessionThinkingSnapshot & { outcome: 'confirmed'; persisted: true; applied: boolean })
  | { runtime: ThinkingRuntime; outcome: 'unsupported' | 'unavailable' | 'rejected' | 'unknown' };

export type SessionThinkingRequest = {
  id: 'session.thinking';
  scope: SessionThinkingScope;
  target: SessionThinkingScope & Record<string, unknown>;
} & (
  | { operationId: 'sessions.thinking.get'; input: { modelSelectionId?: string } }
  | { operationId: 'sessions.thinking.set'; input: { level: string | null } }
);

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function bounded(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    // eslint-disable-next-line no-control-regex -- Reject control characters at the public input boundary.
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && new TextEncoder().encode(value).length <= maxBytes;
}
export function thinkingRuntime(scope: SessionThinkingScope): ThinkingRuntime {
  const endpoint = scope.kind === 'session' ? scope.identity.endpoint : scope.endpoint;
  if (endpoint.kind !== 'native-runtime' || endpoint.runtimeInstanceId !== 'local'
    || endpoint.runtimeAdapterId !== 'openclaw' && endpoint.runtimeAdapterId !== 'matcha-agent') {
    throw new Error('Invalid session thinking runtime');
  }
  return endpoint.runtimeAdapterId;
}
function isScope(value: unknown): value is SessionThinkingScope {
  if (!record(value) || value.kind !== 'agent' && value.kind !== 'session' || validateRuntimeScope(value) !== null
    || value.kind === 'session' && !record(value.identity)) return false;
  const scope = value as unknown as SessionThinkingScope;
  const endpoint = scope.kind === 'session' ? scope.identity.endpoint : scope.endpoint;
  return endpoint.kind === 'native-runtime' && endpoint.runtimeInstanceId === 'local'
    && (endpoint.runtimeAdapterId === 'openclaw' || endpoint.runtimeAdapterId === 'matcha-agent')
    && bounded(scope.kind === 'session' ? scope.identity.agentId : scope.agentId, 256)
    && (scope.kind !== 'session' || bounded(scope.identity.sessionKey, 4096));
}
export function isSessionThinkingRequest(value: unknown): value is SessionThinkingRequest {
  if (!record(value) || !keys(value, ['id', 'operationId', 'scope', 'target', 'input']) || value.id !== 'session.thinking'
    || !isScope(value.scope) || !isScope(value.target) || !record(value.input)
    || buildCapabilityScopeKey(value.scope) !== buildCapabilityScopeKey(value.target)) return false;
  if (value.operationId === 'sessions.thinking.get') {
    return keys(value.input, [], ['modelSelectionId'])
      && (!Object.hasOwn(value.input, 'modelSelectionId') || bounded(value.input.modelSelectionId, 4096));
  }
  return value.operationId === 'sessions.thinking.set' && value.scope.kind === 'session'
    && keys(value.input, ['level']) && (value.input.level === null || bounded(value.input.level, 64));
}
export function createSessionThinkingRequest(scope: SessionThinkingScope, input?: { modelSelectionId?: string } | { level: string | null }): SessionThinkingRequest {
  const request = {
    id: 'session.thinking', scope, target: scope,
    ...(input && 'level' in input
      ? { operationId: 'sessions.thinking.set', input }
      : { operationId: 'sessions.thinking.get', input: input ?? {} }),
  };
  if (!isSessionThinkingRequest(request)) throw new Error('Invalid session thinking request');
  return request;
}
export function decodeSessionThinkingResult(value: unknown, request: SessionThinkingRequest): SessionThinkingResult | null {
  if (!isSessionThinkingRequest(request) || !record(value)) return null;
  const runtime = thinkingRuntime(request.scope);
  if (value.runtime !== runtime) return null;
  if (value.outcome === 'unsupported' || value.outcome === 'unavailable' || value.outcome === 'rejected' || value.outcome === 'unknown') {
    return keys(value, ['runtime', 'outcome']) ? { runtime, outcome: value.outcome } : null;
  }
  const confirmed = value.outcome === 'confirmed';
  if (value.outcome !== 'available' && !confirmed || confirmed !== (request.operationId === 'sessions.thinking.set')
    || !keys(value, ['runtime', 'outcome', 'level', 'effectiveLevel', 'options', ...(confirmed ? ['persisted', 'applied'] : [])])
    || value.level !== null && !bounded(value.level, 64) || value.effectiveLevel !== null && !bounded(value.effectiveLevel, 64)
    || !Array.isArray(value.options) || value.options.length > 16 || !value.options.every((option) => bounded(option, 64))
    || new Set(value.options).size !== value.options.length) return null;
  const snapshot: SessionThinkingSnapshot = { runtime, level: value.level, effectiveLevel: value.effectiveLevel, options: value.options };
  if (!confirmed) return { ...snapshot, outcome: 'available' };
  return value.persisted === true && typeof value.applied === 'boolean' && request.operationId === 'sessions.thinking.set'
    && value.level === request.input.level ? { ...snapshot, outcome: 'confirmed', persisted: true, applied: value.applied } : null;
}
