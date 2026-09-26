import type {
  AgentScope,
  RuntimeEndpointRef,
} from '../../types/desktop/runtime-address';
import {
  isSessionRuntimeEndpointReady,
  isSessionRuntimeEndpointStarting,
} from '../runtime-endpoints';
import type { RuntimeEndpointSummary } from '../../types/runtime-topology';
import type {
  ChatCurrentConversation,
  ChatCurrentConversationRuntimeState,
  ChatCurrentDraftConversation,
  ChatCurrentSessionConversation,
  ChatSessionRecord,
  ChatSessionRuntimeAgentCatalog,
  ChatSessionRuntimeAgentCatalogEntry,
  ChatSessionRuntimeCatalogState,
  ChatSessionRuntimeEndpointTarget,
  ChatSessionRuntimeGraph,
  ChatSessionRuntimeSessionNode,
  ChatStoreState,
} from './types';
import {
  buildRuntimeScopeKey,
  buildSessionRecordKey,
  sameRuntimeEndpointScope,
} from './session-identity';
import { isOrdinarySessionCandidate } from './types';

export const EMPTY_SESSION_RUNTIME_GRAPH: ChatSessionRuntimeGraph = { endpoints: [] };

type RuntimeEndpointAccumulator = {
  runtimeScopeKey: string;
  endpoint: RuntimeEndpointRef;
  target: ChatSessionRuntimeEndpointTarget | null;
  agentsById: Map<string, RuntimeAgentAccumulator>;
};

type RuntimeAgentAccumulator = {
  agentId: string;
  catalogEntry: ChatSessionRuntimeAgentCatalogEntry | null;
  sessionPromptScope: AgentScope | null;
  sessions: ChatSessionRuntimeSessionNode[];
  order: number;
};

function readAgentCatalogEntries(
  catalog: ChatSessionRuntimeAgentCatalog,
): ChatSessionRuntimeAgentCatalogEntry[] {
  return catalog.source === 'runtime-endpoint'
    ? catalog.agents
    : catalog.seedAgents;
}

function findAgentCatalogEntry(
  target: ChatSessionRuntimeEndpointTarget,
  agentId: string,
): ChatSessionRuntimeAgentCatalogEntry | null {
  return readAgentCatalogEntries(target.agentCatalog).find((entry) => entry.id === agentId) ?? null;
}

function findSessionPromptScope(
  target: ChatSessionRuntimeEndpointTarget,
  agentId: string,
): AgentScope | null {
  const scopes = [target.defaultSessionPromptScope, ...target.sessionPromptScopes];
  return scopes.find((scope) => (
    scope.agentId === agentId
    && sameRuntimeEndpointScope(scope.endpoint, target.endpoint)
  )) ?? null;
}

function addAgentId(agentIds: Set<string>, agentId: string): void {
  if (agentId) {
    agentIds.add(agentId);
  }
}

function collectTargetAgentIds(target: ChatSessionRuntimeEndpointTarget): string[] {
  const agentIds = new Set<string>();
  for (const agentId of target.agentIds) {
    addAgentId(agentIds, agentId);
  }
  for (const entry of readAgentCatalogEntries(target.agentCatalog)) {
    addAgentId(agentIds, entry.id);
  }
  addAgentId(agentIds, target.defaultSessionPromptScope.agentId);
  for (const scope of target.sessionPromptScopes) {
    if (sameRuntimeEndpointScope(scope.endpoint, target.endpoint)) {
      addAgentId(agentIds, scope.agentId);
    }
  }
  return Array.from(agentIds);
}

function ensureEndpointAccumulator(
  endpointsByRuntimeScopeKey: Map<string, RuntimeEndpointAccumulator>,
  endpoint: RuntimeEndpointRef,
  target: ChatSessionRuntimeEndpointTarget | null,
): RuntimeEndpointAccumulator {
  const runtimeScopeKey = buildRuntimeScopeKey(endpoint);
  const existing = endpointsByRuntimeScopeKey.get(runtimeScopeKey);
  if (existing) {
    if (target && !existing.target) {
      existing.endpoint = target.endpoint;
      existing.target = target;
    }
    return existing;
  }
  const created = {
    runtimeScopeKey,
    endpoint,
    target,
    agentsById: new Map<string, RuntimeAgentAccumulator>(),
  };
  endpointsByRuntimeScopeKey.set(runtimeScopeKey, created);
  return created;
}

