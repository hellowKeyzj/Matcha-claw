import {
  assertSessionIdentity,
  type AgentScope,
  type RuntimeEndpointRef,
} from '../../types/desktop/runtime-address';
import {
  isSessionRuntimeEndpointReady,
  isSessionRuntimeEndpointStarting,
  supportsSessionChat,
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
};

type SessionNodeIdentityInputs = {
  agentId: string;
  sessionKey: string;
  endpointKind: RuntimeEndpointRef['kind'];
  endpointIdentity: string[];
};

// Weak node keys bound these memo inputs to graph lifetime; caller identities stay mutable.
const sessionNodeIdentityInputs = new WeakMap<ChatSessionRuntimeSessionNode, SessionNodeIdentityInputs>();

function readSessionNodeIdentityInputs(
  identity: ChatSessionRuntimeSessionNode['sessionIdentity'],
): SessionNodeIdentityInputs {
  const endpoint = identity.endpoint;
  return {
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
    endpointKind: endpoint.kind,
    endpointIdentity: endpoint.kind === 'native-runtime'
      ? [endpoint.runtimeAdapterId, endpoint.runtimeInstanceId]
      : [endpoint.protocolId, endpoint.connectorId, endpoint.endpointId],
  };
}

function sameSessionNodeIdentityInputs(
  before: SessionNodeIdentityInputs | undefined,
  identity: ChatSessionRuntimeSessionNode['sessionIdentity'],
): boolean {
  const endpoint = identity.endpoint;
  return !!before && before.agentId === identity.agentId && before.sessionKey === identity.sessionKey
    && before.endpointKind === endpoint.kind
    && (endpoint.kind === 'native-runtime'
      ? before.endpointIdentity[0] === endpoint.runtimeAdapterId && before.endpointIdentity[1] === endpoint.runtimeInstanceId
      : before.endpointIdentity[0] === endpoint.protocolId && before.endpointIdentity[1] === endpoint.connectorId
        && before.endpointIdentity[2] === endpoint.endpointId);
}

function readAgentCatalogEntries(
  catalog: ChatSessionRuntimeAgentCatalog,
): ChatSessionRuntimeAgentCatalogEntry[] {
  return catalog.source === 'runtime-endpoint'
    ? catalog.agents
    : catalog.seedAgents;
}

function ensureEndpointAccumulator(
  endpointsByRuntimeScopeKey: Map<string, RuntimeEndpointAccumulator>,
  endpoint: RuntimeEndpointRef,
  target: ChatSessionRuntimeEndpointTarget | null,
  runtimeScopeKey = buildRuntimeScopeKey(endpoint),
): RuntimeEndpointAccumulator {
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
  if (existing) return existing;
  const created: RuntimeAgentAccumulator = {
    agentId,
    catalogEntry: null,
    sessionPromptScope: null,
    sessions: [],
  };
  endpoint.agentsById.set(agentId, created);
  return created;
}

