import {
  buildRuntimeEndpointKey,
  buildSessionIdentityKey,
  sessionIdentitiesEqual,
  sessionScope,
  type AgentScope,
  type RuntimeEndpointRef,
  type RuntimeScope,
  type SessionIdentity,
} from '../../../runtime-host/shared/runtime-address';
import type { ChatStoreState } from './types';
import { getSessionMeta } from './store-state-helpers';

export interface SessionOperationTarget {
  sessionKey: string;
  endpointSessionId?: string;
  sessionIdentity: SessionIdentity;
}

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
  for (const [recordKey, record] of Object.entries(loadedSessions)) {
    if (record.meta.sessionIdentity) {
      index[buildSessionIdentityKey(record.meta.sessionIdentity)] = recordKey;
    }
  }
  return index;
}

export function findSessionRecordKey(
  state: Pick<ChatStoreState, 'loadedSessions'> & Partial<Pick<ChatStoreState, 'sessionRecordKeyByIdentityKey'>>,
  identity: SessionIdentity,
): string | null {
  const identityKey = buildSessionIdentityKey(identity);
  const indexedRecordKey = state.sessionRecordKeyByIdentityKey?.[identityKey];
  if (indexedRecordKey && state.loadedSessions[indexedRecordKey]?.meta.sessionIdentity) {
    return indexedRecordKey;
  }
  for (const [recordKey, record] of Object.entries(state.loadedSessions)) {
    if (record.meta.sessionIdentity && sessionIdentitiesEqual(record.meta.sessionIdentity, identity)) {
      return recordKey;
    }
  }
  return null;
}

export function resolveSessionOperationTarget(state: ChatStoreState, recordKey: string): SessionOperationTarget {
  const meta = getSessionMeta(state, recordKey);
  if (!meta.backendSessionKey) {
    throw new Error(`Backend session key is required: ${recordKey}`);
  }
  if (!meta.sessionIdentity) {
    throw new Error(`SessionIdentity is required: ${recordKey}`);
  }
  return {
    sessionKey: meta.backendSessionKey,
    ...(meta.endpointSessionId ? { endpointSessionId: meta.endpointSessionId } : {}),
    sessionIdentity: meta.sessionIdentity,
  };
}

export function sessionOperationScope(target: SessionOperationTarget) {
  return sessionScope(target.sessionIdentity);
}
