import { useDeferredValue, useMemo, useRef } from 'react';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import type { ResourceStateMeta } from '@/lib/resource-state';
import type { ChatSession } from '@/stores/chat';
import type { AgentSessionsPaneSessionEntry } from '@/stores/chat/selectors';

const SESSION_TITLE_MAX_LENGTH = 48;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SessionBucketId =
  | 'within_3_days'
  | 'within_7_days'
  | 'within_30_days'
  | 'older_than_30_days';

interface SessionBucketSpec {
  id: SessionBucketId;
  labelKey: string;
  minAgeMs?: number;
  maxAgeMs?: number;
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
    id: 'within_3_days',
    labelKey: 'sidebar.sessionBucketWithin3Days',
    maxAgeMs: 3 * DAY_MS,
    defaultCollapsed: false,
  },
  {
    id: 'within_7_days',
    labelKey: 'sidebar.sessionBucketWithin7Days',
    minAgeMs: 3 * DAY_MS,
    maxAgeMs: 7 * DAY_MS,
    defaultCollapsed: true,
  },
  {
    id: 'within_30_days',
    labelKey: 'sidebar.sessionBucketWithin30Days',
    minAgeMs: 7 * DAY_MS,
    maxAgeMs: 30 * DAY_MS,
    defaultCollapsed: true,
  },
  {
    id: 'older_than_30_days',
    labelKey: 'sidebar.sessionBucketOlderThan30Days',
    minAgeMs: 30 * DAY_MS,
    defaultCollapsed: true,
  },
];

export function parseAgentIdFromSessionKey(key: string): string | null {
  const matched = key.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? null;
}

export function readSessionSuffix(sessionKey: string): string {
  const suffix = sessionKey.split(':').slice(2).join(':');
  return suffix || sessionKey;
}

function parseSessionTimestamp(sessionKey: string): number | null {
  const suffix = readSessionSuffix(sessionKey);
  const matched = suffix.match(/session-(\d{8,16})/i);
  if (!matched) {
    return null;
  }
  const raw = Number(matched[1]);
  if (!Number.isFinite(raw)) {
    return null;
  }
  return matched[1].length <= 10 ? raw * 1000 : raw;
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

function resolvePreferredSessionKey(agentId: string, sessions: ChatSession[]): string | null {
  const canonical = `agent:${agentId}:main`;
  const canonicalMatch = sessions.find((session) => session.key === canonical);
  if (canonicalMatch) {
    return canonicalMatch.key;
  }
  if (sessions.length > 0) {
    return sessions[0].key;
  }
  return null;
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
  return parseSessionTimestamp(session.key) ?? 0;
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
    const agentId = parseAgentIdFromSessionKey(key);
    if (!agentId) {
      if (entriesByKey.has(key)) {
        entriesByKey.delete(key);
        removeSortedSessionKey(sortedKeys, key);
      }
      continue;
    }
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

function matchesBucket(ageMs: number, spec: SessionBucketSpec): boolean {
  if (typeof spec.minAgeMs === 'number' && ageMs < spec.minAgeMs) {
    return false;
  }
  if (typeof spec.maxAgeMs === 'number' && ageMs >= spec.maxAgeMs) {
    return false;
  }
  return true;
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

  const now = Date.now();
  for (const entry of entries) {
    const activityMs = resolveSessionActivityMs(entry);
    const ageMs = Math.max(0, now - activityMs);
    const matched = SESSION_BUCKET_SPECS.find((spec) => matchesBucket(ageMs, spec));
    const bucket = matched ? bucketsById.get(matched.id) : bucketsById.get('older_than_30_days');
    if (bucket) {
      bucket.sessions.push(entry);
    }
  }

  return SESSION_BUCKET_SPECS
    .map((spec) => bucketsById.get(spec.id))
    .filter((bucket): bucket is SessionBucketNode => bucket != null && bucket.sessions.length > 0);
}

function formatSessionMeta(session: ChatSession, activityMs: number, locale: string): string {
  const ts = activityMs || parseSessionTimestamp(session.key);
  if (ts) {
    return new Date(ts).toLocaleString(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  const suffix = readSessionSuffix(session.key);
  return suffix.length > 36 ? `${suffix.slice(0, 36)}...` : suffix;
}

export function inferUntitledSessionLabel(
  session: ChatSession,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const suffix = readSessionSuffix(session.key).trim().toLowerCase();
  if (suffix.startsWith('subagent:')) {
    return t('sidebar.subSession');
  }
  if (/^session-\d{8,16}$/i.test(suffix)) {
    return t('sidebar.newSession');
  }
  if (suffix === 'main') {
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
  currentSessionKey: string;
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
        [agentId, resolvePreferredSessionKey(agentId, agentSessions)] as const
      )),
    );
  }, [sessionAggregation.sessionsByAgent]);

  const agentNodeById = useMemo(() => {
    return new Map(agentNodes.map((node) => [node.agentId, node] as const));
  }, [agentNodes]);

  const activeAgentId = useMemo(() => {
    const current = parseAgentIdFromSessionKey(input.currentSessionKey);
    if (current) {
      return current;
    }
    return agentNodes[0]?.agentId ?? 'main';
  }, [agentNodes, input.currentSessionKey]);

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
        agentId: sessionOwner?.agentId ?? parseAgentIdFromSessionKey(session.key) ?? 'main',
        agentName: sessionOwner?.agentName ?? parseAgentIdFromSessionKey(session.key) ?? 'main',
        avatarSeed: sessionOwner?.avatarSeed,
        avatarStyle: sessionOwner?.avatarStyle,
        deleteLabel: input.t('sidebar.deleteSessionAria', { title: sessionTitle }),
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

