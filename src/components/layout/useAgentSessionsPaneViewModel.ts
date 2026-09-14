import { useDeferredValue, useMemo } from 'react';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import type { ResourceStateMeta } from '@/lib/resource-state';
import type { ChatSession } from '@/stores/chat';
import { findAgentScope } from '@/stores/chat/session-identity';
import {
  normalizeAutomaticSessionTitle,
  parseSessionCreatedAtMs,
} from '@/stores/chat/session-helpers';
import type { AgentSessionsPaneSessionEntry } from '@/stores/chat/selectors';
import type {
  ChatCurrentConversation,
  ChatSessionRuntimeEndpointNode,
  ChatSessionRuntimeEndpointTarget,
} from '@/stores/chat/types';
import type { AgentScope } from '../../../electron/desktop-contract/runtime-address';
import {
  buildAgentSessionSwitchboardModel,
  isAgentSessionSwitchboardAutomationSession,
  type AgentSessionSwitchboardAgentSessionSourceInput,
  type AgentSessionSwitchboardModel,
  type AgentSessionSwitchboardTeamInput,
} from './agent-session-switchboard-model';

const SESSION_TITLE_MAX_LENGTH = 48;

export type SessionBucketId =
  | 'today'
  | 'within_7_days'
  | 'within_30_days'
  | 'older';

interface SessionBucketSpec {
  id: SessionBucketId;
  labelKey: string;
  maxAgeDays?: number;
  defaultCollapsed: boolean;
}

interface SessionSortEntry {
  entry: AgentSessionsPaneSessionEntry;
  agentId: string;
  activityMs: number;
}

interface SessionActivityIndex {
  entriesByKey: Map<string, SessionSortEntry>;
  sortedKeys: string[];
}

interface SessionAggregation {
  sessionsByAgent: Map<string, ChatSession[]>;
  sortedSessionKeys: string[];
  entryByKey: Map<string, SessionSortEntry>;
}

interface SidebarAgentSummary {
  id: string;
  name?: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  preferredSessionKey?: string | null;
}

function addNonEmptyAgentId(agentIds: Set<string>, agentId: string | null | undefined): void {
  const normalizedAgentId = agentId?.trim();
  if (normalizedAgentId) {
    agentIds.add(normalizedAgentId);
  }
}

function buildRuntimeEndpointAgentIds(
  seedAgentIds: readonly string[],
  agents: SidebarAgentSummary[],
): string[] {
  const agentIds = new Set<string>();
  for (const agentId of seedAgentIds) {
    addNonEmptyAgentId(agentIds, agentId);
  }
  for (const agent of agents) {
    addNonEmptyAgentId(agentIds, agent.id);
  }
  return Array.from(agentIds);
}

function createRuntimeAgentSessionCountKey(runtimeScopeKey: string, agentId: string): string {
  return JSON.stringify([runtimeScopeKey, agentId]);
}

function buildRuntimeEndpointAgentSummaries(
  endpoint: ChatSessionRuntimeEndpointNode,
  agents: SidebarAgentSummary[],
): SidebarAgentSummary[] {
  const target = endpoint.target;
  if (!target) {
    return endpoint.agents.map((agent) => ({
      id: agent.agentId,
      name: agent.catalogEntry?.name?.trim() || agent.agentId,
      preferredSessionKey: agent.preferredSessionKey,
    }));
  }
  if (target.agentCatalog.source === 'runtime-endpoint') {
    return endpoint.agents.map((agent) => ({
      id: agent.agentId,
      name: agent.catalogEntry?.name?.trim() || agent.agentId,
      preferredSessionKey: agent.preferredSessionKey,
    }));
  }

  const agentMetadataById = new Map(agents.map((agent) => [agent.id, agent] as const));
  const seedAgentById = new Map(target.agentCatalog.seedAgents.map((agent) => [agent.id, agent] as const));
  const graphAgentById = new Map(endpoint.agents.map((agent) => [agent.agentId, agent] as const));
  const graphAgentIds = endpoint.agents.map((agent) => agent.agentId);
  return buildRuntimeEndpointAgentIds(graphAgentIds, agents).map((agentId) => {
    const metadata = agentMetadataById.get(agentId);
    const seedAgent = seedAgentById.get(agentId);
    return {
      id: agentId,
      name: metadata?.name?.trim() || seedAgent?.name?.trim() || agentId,
      avatarSeed: metadata?.avatarSeed,
      avatarStyle: metadata?.avatarStyle,
      preferredSessionKey: graphAgentById.get(agentId)?.preferredSessionKey ?? null,
    };
  });
}

