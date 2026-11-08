import { useMemo } from 'react';
import { isSessionRuntimeEndpointReady, supportsSessionChat, useRuntimeEndpointsStore } from '@/plugins/runtime/directory';
import { buildRuntimeEndpointKey } from '@/types/desktop/runtime-address';
import type { RuntimeEndpointSummary } from '@/types/runtime-topology';
import type { AgentAvatarStyle, SubagentSummary } from '@/types/subagent';
import type { ResourceStateMeta } from '@/lib/resource-state';
import { selectAgentsResource } from '@/plugins/agents/stores/subagents';
import { findAgentScope } from '@/plugins/chat/store/session-identity';
import { inferUntitledSessionLabel, normalizeAutomaticSessionTitle } from '@/plugins/chat/session-catalog';
import type { AgentSessionsPaneRuntimeEndpoint, AgentSessionsPaneRuntimeTarget, AgentSessionsPaneSessionEntry } from '@/plugins/chat/store/selectors';
import type { AgentScope } from '@/types/desktop/runtime-address';
import { buildAgentSessionSwitchboardModel } from '@/plugins/chat/agent-session-switchboard-model';

const LOCAL_RUNTIME_ENDPOINTS = ([
  { endpoint: { kind: 'native-runtime', runtimeAdapterId: 'matcha-agent', runtimeInstanceId: 'local' }, displayName: 'Matcha Agent' },
  { endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, displayName: 'OpenClaw' },
] as const).map((local) => ({ ...local, runtimeScopeKey: buildRuntimeEndpointKey(local.endpoint) }));
const LOCAL_RUNTIME_SCOPE_KEYS = new Set(LOCAL_RUNTIME_ENDPOINTS.map((local) => local.runtimeScopeKey));

type RuntimeSidebarStatus = 'loading' | 'starting' | 'failed' | 'stopped' | 'unavailable' | null;

function runtimeSidebarStatus(endpoint: RuntimeEndpointSummary | undefined, directoryStatus: ReturnType<typeof useRuntimeEndpointsStore.getState>['status']): RuntimeSidebarStatus {
  if (!endpoint) return directoryStatus === 'ready' || directoryStatus === 'error' ? 'unavailable' : 'loading';
  switch (endpoint.lifecycle.phase) {
    case 'ready': return null;
    case 'connecting': return 'starting';
    case 'declared':
    case 'disconnected': return 'stopped';
    case 'unavailable': return 'failed';
  }
}

function usesManagementAgents(endpoint: AgentSessionsPaneRuntimeEndpoint): boolean {
  return endpoint.agentCatalogSource === 'subagent-management'
    || (endpoint.agentCatalogSource === null && LOCAL_RUNTIME_SCOPE_KEYS.has(endpoint.runtimeScopeKey));
}

interface SidebarAgentSummary {
  id: string;
  name?: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

export function resolveRuntimeAgentSummary(
  endpoint: AgentSessionsPaneRuntimeEndpoint,
  agentId: string,
  managementAgents: readonly SidebarAgentSummary[],
): SidebarAgentSummary {
  const graphAgent = endpoint.agents.find((agent) => agent.agentId === agentId);
  if (!usesManagementAgents(endpoint)) {
    return { id: agentId, name: graphAgent?.catalogEntry?.name?.trim() || agentId };
  }
  const metadata = managementAgents.find((agent) => agent.id === agentId);
  const seed = graphAgent?.catalogEntry;
  return {
    id: agentId,
    name: metadata?.name?.trim() || seed?.name?.trim() || agentId,
    avatarSeed: metadata?.avatarSeed,
    avatarStyle: metadata?.avatarStyle,
  };
}

export function resolveAgentScopeForRuntimeEndpoint(endpoint: AgentSessionsPaneRuntimeTarget, agentId: string): AgentScope | null {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) return null;
  const existingScope = findAgentScope(endpoint.sessionPromptScopes, normalizedAgentId);
  if (existingScope) return existingScope;
  if (!endpoint.acceptsDynamicAgents) return null;
  return { kind: 'agent', endpoint: endpoint.endpoint, agentId: normalizedAgentId };
}

export function resolveSessionTitle(entry: AgentSessionsPaneSessionEntry, t: (key: string, options?: Record<string, unknown>) => string): string {
  const text = entry.title;
  if (!text) return inferUntitledSessionLabel(entry.session, t);
  if (entry.session.titleSource === 'user') return text;
  const title = normalizeAutomaticSessionTitle(text);
  const displayTitle = entry.session.kind === 'automation' ? title?.replace(/^Automation:\s*/, '') : title;
  return displayTitle?.replace(/\s+/g, ' ').trim() || inferUntitledSessionLabel(entry.session, t);
}