function ensureAgentAccumulator(
  endpoint: RuntimeEndpointAccumulator,
  agentId: string,
): RuntimeAgentAccumulator {
  const existing = endpoint.agentsById.get(agentId);
  const catalogEntry = endpoint.target ? findAgentCatalogEntry(endpoint.target, agentId) : null;
  const sessionPromptScope = endpoint.target ? findSessionPromptScope(endpoint.target, agentId) : null;
  if (existing) {
    if (!existing.catalogEntry && catalogEntry) {
      existing.catalogEntry = catalogEntry;
    }
    if (!existing.sessionPromptScope && sessionPromptScope) {
      existing.sessionPromptScope = sessionPromptScope;
    }
    return existing;
  }
  const created = {
    agentId,
    catalogEntry,
    sessionPromptScope,
    sessions: [],
    order: endpoint.agentsById.size,
  };
  endpoint.agentsById.set(agentId, created);
  return created;
}

function buildSessionNode(record: ChatSessionRecord): ChatSessionRuntimeSessionNode | null {
  const identity = record.meta.sessionIdentity;
  if (!identity) {
    return null;
  }
  return {
    sessionRecordKey: buildSessionRecordKey(identity),
    endpointSessionId: record.meta.endpointSessionId,
    sessionIdentity: identity,
    ownership: record.meta.ownership,
    kind: record.meta.kind,
    preferred: record.meta.preferred,
    label: record.meta.label,
    titleSource: record.meta.titleSource,
    displayName: record.meta.displayName ?? null,
    modelState: record.meta.modelState,
    thinkingLevel: record.meta.thinkingLevel,
    ...(record.contextTokens ? { contextTokens: record.contextTokens } : {}),
    updatedAt: record.meta.lastActivityAt,
  };
}

function compareSessionNodes(
  left: ChatSessionRuntimeSessionNode,
  right: ChatSessionRuntimeSessionNode,
): number {
  if (left.preferred !== right.preferred) {
    return left.preferred ? -1 : 1;
  }
  const leftUpdatedAt = left.updatedAt ?? 0;
  const rightUpdatedAt = right.updatedAt ?? 0;
  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt - leftUpdatedAt;
  }
  return left.sessionRecordKey.localeCompare(right.sessionRecordKey);
}

function resolveEndpointDisplayName(endpoint: RuntimeEndpointAccumulator): string {
  return endpoint.target?.displayName ?? endpoint.runtimeScopeKey;
}

function resolveEndpointDefaultAgentId(endpoint: RuntimeEndpointAccumulator): string | null {
  return endpoint.target?.defaultSessionPromptScope.agentId ?? null;
}

function resolvePreferredSessionKey(sessions: ChatSessionRuntimeSessionNode[]): string | null {
  return sessions.find(isOrdinarySessionCandidate)?.sessionRecordKey ?? null;
}

export function buildSessionRuntimeGraph(
  catalog: Pick<ChatSessionRuntimeCatalogState, 'endpoints'>,
  loadedSessions: ChatStoreState['loadedSessions'],
): ChatSessionRuntimeGraph {
  const endpointsByRuntimeScopeKey = new Map<string, RuntimeEndpointAccumulator>();

  for (const target of catalog.endpoints) {
    const endpoint = ensureEndpointAccumulator(endpointsByRuntimeScopeKey, target.endpoint, target);
    for (const agentId of collectTargetAgentIds(target)) {
      ensureAgentAccumulator(endpoint, agentId);
    }
  }

  for (const record of Object.values(loadedSessions)) {
    const sessionNode = buildSessionNode(record);
    if (!sessionNode) {
      continue;
    }
    const endpoint = ensureEndpointAccumulator(
      endpointsByRuntimeScopeKey,
      sessionNode.sessionIdentity.endpoint,
      null,
    );
    ensureAgentAccumulator(endpoint, sessionNode.sessionIdentity.agentId).sessions.push(sessionNode);
  }

  return {
    endpoints: Array.from(endpointsByRuntimeScopeKey.values()).map((endpoint) => ({
      runtimeScopeKey: endpoint.runtimeScopeKey,
      endpoint: endpoint.endpoint,
      target: endpoint.target,
      displayName: resolveEndpointDisplayName(endpoint),
      defaultAgentId: resolveEndpointDefaultAgentId(endpoint),
      agents: Array.from(endpoint.agentsById.values())
        .sort((left, right) => left.order - right.order)
        .map((agent) => {
          const sessions = [...agent.sessions].sort(compareSessionNodes);
          return {
            agentId: agent.agentId,
            catalogEntry: agent.catalogEntry,
            sessionPromptScope: agent.sessionPromptScope,
            sessions,
            preferredSessionKey: resolvePreferredSessionKey(sessions),
          };
        }),
    })),
  };
}

