import { useMemo } from 'react';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import type { ResourceStateMeta } from '@/lib/resource-state';
import type { ChatSession } from '@/stores/chat';
import { findAgentScope } from '@/stores/chat/session-identity';
import { normalizeAutomaticSessionTitle, parseSessionCreatedAtMs } from '@/stores/chat/session-helpers';
import type { AgentSessionsPaneSessionEntry } from '@/stores/chat/selectors';
import type { ChatCurrentConversation, ChatSessionRuntimeEndpointNode, ChatSessionRuntimeEndpointTarget } from '@/stores/chat/types';
import type { AgentScope } from '../../types/desktop/runtime-address';
import {
  buildAgentSessionSwitchboardModel,
  type AgentSessionSwitchboardSessionBucketInput,
} from './agent-session-switchboard-model';

const SESSION_TITLE_MAX_LENGTH = 48;
export type SessionBucketId = 'today' | 'within_7_days' | 'within_30_days' | 'older';

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

export function readSessionSuffix(session: Pick<ChatSession, 'key' | 'sessionIdentity'> | string): string {
  const sessionKey = typeof session === 'string' ? session : session.sessionIdentity.sessionKey;
  return sessionKey.split(':').slice(2).join(':') || sessionKey;
}

export function inferUntitledSessionLabel(session: ChatSession, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (session.kind === 'subsession') return t('sidebar.subSession');
  if (session.kind === 'session') return t('sidebar.newSession');
  if (session.kind === 'main') return t('sidebar.defaultSession');
  return t('sidebar.untitledSession');
}

export function resolveSessionTitle(entry: AgentSessionsPaneSessionEntry, t: (key: string, options?: Record<string, unknown>) => string): string {
  const text = entry.title?.trim();
  if (!text) return inferUntitledSessionLabel(entry.session, t);
  const title = entry.session.titleSource === 'user' ? text : normalizeAutomaticSessionTitle(text);
  const cleaned = title ? title.replace(/\s+/g, ' ').trim() : '';
  return cleaned.length <= SESSION_TITLE_MAX_LENGTH ? cleaned : `${cleaned.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
}

export function resolveSessionActivityMs(entry: AgentSessionsPaneSessionEntry): number {
  if (typeof entry.lastActivityAt === 'number' && Number.isFinite(entry.lastActivityAt)) return entry.lastActivityAt;
  if (typeof entry.session.updatedAt === 'number' && Number.isFinite(entry.session.updatedAt)) return entry.session.updatedAt;
  return parseSessionCreatedAtMs(entry.session.sessionIdentity.sessionKey) ?? 0;
}

export function formatSessionMeta(entry: AgentSessionsPaneSessionEntry, formatter: Intl.DateTimeFormat): string {
  const activityMs = resolveSessionActivityMs(entry);
  if (activityMs) return formatter.format(activityMs);
  const suffix = readSessionSuffix(entry.session);
  return suffix.length > 36 ? `${suffix.slice(0, 36)}...` : suffix;
}

const SESSION_BUCKET_SPECS = [
  { id: 'today', labelKey: 'sidebar.sessionBucketToday', maxAgeDays: 1, defaultCollapsed: false },
  { id: 'within_7_days', labelKey: 'sidebar.sessionBucketWithin7Days', maxAgeDays: 7, defaultCollapsed: false },
  { id: 'within_30_days', labelKey: 'sidebar.sessionBucketWithin30Days', maxAgeDays: 30, defaultCollapsed: true },
  { id: 'older', labelKey: 'sidebar.sessionBucketOlder', maxAgeDays: Infinity, defaultCollapsed: true },
] as const;

function startOfLocalDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function buildSessionBuckets(entries: readonly AgentSessionsPaneSessionEntry[], t: (key: string) => string): AgentSessionSwitchboardSessionBucketInput[] {
  const buckets: AgentSessionSwitchboardSessionBucketInput[] = SESSION_BUCKET_SPECS.map((spec) => ({
    id: spec.id, label: t(spec.labelKey), defaultCollapsed: spec.defaultCollapsed, sessions: [],
  }));
  const today = startOfLocalDay(new Date());
  // Directory entries already use this same finite activity/createdAt fallback and key tie-break.
  for (const entry of entries) {
    const activityMs = resolveSessionActivityMs(entry);
    const age = Math.max(0, Math.floor((today - startOfLocalDay(new Date(activityMs))) / 86400000));
    const index = SESSION_BUCKET_SPECS.findIndex((spec) => age < spec.maxAgeDays);
    buckets[index].sessions.push(entry);
  }
  return buckets.filter((bucket) => bucket.sessions.length > 0);
}

interface UseAgentSessionsPaneViewModelInput {
  subagentManagementAgents: readonly SidebarAgentSummary[];
  subagentManagementAgentsResource: ResourceStateMeta;
  subagentManagementRuntimeScopeKey: string | null;
  sessionEntries: readonly AgentSessionsPaneSessionEntry[];
  sessionsLoadedOnce: boolean;
  sessionsError: string | null;
  currentConversation: ChatCurrentConversation | null;
  selectedRuntimeEndpoint: ChatSessionRuntimeEndpointNode | null;
  runtimeEndpoints: readonly ChatSessionRuntimeEndpointNode[];
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function useAgentSessionsPaneViewModel(input: UseAgentSessionsPaneViewModelInput) {
  const { subagentManagementAgents, subagentManagementAgentsResource, subagentManagementRuntimeScopeKey, sessionEntries,
    sessionsLoadedOnce, sessionsError, currentConversation, selectedRuntimeEndpoint, runtimeEndpoints, t } = input;
  const ordinaryEntries = useMemo(() => sessionEntries.filter((entry) => entry.session.ownership?.kind === 'ordinary'), [sessionEntries]);
  const runtimeInputs = useMemo(() => runtimeEndpoints.map((endpoint) => {
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
        return { agentId, agentName: agent.name || agentId, avatarSeed: agent.avatarSeed, avatarStyle: agent.avatarStyle, sessionCount: 0 };
      }),
    };
  }), [runtimeEndpoints, subagentManagementAgents, subagentManagementRuntimeScopeKey]);
  const buckets = useMemo(() => buildSessionBuckets(ordinaryEntries, t), [ordinaryEntries, t]);
  const switchboard = useMemo(() => buildAgentSessionSwitchboardModel({
    currentConversation, selectedRuntimeEndpoint, runtimeResults: runtimeInputs, teamResults: [],
    sessionResults: { buckets },
  }), [buckets, currentConversation, runtimeInputs, selectedRuntimeEndpoint]);
  const requiresManagement = runtimeEndpoints.some((endpoint) => endpoint.runtimeScopeKey === subagentManagementRuntimeScopeKey
    && endpoint.target?.agentCatalog.source === 'subagent-management');
  const agentListState = requiresManagement && !subagentManagementAgentsResource.hasLoadedOnce
    ? subagentManagementAgentsResource.status === 'error' ? 'error' : 'loading'
    : 'ready';
  const hasSessions = ordinaryEntries.length > 0;
  return {
    switchboard,
    agentListState: agentListState as 'loading' | 'error' | 'ready',
    agentErrorMessage: requiresManagement ? subagentManagementAgentsResource.error : null,
    sessionListState: (!sessionsLoadedOnce && !hasSessions ? sessionsError ? 'error' : 'loading' : 'ready') as 'loading' | 'error' | 'ready',
    sessionErrorMessage: hasSessions ? null : sessionsError,
  };
}
