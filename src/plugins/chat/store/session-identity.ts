import {
  buildRuntimeEndpointKey,
  buildSessionIdentityKey,
  sessionScope,
  type AgentScope,
  type RuntimeEndpointRef,
  type RuntimeScope,
  type SessionIdentity,
} from '@/types/desktop/runtime-address';
import type { ChatStoreState } from '@/plugins/chat/store/types';
import {
  buildSessionOperationTarget,
  type SessionOperationTarget,
} from '@/plugins/runtime/session-operation-target';

export function buildRuntimeScopeKey(endpoint: RuntimeEndpointRef): string {
  return buildRuntimeEndpointKey(endpoint);
}

export function buildSessionRecordKey(identity: SessionIdentity): string {
  return buildSessionIdentityKey(identity);
}

export function sameRuntimeEndpointScope(left: RuntimeEndpointRef, right: RuntimeEndpointRef): boolean {
  return buildRuntimeEndpointKey(left) === buildRuntimeEndpointKey(right);
}

export function scopeEndpoint(scope: RuntimeScope): RuntimeEndpointRef | null {
  if ('endpoint' in scope) {
    return scope.endpoint;
  }
  if (scope.kind === 'session') {
    return scope.identity.endpoint;
  }
  return null;
}

export function findAgentScope(scopes: readonly AgentScope[], agentId: string): AgentScope | null {
  return scopes.find((scope) => scope.agentId === agentId) ?? null;
}

export function sessionIdentityForAgentScope(scope: AgentScope, sessionKey: string): SessionIdentity {
  return {
    endpoint: scope.endpoint,
    agentId: scope.agentId,
    sessionKey,
  };
}

export function buildSessionIdentityRecordIndex(
  loadedSessions: ChatStoreState['loadedSessions'],
): Record<string, string> {
  const index: Record<string, string> = {};
  for (const recordKey of Object.keys(loadedSessions)) {
    const identity = loadedSessions[recordKey].meta.sessionIdentity;
    if (identity) index[buildSessionIdentityKey(identity)] = recordKey;
  }
  return index;
}

export function resolveSessionOperationTarget(state: ChatStoreState, recordKey: string): SessionOperationTarget {
  const meta = state.loadedSessions[recordKey]?.meta;
  if (!meta?.sessionIdentity) {
    throw new Error(`SessionIdentity is required: ${recordKey}`);
  }
  return buildSessionOperationTarget(meta.sessionIdentity, meta.endpointSessionId);
}

export function sessionOperationScope(target: SessionOperationTarget) {
  return sessionScope(target.sessionIdentity);
}