function filterSessionEntriesByRuntimeEndpoint(
  sessionEntries: readonly AgentSessionsPaneSessionEntry[],
  endpoint: ChatSessionRuntimeEndpointNode | null,
): AgentSessionsPaneSessionEntry[] {
  if (!endpoint) {
    return [];
  }
  const sessionKeys = new Set(
    endpoint.agents.flatMap((agent) => agent.sessions.map((session) => session.sessionRecordKey)),
  );
  return sessionEntries.filter((entry) => sessionKeys.has(entry.session.key));
}

export function resolveAgentScopeForRuntimeEndpoint(
  endpoint: ChatSessionRuntimeEndpointTarget,
  agentId: string,
): AgentScope | null {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return null;
  }
  const existingScope = findAgentScope(endpoint.sessionPromptScopes, normalizedAgentId);
  if (existingScope) {
    return existingScope;
  }
  if (!endpoint.acceptsDynamicAgents) {
    return null;
  }
  return {
    ...endpoint.defaultSessionPromptScope,
    agentId: normalizedAgentId,
  };
}

export interface AgentSessionNode {
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  sessions: ChatSession[];
  preferredSessionKey: string | null;
}

interface SessionListNode {
  entry: AgentSessionsPaneSessionEntry;
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

export interface SessionBucketNode {
  id: SessionBucketId;
  label: string;
  sessions: AgentSessionsPaneSessionEntry[];
  defaultCollapsed: boolean;
}

export interface SessionViewModel {
  title: string;
  meta: string;
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  deleteLabel: string;
  renameLabel: string;
  saveRenameLabel: string;
  cancelRenameLabel: string;
}

export interface AgentSessionsPaneViewModel {
  activeAgentId: string;
  agentNodes: AgentSessionNode[];
  sessionBuckets: SessionBucketNode[];
  sessionViewModelByKey: Map<string, SessionViewModel>;
  switchboard: AgentSessionSwitchboardModel;
  agentListState: 'loading' | 'error' | 'ready';
  agentErrorMessage: string | null;
  sessionListState: 'loading' | 'error' | 'ready';
  sessionErrorMessage: string | null;
}

const SESSION_BUCKET_SPECS: SessionBucketSpec[] = [
  {
    id: 'today',
    labelKey: 'sidebar.sessionBucketToday',
    maxAgeDays: 1,
    defaultCollapsed: false,
  },
  {
    id: 'within_7_days',
    labelKey: 'sidebar.sessionBucketWithin7Days',
    maxAgeDays: 7,
    defaultCollapsed: false,
  },
  {
    id: 'within_30_days',
    labelKey: 'sidebar.sessionBucketWithin30Days',
    maxAgeDays: 30,
    defaultCollapsed: true,
  },
  {
    id: 'older',
    labelKey: 'sidebar.sessionBucketOlder',
    defaultCollapsed: true,
  },
];

export function readSessionSuffix(session: Pick<ChatSession, 'key' | 'sessionIdentity'> | string): string {
  const sessionKey = typeof session === 'string' ? session : session.sessionIdentity.sessionKey;
  const suffix = sessionKey.split(':').slice(2).join(':');
  return suffix || sessionKey;
}

function normalizeSessionTitle(text: string, automatic: boolean): string {
  const title = automatic ? normalizeAutomaticSessionTitle(text) : text.trim();
  const cleaned = title ? title.replace(/\s+/g, ' ').trim() : '';
  if (!cleaned) {
    return '';
  }
  if (cleaned.length <= SESSION_TITLE_MAX_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
}

function resolvePreferredSessionKey(sessions: ChatSession[]): string | null {
  return sessions.find((session) => session.preferred || session.kind === 'main')?.key ?? null;
}

function resolveSessionActivityMs(
  entry: AgentSessionsPaneSessionEntry,
): number {
  const fromStore = entry.lastActivityAt;
  if (typeof fromStore === 'number' && Number.isFinite(fromStore)) {
    return fromStore;
  }
  const session = entry.session;
  if (typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)) {
    return session.updatedAt;
  }
  return parseSessionCreatedAtMs(session.sessionIdentity.sessionKey) ?? 0;
}

function compareSessionSortEntries(left: SessionSortEntry, right: SessionSortEntry): number {
  if (left.activityMs !== right.activityMs) {
    return right.activityMs - left.activityMs;
  }
  return left.entry.session.key.localeCompare(right.entry.session.key);
}

function buildSessionActivityIndex(sessionEntries: AgentSessionsPaneSessionEntry[]): SessionActivityIndex {
  const entriesByKey = new Map<string, SessionSortEntry>();
  const sortedEntries = sessionEntries.map((entry) => {
    const session = entry.session;
    const sortEntry = {
      entry,
      agentId: session.agentId,
      activityMs: resolveSessionActivityMs(entry),
    };
    entriesByKey.set(session.key, sortEntry);
    return sortEntry;
  });
  sortedEntries.sort(compareSessionSortEntries);

  return {
    entriesByKey,
    sortedKeys: sortedEntries.map((entry) => entry.entry.session.key),
  };
}

function buildSessionAggregation(index: SessionActivityIndex): SessionAggregation {
  const sessionsByAgent = new Map<string, ChatSession[]>();
  for (const key of index.sortedKeys) {
    const entry = index.entriesByKey.get(key);
    if (!entry) {
      continue;
    }
    const bucket = sessionsByAgent.get(entry.agentId) ?? [];
    bucket.push(entry.entry.session);
    sessionsByAgent.set(entry.agentId, bucket);
  }
  return {
    sessionsByAgent,
    sortedSessionKeys: [...index.sortedKeys],
    entryByKey: index.entriesByKey,
  };
}

function startOfLocalDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function resolveActivityAgeDays(activityMs: number, now: Date): number {
  const todayStartMs = startOfLocalDay(now);
  const activityDayStartMs = startOfLocalDay(new Date(activityMs));
  return Math.max(0, Math.floor((todayStartMs - activityDayStartMs) / (24 * 60 * 60 * 1000)));
}

function matchesBucket(ageDays: number, spec: SessionBucketSpec): boolean {
  return spec.maxAgeDays == null || ageDays < spec.maxAgeDays;
}

function buildSessionBuckets(
  entries: AgentSessionsPaneSessionEntry[],
  t: (key: string, options?: Record<string, unknown>) => string,
): SessionBucketNode[] {
  const bucketsById = new Map<SessionBucketId, SessionBucketNode>(
    SESSION_BUCKET_SPECS.map((spec) => [
      spec.id,
      {
        id: spec.id,
        label: t(spec.labelKey),
        sessions: [],
        defaultCollapsed: spec.defaultCollapsed,
      },
    ]),
  );

  const now = new Date();
  for (const entry of entries) {
    const activityMs = resolveSessionActivityMs(entry);
    const ageDays = resolveActivityAgeDays(activityMs, now);
    const matched = SESSION_BUCKET_SPECS.find((spec) => matchesBucket(ageDays, spec));
    const bucket = matched ? bucketsById.get(matched.id) : bucketsById.get('older');
    if (bucket) {
      bucket.sessions.push(entry);
    }
  }

  return SESSION_BUCKET_SPECS
    .map((spec) => bucketsById.get(spec.id))
    .filter((bucket): bucket is SessionBucketNode => bucket != null && bucket.sessions.length > 0);
}

function formatSessionMeta(session: ChatSession, activityMs: number, locale: string): string {
  const ts = activityMs;
  if (ts) {
    return new Date(ts).toLocaleString(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  const suffix = readSessionSuffix(session);
  return suffix.length > 36 ? `${suffix.slice(0, 36)}...` : suffix;
}

export function inferUntitledSessionLabel(
  session: ChatSession,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (session.kind === 'subsession') {
    return t('sidebar.subSession');
  }
  if (session.kind === 'session') {
    return t('sidebar.newSession');
  }
  if (session.kind === 'main') {
    return t('sidebar.defaultSession');
  }
  return t('sidebar.untitledSession');
}

interface UseAgentSessionsPaneViewModelInput {
  subagentManagementAgents: SidebarAgentSummary[];
  subagentManagementAgentsResource: ResourceStateMeta;
  sessionEntries: AgentSessionsPaneSessionEntry[];
  switchboardSessionEntries?: readonly AgentSessionsPaneSessionEntry[];
  sessionsLoading: boolean;
  sessionsLoadedOnce: boolean;
  sessionsError: string | null;
  currentConversation: ChatCurrentConversation | null;
  selectedRuntimeEndpoint: ChatSessionRuntimeEndpointNode | null;
  runtimeEndpoints?: readonly ChatSessionRuntimeEndpointNode[];
  teams?: readonly AgentSessionSwitchboardTeamInput[];
  locale: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function useAgentSessionsPaneViewModel(
  input: UseAgentSessionsPaneViewModelInput,
): AgentSessionsPaneViewModel {
  const {
    subagentManagementAgents,
    subagentManagementAgentsResource,
    sessionEntries,
    switchboardSessionEntries,
    sessionsLoadedOnce,
    sessionsError,
    currentConversation,
    selectedRuntimeEndpoint,
    runtimeEndpoints,
    teams,
    locale,
    t,
  } = input;

  const switchboardRuntimeEndpoints = useMemo(
    () => runtimeEndpoints ?? (selectedRuntimeEndpoint ? [selectedRuntimeEndpoint] : []),
    [runtimeEndpoints, selectedRuntimeEndpoint],
  );
  const runtimeAgentSummaries = useMemo(
    () => selectedRuntimeEndpoint
      ? buildRuntimeEndpointAgentSummaries(selectedRuntimeEndpoint, subagentManagementAgents)
      : [],
    [subagentManagementAgents, selectedRuntimeEndpoint],
  );
  const switchboardRuntimeAgentSummariesByScopeKey = useMemo(() => {
    return new Map(switchboardRuntimeEndpoints.map((endpoint) => [
      endpoint.runtimeScopeKey,
      buildRuntimeEndpointAgentSummaries(endpoint, subagentManagementAgents),
    ] as const));
  }, [subagentManagementAgents, switchboardRuntimeEndpoints]);
  const visibleSessionEntries = useMemo(
    () => sessionEntries.filter((entry) => !isAgentSessionSwitchboardAutomationSession(entry.session)),
    [sessionEntries],
  );
  const runtimeSessionEntries = useMemo(
    () => filterSessionEntriesByRuntimeEndpoint(visibleSessionEntries, selectedRuntimeEndpoint),
    [visibleSessionEntries, selectedRuntimeEndpoint],
  );
  const deferredSessionEntries = useDeferredValue(runtimeSessionEntries);
  const sessionAggregation = useMemo<SessionAggregation>(() => buildSessionAggregation(
    buildSessionActivityIndex(deferredSessionEntries),
  ), [deferredSessionEntries]);

  const switchboardInputSessionEntries = switchboardSessionEntries ?? sessionEntries;
  const switchboardSortedSessionEntries = useMemo(() => {
    const nextIndex = buildSessionActivityIndex([...switchboardInputSessionEntries]);
    return nextIndex.sortedKeys
      .map((key) => nextIndex.entriesByKey.get(key)?.entry)
      .filter((entry): entry is AgentSessionsPaneSessionEntry => entry != null);
  }, [switchboardInputSessionEntries]);

  const agentNodes = useMemo<AgentSessionNode[]>(() => {
    const sessionsByAgent = sessionAggregation.sessionsByAgent;
    return runtimeAgentSummaries.map((agent) => {
      const sessions = sessionsByAgent.get(agent.id) ?? [];
      return {
        agentId: agent.id,
        agentName: agent.name?.trim() || agent.id,
        avatarSeed: agent.avatarSeed,
        avatarStyle: agent.avatarStyle,
        sessions,
        preferredSessionKey: agent.preferredSessionKey ?? resolvePreferredSessionKey(sessions),
      };
    });
  }, [runtimeAgentSummaries, sessionAggregation]);

  const preferredSessionKeyByAgent = useMemo(() => {
    return new Map(
      Array.from(sessionAggregation.sessionsByAgent.entries()).map(([agentId, agentSessions]) => (
        [agentId, resolvePreferredSessionKey(agentSessions)] as const
      )),
    );
  }, [sessionAggregation.sessionsByAgent]);

  const agentNodeById = useMemo(() => {
    return new Map(agentNodes.map((node) => [node.agentId, node] as const));
  }, [agentNodes]);

  const activeAgentId = useMemo(() => {
    const conversation = currentConversation;
    if (!conversation || conversation.runtimeScopeKey !== selectedRuntimeEndpoint?.runtimeScopeKey) {
      return '';
    }
    return conversation.agentId;
  }, [currentConversation, selectedRuntimeEndpoint]);

  const globalSessionNodes = useMemo<SessionListNode[]>(() => {
    const nodes: SessionListNode[] = [];
    for (const sessionKey of sessionAggregation.sortedSessionKeys) {
      const entry = sessionAggregation.entryByKey.get(sessionKey);
      if (!entry) {
        continue;
      }
      if (preferredSessionKeyByAgent.get(entry.agentId) === sessionKey) {
        continue;
      }
      const owner = agentNodeById.get(entry.agentId);
      nodes.push({
        entry: entry.entry,
        agentId: entry.agentId,
        agentName: owner?.agentName ?? entry.agentId,
        avatarSeed: owner?.avatarSeed,
        avatarStyle: owner?.avatarStyle,
      });
    }
    return nodes;
  }, [agentNodeById, preferredSessionKeyByAgent, sessionAggregation]);

  const globalSessionEntries = useMemo(
    () => globalSessionNodes.map((node) => node.entry),
    [globalSessionNodes],
  );

  const globalSessionOwnerByKey = useMemo(() => {
    const map = new Map<string, SessionListNode>();
    for (const node of globalSessionNodes) {
      map.set(node.entry.session.key, node);
    }
    return map;
  }, [globalSessionNodes]);

  const resolveSessionTitle = useMemo(() => {
    return (entry: AgentSessionsPaneSessionEntry): string => {
      const title = entry.title?.trim();
      if (title) {
        return normalizeSessionTitle(title, entry.session.titleSource !== 'user');
      }
      return inferUntitledSessionLabel(entry.session, t);
    };
  }, [t]);

  const sessionBuckets = useMemo(
    () => buildSessionBuckets(globalSessionEntries, t),
    [globalSessionEntries, t],
  );

  const sessionViewModelByKey = useMemo(() => {
    const map = new Map<string, SessionViewModel>();
    for (const entry of globalSessionEntries) {
      const session = entry.session;
      const sessionTitle = resolveSessionTitle(entry);
      const sessionOwner = globalSessionOwnerByKey.get(session.key);
      const activityMs = resolveSessionActivityMs(entry);
      const sessionMeta = sessionOwner
        ? `${sessionOwner.agentName} / ${formatSessionMeta(session, activityMs, locale)}`
        : formatSessionMeta(session, activityMs, locale);
      map.set(session.key, {
        title: sessionTitle,
        meta: sessionMeta,
        agentId: sessionOwner?.agentId ?? session.agentId,
        agentName: sessionOwner?.agentName ?? session.agentId,
        avatarSeed: sessionOwner?.avatarSeed,
        avatarStyle: sessionOwner?.avatarStyle,
        deleteLabel: t('sidebar.deleteSessionAria', { title: sessionTitle }),
        renameLabel: t('sidebar.renameSessionAria', { title: sessionTitle }),
        saveRenameLabel: t('sidebar.saveSessionRenameAria', { title: sessionTitle }),
        cancelRenameLabel: t('sidebar.cancelSessionRenameAria', { title: sessionTitle }),
      });
    }
    return map;
  }, [globalSessionEntries, globalSessionOwnerByKey, locale, t, resolveSessionTitle]);

  const switchboardSessionSourceIndex = useMemo(() => {
    const sessionCountByRuntimeAgent = new Map<string, number>();
    const agentSourceByKey = new Map<string, AgentSessionSwitchboardAgentSessionSourceInput>();
    const endpointsBySessionKey = new Map<string, ChatSessionRuntimeEndpointNode>();
    const agentSummaryByRuntimeAgentKey = new Map<string, SidebarAgentSummary>();
    for (const endpoint of switchboardRuntimeEndpoints) {
      for (const agent of switchboardRuntimeAgentSummariesByScopeKey.get(endpoint.runtimeScopeKey) ?? []) {
        agentSummaryByRuntimeAgentKey.set(createRuntimeAgentSessionCountKey(endpoint.runtimeScopeKey, agent.id), agent);
      }
      for (const agent of endpoint.agents) {
        for (const session of agent.sessions) {
          endpointsBySessionKey.set(session.sessionRecordKey, endpoint);
        }
      }
    }
    for (const entry of switchboardSortedSessionEntries) {
      const endpoint = endpointsBySessionKey.get(entry.session.key);
      if (!endpoint) {
        continue;
      }
      const agentKey = createRuntimeAgentSessionCountKey(endpoint.runtimeScopeKey, entry.session.agentId);
      const agentSummary = agentSummaryByRuntimeAgentKey.get(agentKey);
      const agentName = agentSummary?.name?.trim() || entry.session.agentId;
      const source: AgentSessionSwitchboardAgentSessionSourceInput = {
        runtimeScopeKey: endpoint.runtimeScopeKey,
        runtimeLabel: endpoint.displayName,
        agentId: entry.session.agentId,
        agentName,
        avatarSeed: agentSummary?.avatarSeed,
        avatarStyle: agentSummary?.avatarStyle,
      };
      agentSourceByKey.set(entry.session.key, source);
      if (!isAgentSessionSwitchboardAutomationSession(entry.session)) {
        sessionCountByRuntimeAgent.set(agentKey, (sessionCountByRuntimeAgent.get(agentKey) ?? 0) + 1);
      }
    }
    return { agentSourceByKey, sessionCountByRuntimeAgent };
  }, [switchboardRuntimeAgentSummariesByScopeKey, switchboardRuntimeEndpoints, switchboardSortedSessionEntries]);

  const switchboardRuntimeResults = useMemo(() => {
    return switchboardRuntimeEndpoints.map((endpoint) => ({
      runtimeScopeKey: endpoint.runtimeScopeKey,
      runtimeLabel: endpoint.displayName,
      agents: (switchboardRuntimeAgentSummariesByScopeKey.get(endpoint.runtimeScopeKey) ?? []).map((agent) => ({
        agentId: agent.id,
        agentName: agent.name?.trim() || agent.id,
        avatarSeed: agent.avatarSeed,
        avatarStyle: agent.avatarStyle,
        preferredSessionKey: agent.preferredSessionKey ?? null,
        sessionCount: switchboardSessionSourceIndex.sessionCountByRuntimeAgent.get(createRuntimeAgentSessionCountKey(endpoint.runtimeScopeKey, agent.id)) ?? 0,
      })),
    }));
  }, [switchboardRuntimeAgentSummariesByScopeKey, switchboardRuntimeEndpoints, switchboardSessionSourceIndex]);

  const switchboardSessionViewModelByKey = useMemo(() => {
    const map = new Map<string, SessionViewModel>();
    for (const entry of switchboardSortedSessionEntries) {
      const session = entry.session;
      const sessionTitle = resolveSessionTitle(entry);
      const agentSource = switchboardSessionSourceIndex.agentSourceByKey.get(session.key);
      const activityMs = resolveSessionActivityMs(entry);
      const sessionMeta = agentSource
        ? `${agentSource.agentName} / ${formatSessionMeta(session, activityMs, locale)}`
        : formatSessionMeta(session, activityMs, locale);
      map.set(session.key, {
        title: sessionTitle,
        meta: sessionMeta,
        agentId: agentSource?.agentId ?? session.agentId,
        agentName: agentSource?.agentName ?? session.agentId,
        avatarSeed: agentSource?.avatarSeed,
        avatarStyle: agentSource?.avatarStyle,
        deleteLabel: t('sidebar.deleteSessionAria', { title: sessionTitle }),
        renameLabel: t('sidebar.renameSessionAria', { title: sessionTitle }),
        saveRenameLabel: t('sidebar.saveSessionRenameAria', { title: sessionTitle }),
        cancelRenameLabel: t('sidebar.cancelSessionRenameAria', { title: sessionTitle }),
      });
    }
    return map;
  }, [locale, t, resolveSessionTitle, switchboardSessionSourceIndex.agentSourceByKey, switchboardSortedSessionEntries]);

  const switchboardSessionBuckets = useMemo(
    () => buildSessionBuckets(switchboardSortedSessionEntries, t),
    [t, switchboardSortedSessionEntries],
  );

  const switchboard = useMemo(() => buildAgentSessionSwitchboardModel({
    currentConversation: currentConversation,
    selectedRuntimeEndpoint: selectedRuntimeEndpoint,
    runtimeResults: switchboardRuntimeResults,
    teamResults: teams ?? [],
    sessionResults: {
      buckets: switchboardSessionBuckets,
      viewModelByKey: switchboardSessionViewModelByKey,
      agentSourceByKey: switchboardSessionSourceIndex.agentSourceByKey,
    },
  }), [currentConversation, selectedRuntimeEndpoint, teams, switchboardRuntimeResults, switchboardSessionBuckets, switchboardSessionSourceIndex.agentSourceByKey, switchboardSessionViewModelByKey]);

  const requiresSubagentManagementCatalog = switchboardRuntimeEndpoints.some((endpoint) => endpoint.target?.agentCatalog.source === 'subagent-management');
  const agentListState = requiresSubagentManagementCatalog
    && !subagentManagementAgentsResource.hasLoadedOnce
    && (subagentManagementAgentsResource.status === 'idle' || subagentManagementAgentsResource.status === 'loading')
    ? 'loading'
    : (requiresSubagentManagementCatalog && !subagentManagementAgentsResource.hasLoadedOnce && subagentManagementAgentsResource.status === 'error' ? 'error' : 'ready');

  const hasSwitchboardSessions = switchboardInputSessionEntries.length > 0;
  const sessionListState = !sessionsLoadedOnce && !hasSwitchboardSessions
    ? (sessionsError ? 'error' : 'loading')
    : 'ready';

  return {
    activeAgentId,
    agentNodes,
    sessionBuckets,
    sessionViewModelByKey,
    switchboard,
    agentListState,
    agentErrorMessage: requiresSubagentManagementCatalog ? subagentManagementAgentsResource.error : null,
    sessionListState,
    sessionErrorMessage: hasSwitchboardSessions ? null : sessionsError,
  };
}