function buildSessionNode(
  record: ChatSessionRecord,
  previous?: ChatSessionRuntimeSessionNode,
): ChatSessionRuntimeSessionNode | null {
  const identity = record.meta.sessionIdentity;
  if (!identity) {
    return null;
  }
  if (previous
    && previous.endpointSessionId === record.meta.endpointSessionId
    && previous.ownership === record.meta.ownership
    && previous.kind === record.meta.kind
    && previous.preferred === record.meta.preferred
    && previous.label === record.meta.label
    && previous.titleSource === record.meta.titleSource
    && previous.displayName === (record.meta.displayName ?? null)
    && previous.modelState === record.meta.modelState
    && previous.thinkingLevel === record.meta.thinkingLevel
    && previous.contextTokens === record.contextTokens
    && previous.updatedAt === record.meta.lastActivityAt) return previous;
  const node = {
    sessionRecordKey: previous?.sessionRecordKey ?? buildSessionRecordKey(identity),
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
  sessionNodeIdentityInputs.set(node, readSessionNodeIdentityInputs(identity));
  return node;
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

function orderSessionNodes(
  sessions: ChatSessionRuntimeSessionNode[],
  previous?: ChatSessionRuntimeSessionNode[],
): ChatSessionRuntimeSessionNode[] {
  if (!previous || previous.length !== sessions.length) return sessions.sort(compareSessionNodes);
  const positions = new Map(sessions.map((session, index) => [session.sessionRecordKey, index]));
  if (positions.size !== sessions.length) return sessions.sort(compareSessionNodes);
  const ordered: ChatSessionRuntimeSessionNode[] = [];
  let previousPosition = -1;
  for (const before of previous) {
    const position = positions.get(before.sessionRecordKey);
    if (position === undefined) return sessions.sort(compareSessionNodes);
    const session = sessions[position];
    if (session.preferred !== before.preferred || (session.updatedAt ?? 0) !== (before.updatedAt ?? 0)) {
      return sessions.sort(compareSessionNodes);
    }
    const last = ordered[ordered.length - 1];
    // localeCompare can tie distinct keys; preserve the sort's current-input tie order.
    if (last && position < previousPosition && compareSessionNodes(last, session) === 0) {
      return sessions.sort(compareSessionNodes);
    }
    ordered.push(session);
    positions.delete(before.sessionRecordKey);
    previousPosition = position;
  }
  return ordered;
}

function resolveEndpointDisplayName(endpoint: RuntimeEndpointAccumulator): string {
  return endpoint.target?.displayName ?? endpoint.runtimeScopeKey;
}

function resolveEndpointDefaultAgentId(endpoint: RuntimeEndpointAccumulator): string | null {
  return endpoint.target?.defaultSessionPromptScope?.agentId ?? null;
}

function resolvePreferredSessionKey(sessions: ChatSessionRuntimeSessionNode[]): string | null {
  return sessions.find(isOrdinarySessionCandidate)?.sessionRecordKey ?? null;
}

export function buildSessionRuntimeGraph(
  catalog: Pick<ChatSessionRuntimeCatalogState, 'endpoints'>,
  loadedSessions: ChatStoreState['loadedSessions'],
  previous?: ChatSessionRuntimeGraph,
): ChatSessionRuntimeGraph {
  const endpointsByRuntimeScopeKey = new Map<string, RuntimeEndpointAccumulator>();
  const previousAgentsByRuntimeScopeKey = new Map(previous?.endpoints.map((endpoint) => [
    endpoint.runtimeScopeKey,
    new Map(endpoint.agents.map((agent) => [agent.agentId, agent.sessions])),
  ]));
  // Candidate lookup only; saved primitive inputs validate reuse on each build.
  const previousSessionsByIdentity = new Map<ChatSessionRuntimeSessionNode['sessionIdentity'], {
    node: ChatSessionRuntimeSessionNode;
    runtimeScopeKey: string;
  }>();
  for (const endpoint of previous?.endpoints ?? []) {
    for (const agent of endpoint.agents) {
      for (const node of agent.sessions) {
        previousSessionsByIdentity.set(node.sessionIdentity, { node, runtimeScopeKey: endpoint.runtimeScopeKey });
      }
    }
  }

  for (const target of catalog.endpoints) {
    const endpoint = ensureEndpointAccumulator(endpointsByRuntimeScopeKey, target.endpoint, target);
    for (const agentId of target.agentIds) {
      if (agentId) ensureAgentAccumulator(endpoint, agentId);
    }
    for (const entry of readAgentCatalogEntries(target.agentCatalog)) {
      if (!entry.id) continue;
      const agent = ensureAgentAccumulator(endpoint, entry.id);
      if (endpoint.target === target) agent.catalogEntry ??= entry;
    }
    const defaultAgentId = target.defaultSessionPromptScope?.agentId;
    if (defaultAgentId) ensureAgentAccumulator(endpoint, defaultAgentId);
    for (const scope of target.sessionPromptScopes) {
      if (buildRuntimeScopeKey(scope.endpoint) !== endpoint.runtimeScopeKey || !scope.agentId) continue;
      const agent = ensureAgentAccumulator(endpoint, scope.agentId);
      if (endpoint.target === target) agent.sessionPromptScope ??= scope;
    }
  }

  for (const record of Object.values(loadedSessions)) {
    const identity = record.meta.sessionIdentity;
    let prior = identity ? previousSessionsByIdentity.get(identity) : undefined;
    if (prior && identity) {
      assertSessionIdentity(identity);
      if (!sameSessionNodeIdentityInputs(sessionNodeIdentityInputs.get(prior.node), identity)) {
        prior = undefined;
      }
    }
    const sessionNode = buildSessionNode(record, prior?.node);
    if (!sessionNode) {
      continue;
    }
    const endpoint = ensureEndpointAccumulator(
      endpointsByRuntimeScopeKey,
      sessionNode.sessionIdentity.endpoint,
      null,
      prior?.runtimeScopeKey,
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
      agents: Array.from(endpoint.agentsById.values()).map((agent) => {
        const sessions = orderSessionNodes(
          agent.sessions,
          previousAgentsByRuntimeScopeKey.get(endpoint.runtimeScopeKey)?.get(agent.agentId),
        );
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
    return { state: input.directoryStatus === 'idle' || input.directoryStatus === 'loading' ? 'resolving' : 'unselected' };
  }
  const runtimeScopeKey = conversation.runtimeScopeKey;
  const directoryEndpoint = input.directoryEndpoints.find((endpoint) => buildRuntimeScopeKey(endpoint.endpointRef) === runtimeScopeKey);
  if (directoryEndpoint) {
    if (isSessionRuntimeEndpointReady(directoryEndpoint) && supportsSessionChat(directoryEndpoint, conversation.agentId)) {
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
  previous?: ChatCurrentConversation | null,
): ChatCurrentSessionConversation | null {
  const identity = record.meta.sessionIdentity;
  if (!identity) {
    return null;
  }
  const sessionRecordKey = buildSessionRecordKey(identity);
  if (previous?.kind === 'session' && previous.sessionRecordKey === sessionRecordKey
    && previous.endpointSessionId === record.meta.endpointSessionId) {
    return previous;
  }
  return {
    kind: 'session',
    runtimeScopeKey: buildRuntimeScopeKey(identity.endpoint),
    endpoint: identity.endpoint,
    agentId: identity.agentId,
    sessionRecordKey,
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