export function findPreferredSessionForAgent(
  graph: ChatSessionRuntimeGraph,
  endpoint: RuntimeEndpointRef,
  agentId: string,
): ChatSessionRuntimeSessionNode | null {
  const endpointNode = graph.endpoints.find((candidate) => sameRuntimeEndpointScope(candidate.endpoint, endpoint));
  const agentNode = endpointNode?.agents.find((candidate) => candidate.agentId === agentId);
  if (!agentNode) {
    return null;
  }
  return agentNode.sessions.find(isOrdinarySessionCandidate) ?? null;
}

export function resolveCurrentConversationRuntimeState(input: {
  currentConversation: ChatCurrentConversation | null;
  graph: ChatSessionRuntimeGraph;
  directoryStatus: 'idle' | 'loading' | 'ready' | 'error';
  directoryError: string | null;
  directoryEndpoints: readonly RuntimeEndpointSummary[];
}): ChatCurrentConversationRuntimeState {
  const conversation = input.currentConversation;
  if (!conversation) {
    return { state: 'resolving' };
  }
  const runtimeScopeKey = conversation.runtimeScopeKey;
  const directoryEndpoint = input.directoryEndpoints.find((endpoint) => buildRuntimeScopeKey(endpoint.endpointRef) === runtimeScopeKey);
  if (directoryEndpoint) {
    if (isSessionRuntimeEndpointReady(directoryEndpoint)) {
      return { state: 'ready', runtimeScopeKey };
    }
    if (isSessionRuntimeEndpointStarting(directoryEndpoint)) {
      return { state: 'starting', runtimeScopeKey };
    }
    return { state: 'unavailable', runtimeScopeKey, error: directoryEndpoint.lifecycle.error ?? directoryEndpoint.controlState.readiness?.error ?? null };
  }
  const graphEndpoint = input.graph.endpoints.find((endpoint) => endpoint.runtimeScopeKey === runtimeScopeKey);
  if (!graphEndpoint?.target) {
    if (input.directoryStatus === 'idle' || input.directoryStatus === 'loading') {
      return { state: 'starting', runtimeScopeKey };
    }
    return { state: 'unavailable', runtimeScopeKey, error: input.directoryError };
  }
  if (input.directoryStatus === 'error') {
    return { state: 'unavailable', runtimeScopeKey, error: input.directoryError };
  }
  return { state: 'ready', runtimeScopeKey };
}

export function buildCurrentConversationFromSessionRecord(
  record: ChatSessionRecord,
): ChatCurrentSessionConversation | null {
  const identity = record.meta.sessionIdentity;
  if (!identity) {
    return null;
  }
  return {
    kind: 'session',
    runtimeScopeKey: buildRuntimeScopeKey(identity.endpoint),
    endpoint: identity.endpoint,
    agentId: identity.agentId,
    sessionRecordKey: buildSessionRecordKey(identity),
    endpointSessionId: record.meta.endpointSessionId,
    sessionIdentity: identity,
  };
}

export function createDraftCurrentConversation(
  endpoint: RuntimeEndpointRef,
  agentId: string,
): ChatCurrentDraftConversation {
  return {
    kind: 'draft',
    runtimeScopeKey: buildRuntimeScopeKey(endpoint),
    endpoint,
    agentId,
    sessionPromptScope: {
      kind: 'agent',
      endpoint,
      agentId,
    },
  };
}
