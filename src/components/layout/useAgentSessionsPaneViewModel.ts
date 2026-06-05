import { useDeferredValue, useMemo, useRef } from 'react';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import type { ResourceStateMeta } from '@/lib/resource-state';
import type { ChatSession } from '@/stores/chat';
import type { AgentSessionsPaneSessionEntry } from '@/stores/chat/selectors';
import { parseSessionCreatedAtMs } from '@/stores/chat/session-helpers';

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
}

export interface AgentSessionNode {
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  sessions: ChatSession[];
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

export function readSessionSuffix(session: Pick<ChatSession, 'key' | 'backendSessionKey'> | string): string {
  const sessionKey = typeof session === 'string' ? session : session.backendSessionKey;
  const suffix = sessionKey.split(':').slice(2).join(':');
  return suffix || sessionKey;
}

function normalizeSessionTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
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
  return parseSessionCreatedAtMs(session.backendSessionKey) ?? 0;
}

function compareSessionSortEntries(left: SessionSortEntry, right: SessionSortEntry): number {
  if (left.activityMs !== right.activityMs) {
    return right.activityMs - left.activityMs;
  }
  return left.entry.session.key.localeCompare(right.entry.session.key);
}

function removeSortedSessionKey(sortedKeys: string[], key: string): void {
  const index = sortedKeys.indexOf(key);
  if (index >= 0) {
    sortedKeys.splice(index, 1);
  }
}

function insertSortedSessionKey(
  sortedKeys: string[],
  key: string,
  entriesByKey: Map<string, SessionSortEntry>,
): void {
  const nextEntry = entriesByKey.get(key);
  if (!nextEntry) {
    return;
  }
  let low = 0;
  let high = sortedKeys.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const midEntry = entriesByKey.get(sortedKeys[mid]);
    if (!midEntry) {
      low = mid + 1;
      continue;
    }
    const compare = compareSessionSortEntries(nextEntry, midEntry);
    if (compare < 0) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  sortedKeys.splice(low, 0, key);
}

