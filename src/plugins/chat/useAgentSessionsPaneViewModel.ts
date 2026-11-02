import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { isSessionRuntimeEndpointReady, useRuntimeEndpointsStore } from '@/plugins/runtime/directory';
import { buildRuntimeEndpointKey } from '@/types/desktop/runtime-address';
import type { AgentAvatarStyle } from '@/types/subagent';
import type { ResourceStateMeta } from '@/lib/resource-state';
import { findAgentScope } from '@/plugins/chat/store/session-identity';
import { inferUntitledSessionLabel, normalizeAutomaticSessionTitle } from '@/plugins/chat/session-catalog';
import type { AgentSessionsPaneSessionEntry } from '@/plugins/chat/store/selectors';
import type { ChatSessionRuntimeEndpointNode, ChatSessionRuntimeEndpointTarget } from '@/plugins/chat/store/types';
import type { AgentScope } from '@/types/desktop/runtime-address';
import { buildAgentSessionSwitchboardModel } from '@/plugins/chat/agent-session-switchboard-model';

interface SidebarAgentSummary {
  id: string;
  name?: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

export function resolveRuntimeAgentSummary(
  endpoint: ChatSessionRuntimeEndpointNode,
  agentId: string,
  managementAgents: readonly SidebarAgentSummary[],
): SidebarAgentSummary {
  const graphAgent = endpoint.agents.find((agent) => agent.agentId === agentId);
  if (endpoint.target?.agentCatalog.source !== 'subagent-management') {
    return { id: agentId, name: graphAgent?.catalogEntry?.name?.trim() || agentId };
  }
  const metadata = managementAgents.find((agent) => agent.id === agentId);
  const seed = endpoint.target.agentCatalog.seedAgents.find((agent) => agent.id === agentId);
  return {
    id: agentId,
    name: metadata?.name?.trim() || seed?.name?.trim() || agentId,
    avatarSeed: metadata?.avatarSeed,
    avatarStyle: metadata?.avatarStyle,
  };
}

export function resolveAgentScopeForRuntimeEndpoint(endpoint: ChatSessionRuntimeEndpointTarget, agentId: string): AgentScope | null {
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
  subagentManagementAgents: readonly SidebarAgentSummary[];
  subagentManagementAgentsResource: ResourceStateMeta;
  subagentManagementRuntimeScopeKey: string | null;
  sessionEntries: readonly AgentSessionsPaneSessionEntry[];
  sessionsLoadedOnce: boolean;
  sessionsError: string | null;
  runtimeEndpoints: readonly ChatSessionRuntimeEndpointNode[];
}

export function useAgentSessionsPaneViewModel(input: UseAgentSessionsPaneViewModelInput) {
  const { subagentManagementAgents, subagentManagementAgentsResource, subagentManagementRuntimeScopeKey, sessionEntries,
    sessionsLoadedOnce, sessionsError, runtimeEndpoints } = input;
  const readyOpenClawScopes = useRuntimeEndpointsStore(useShallow((state) => state.endpoints
    .filter((endpoint) => endpoint.endpointRef.kind === 'native-runtime'
      && endpoint.endpointRef.runtimeAdapterId === 'openclaw' && isSessionRuntimeEndpointReady(endpoint))
    .map((endpoint) => buildRuntimeEndpointKey(endpoint.endpointRef))));
  const visibleRuntimeEndpoints = useMemo(() => runtimeEndpoints.filter((endpoint) => endpoint.endpoint.kind !== 'native-runtime'
    || endpoint.endpoint.runtimeAdapterId !== 'openclaw'
    || (endpoint.target !== null && readyOpenClawScopes.includes(endpoint.runtimeScopeKey))), [readyOpenClawScopes, runtimeEndpoints]);
  const ordinaryEntries = useMemo(() => sessionEntries.filter((entry) => entry.session.ownership?.kind === 'ordinary'), [sessionEntries]);
  const runtimeInputs = useMemo(() => visibleRuntimeEndpoints.map((endpoint) => {
    const managementAgents = endpoint.runtimeScopeKey === subagentManagementRuntimeScopeKey ? subagentManagementAgents : [];
    const agentIds = new Set(endpoint.agents.map((agent) => agent.agentId));
    if (endpoint.target?.agentCatalog.source === 'subagent-management') {
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
  }), [visibleRuntimeEndpoints, subagentManagementAgents, subagentManagementRuntimeScopeKey]);
  const agentResults = useMemo(() => buildAgentSessionSwitchboardModel({
    runtimeResults: runtimeInputs, sessionEntries: ordinaryEntries,
  }), [ordinaryEntries, runtimeInputs]);
  const requiresManagement = visibleRuntimeEndpoints.some((endpoint) => endpoint.runtimeScopeKey === subagentManagementRuntimeScopeKey
    && endpoint.target?.agentCatalog.source === 'subagent-management');
  const agentListState = requiresManagement && !subagentManagementAgentsResource.hasLoadedOnce
    ? subagentManagementAgentsResource.status === 'error' ? 'error' : 'loading'
    : 'ready';
  const hasSessions = agentResults.some((runtime) => runtime.agents.some((agent) => agent.sessionCount > 0));
  return {
    agentResults,
    agentListState: agentListState as 'loading' | 'error' | 'ready',
    agentErrorMessage: requiresManagement ? subagentManagementAgentsResource.error : null,
    sessionListState: (!sessionsLoadedOnce && !hasSessions ? sessionsError ? 'error' : 'loading' : 'ready') as 'loading' | 'error' | 'ready',
    sessionErrorMessage: sessionsError,
  };
}