interface UseAgentSessionsPaneViewModelInput {
  agentsByRuntime: Record<string, ResourceStateMeta<SubagentSummary[]>>;
  sessionEntries: readonly AgentSessionsPaneSessionEntry[];
  sessionsError: string | null;
  runtimeEndpoints: readonly AgentSessionsPaneRuntimeEndpoint[];
}

export function useAgentSessionsPaneViewModel(input: UseAgentSessionsPaneViewModelInput) {
  const { agentsByRuntime, sessionEntries, sessionsError, runtimeEndpoints } = input;
  const directoryEndpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const directoryStatus = useRuntimeEndpointsStore((state) => state.status);
  const visibleRuntimeEndpoints = useMemo(() => {
    const endpoints = new Map(runtimeEndpoints.map((endpoint) => [endpoint.runtimeScopeKey, endpoint]));
    const localEndpoints = LOCAL_RUNTIME_ENDPOINTS.map((local): AgentSessionsPaneRuntimeEndpoint => {
      const { runtimeScopeKey } = local;
      const existing = endpoints.get(runtimeScopeKey);
      endpoints.delete(runtimeScopeKey);
      if (existing?.target) return existing;
      const declared = directoryEndpoints.find((endpoint) => buildRuntimeEndpointKey(endpoint.endpointRef) === runtimeScopeKey);
      return {
        runtimeScopeKey, endpoint: local.endpoint, target: null, agentCatalogSource: null, agents: [],
        ...existing, displayName: declared?.displayName ?? local.displayName,
      };
    });
    return [...localEndpoints, ...endpoints.values()];
  }, [directoryEndpoints, runtimeEndpoints]);
  const matchaDiagnosticScope = useMemo<AgentScope | null>(() => {
    const endpoint = directoryEndpoints.find((entry) => entry.endpointRef.kind === 'native-runtime'
      && entry.endpointRef.runtimeAdapterId === 'matcha-agent' && entry.endpointRef.runtimeInstanceId === 'local');
    return endpoint && isSessionRuntimeEndpointReady(endpoint) && endpoint.defaultAgentId
      && supportsSessionChat(endpoint, endpoint.defaultAgentId)
      ? { kind: 'agent', endpoint: endpoint.endpointRef, agentId: endpoint.defaultAgentId } : null;
  }, [directoryEndpoints]);
  const ordinaryEntries = useMemo(() => sessionEntries.filter((entry) => entry.session.ownership?.kind === 'ordinary'), [sessionEntries]);
  const runtimeInputs = useMemo(() => visibleRuntimeEndpoints.map((endpoint) => {
    const managementAgents = selectAgentsResource({ agentsByRuntime }, endpoint.endpoint).data;
    const agentIds = new Set(endpoint.agents.map((agent) => agent.agentId));
    if (usesManagementAgents(endpoint)) {
      for (const agent of managementAgents) if (agent.id.trim()) agentIds.add(agent.id.trim());
    }
    return {
      runtimeScopeKey: endpoint.runtimeScopeKey,
      runtimeLabel: endpoint.displayName,
      agents: Array.from(agentIds, (agentId) => {
        const agent = resolveRuntimeAgentSummary(endpoint, agentId, managementAgents);
        return { agentId, agentName: agent.name || agentId, avatarSeed: agent.avatarSeed, avatarStyle: agent.avatarStyle };
      }),
    };
  }), [visibleRuntimeEndpoints, agentsByRuntime]);
  const agentResults = useMemo(() => buildAgentSessionSwitchboardModel({
    runtimeResults: runtimeInputs, sessionEntries: ordinaryEntries,
  }).map((runtime, index) => {
    const endpoint = visibleRuntimeEndpoints[index];
    const resource = usesManagementAgents(endpoint) ? selectAgentsResource({ agentsByRuntime }, endpoint.endpoint) : null;
    return { ...runtime,
      endpoint,
      runtimeStatus: LOCAL_RUNTIME_SCOPE_KEYS.has(endpoint.runtimeScopeKey) ? runtimeSidebarStatus(directoryEndpoints.find((entry) =>
        buildRuntimeEndpointKey(entry.endpointRef) === endpoint.runtimeScopeKey), directoryStatus) : null,
      isLoading: runtime.agents.length === 0 && resource !== null && !resource.hasLoadedOnce && resource.status !== 'error',
      errorMessage: resource?.error ?? null };
  }), [ordinaryEntries, runtimeInputs, visibleRuntimeEndpoints, agentsByRuntime, directoryEndpoints, directoryStatus]);
  return { agentResults, matchaDiagnosticScope, sessionErrorMessage: sessionsError };
}