function buildIncrementalSessionActivityIndex(input: {
  previous: SessionActivityIndex;
  sessionEntries: AgentSessionsPaneSessionEntry[];
}): SessionActivityIndex {
  const entriesByKey = new Map(input.previous.entriesByKey);
  const sortedKeys = [...input.previous.sortedKeys];
  const seen = new Set<string>();

  for (const entry of input.sessionEntries) {
    const session = entry.session;
    const key = session.key;
    seen.add(key);
    const agentId = session.agentId;
    const activityMs = resolveSessionActivityMs(entry);
    const previousEntry = entriesByKey.get(key);
    if (!previousEntry) {
      entriesByKey.set(key, { entry, agentId, activityMs });
      insertSortedSessionKey(sortedKeys, key, entriesByKey);
      continue;
    }
    const sortChanged = previousEntry.agentId !== agentId || previousEntry.activityMs !== activityMs;
    if (sortChanged) {
      removeSortedSessionKey(sortedKeys, key);
      entriesByKey.set(key, { entry, agentId, activityMs });
      insertSortedSessionKey(sortedKeys, key, entriesByKey);
      continue;
    }
    if (previousEntry.entry !== entry) {
      entriesByKey.set(key, {
        ...previousEntry,
        entry,
      });
    }
  }

  for (const key of Array.from(entriesByKey.keys())) {
    if (seen.has(key)) {
      continue;
    }
    entriesByKey.delete(key);
    removeSortedSessionKey(sortedKeys, key);
  }

  return {
    entriesByKey,
    sortedKeys,
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
  agents: SidebarAgentSummary[];
  agentsResource: ResourceStateMeta;
  sessionEntries: AgentSessionsPaneSessionEntry[];
  sessionsLoading: boolean;
  sessionsLoadedOnce: boolean;
  sessionsError: string | null;
  currentAgentId: string;
  locale: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function useAgentSessionsPaneViewModel(
  input: UseAgentSessionsPaneViewModelInput,
): AgentSessionsPaneViewModel {
  const deferredSessionEntries = useDeferredValue(input.sessionEntries);
  const sessionActivityIndexRef = useRef<SessionActivityIndex>({
    entriesByKey: new Map<string, SessionSortEntry>(),
    sortedKeys: [],
  });

  const sessionAggregation = useMemo<SessionAggregation>(() => {
    const nextIndex = buildIncrementalSessionActivityIndex({
      previous: sessionActivityIndexRef.current,
      sessionEntries: deferredSessionEntries,
    });
    sessionActivityIndexRef.current = nextIndex;
    return buildSessionAggregation(nextIndex);
  }, [deferredSessionEntries]);

  const agentNodes = useMemo<AgentSessionNode[]>(() => {
    const sessionsByAgent = sessionAggregation.sessionsByAgent;
    return input.agents.map((agent) => ({
      agentId: agent.id,
      agentName: agent.name?.trim() || agent.id,
      avatarSeed: agent.avatarSeed,
      avatarStyle: agent.avatarStyle,
      sessions: sessionsByAgent.get(agent.id) ?? [],
    }));
  }, [input.agents, sessionAggregation]);

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
    return input.currentAgentId || agentNodes[0]?.agentId || '';
  }, [agentNodes, input.currentAgentId]);

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
        return normalizeSessionTitle(title);
      }
      return inferUntitledSessionLabel(entry.session, input.t);
    };
  }, [input.t]);

  const sessionBuckets = useMemo(
    () => buildSessionBuckets(globalSessionEntries, input.t),
    [globalSessionEntries, input.t],
  );

  const sessionViewModelByKey = useMemo(() => {
    const map = new Map<string, SessionViewModel>();
    for (const entry of globalSessionEntries) {
      const session = entry.session;
      const sessionTitle = resolveSessionTitle(entry);
      const sessionOwner = globalSessionOwnerByKey.get(session.key);
      const activityMs = resolveSessionActivityMs(entry);
      const sessionMeta = sessionOwner
        ? `${sessionOwner.agentName} / ${formatSessionMeta(session, activityMs, input.locale)}`
        : formatSessionMeta(session, activityMs, input.locale);
      map.set(session.key, {
        title: sessionTitle,
        meta: sessionMeta,
        agentId: sessionOwner?.agentId ?? session.agentId,
        agentName: sessionOwner?.agentName ?? session.agentId,
        avatarSeed: sessionOwner?.avatarSeed,
        avatarStyle: sessionOwner?.avatarStyle,
        deleteLabel: input.t('sidebar.deleteSessionAria', { title: sessionTitle }),
        renameLabel: input.t('sidebar.renameSessionAria', { title: sessionTitle }),
        saveRenameLabel: input.t('sidebar.saveSessionRenameAria', { title: sessionTitle }),
        cancelRenameLabel: input.t('sidebar.cancelSessionRenameAria', { title: sessionTitle }),
      });
    }
    return map;
  }, [globalSessionEntries, globalSessionOwnerByKey, input.locale, input.t, resolveSessionTitle]);

  const agentListState = !input.agentsResource.hasLoadedOnce
    && (input.agentsResource.status === 'idle' || input.agentsResource.status === 'loading')
    ? 'loading'
    : (!input.agentsResource.hasLoadedOnce && input.agentsResource.status === 'error' ? 'error' : 'ready');

  const sessionListState = !input.sessionsLoadedOnce && input.sessionEntries.length === 0
    ? (input.sessionsError ? 'error' : 'loading')
    : 'ready';

  return {
    activeAgentId,
    agentNodes,
    sessionBuckets,
    sessionViewModelByKey,
    agentListState,
    agentErrorMessage: input.agentsResource.error,
    sessionListState,
    sessionErrorMessage: input.sessionEntries.length === 0 ? input.sessionsError : null,
  };
}
