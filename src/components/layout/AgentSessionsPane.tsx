import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';
import { useSubagentsStore } from '@/stores/subagents';
import { useChatStore, type ChatSession } from '@/stores/chat';
import { selectAgentSessionsPaneState } from '@/stores/chat/selectors';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PaneEdgeToggle } from '@/components/layout/PaneEdgeToggle';
import { useShallow } from 'zustand/react/shallow';

interface AgentSessionsPaneProps {
  expandedWidth?: number;
  collapsed?: boolean;
  collapsedWidth?: number;
  onToggleCollapse?: () => void;
  showRightDivider?: boolean;
}

interface AgentSessionNode {
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  sessions: ChatSession[];
}

interface SessionListNode {
  session: ChatSession;
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

interface SessionSortEntry {
  session: ChatSession;
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

const SESSION_BUCKET_COLLAPSE_STORAGE_KEY = 'layout:session-time-bucket-collapsed';
const SESSION_TITLE_MAX_LENGTH = 48;
const DAY_MS = 24 * 60 * 60 * 1000;

interface SessionBucketSpec {
  id: 'within_3_days' | 'within_7_days' | 'within_30_days' | 'older_than_30_days';
  labelKey: string;
  minAgeMs?: number;
  maxAgeMs?: number;
  defaultCollapsed: boolean;
}

interface SessionBucketNode {
  id: SessionBucketSpec['id'];
  label: string;
  sessions: ChatSession[];
  defaultCollapsed: boolean;
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

function parseAgentIdFromSessionKey(key: string): string | null {
  const matched = key.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? null;
}

function readSessionSuffix(sessionKey: string): string {
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

function createSessionBucketStateKey(bucketId: SessionBucketSpec['id']): string {
  return bucketId;
}

function loadCollapsedSessionBucketMap(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(SESSION_BUCKET_COLLAPSE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key.trim() || typeof value !== 'boolean') {
        continue;
      }
      next[key] = value;
    }
    return next;
  } catch {
    return {};
  }
}

function resolveSessionActivityMs(
  session: ChatSession,
  sessionLastActivityMap: Record<string, number>,
): number {
  const fromStore = sessionLastActivityMap[session.key];
  if (typeof fromStore === 'number' && Number.isFinite(fromStore)) {
    return fromStore;
  }
  if (typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)) {
    return session.updatedAt;
  }
  return parseSessionTimestamp(session.key) ?? 0;
}

function compareSessionSortEntries(left: SessionSortEntry, right: SessionSortEntry): number {
  if (left.activityMs !== right.activityMs) {
    return right.activityMs - left.activityMs;
  }
  return left.session.key.localeCompare(right.session.key);
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
  sessions: ChatSession[];
  sessionLastActivityMap: Record<string, number>;
}): SessionActivityIndex {
  const entriesByKey = new Map(input.previous.entriesByKey);
  const sortedKeys = [...input.previous.sortedKeys];
  const seen = new Set<string>();

  for (const session of input.sessions) {
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
    const activityMs = resolveSessionActivityMs(session, input.sessionLastActivityMap);
    const previousEntry = entriesByKey.get(key);
    if (!previousEntry) {
      entriesByKey.set(key, { session, agentId, activityMs });
      insertSortedSessionKey(sortedKeys, key, entriesByKey);
      continue;
    }
    const sortChanged = previousEntry.agentId !== agentId || previousEntry.activityMs !== activityMs;
    if (sortChanged) {
      removeSortedSessionKey(sortedKeys, key);
      entriesByKey.set(key, { session, agentId, activityMs });
      insertSortedSessionKey(sortedKeys, key, entriesByKey);
      continue;
    }
    if (previousEntry.session !== session) {
      entriesByKey.set(key, {
        ...previousEntry,
        session,
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
    bucket.push(entry.session);
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
  sessions: ChatSession[],
  sessionLastActivityMap: Record<string, number>,
  t: (key: string, options?: Record<string, unknown>) => string,
): SessionBucketNode[] {
  const bucketsById = new Map<SessionBucketSpec['id'], SessionBucketNode>(
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
  for (const session of sessions) {
    const activityMs = resolveSessionActivityMs(session, sessionLastActivityMap);
    const ageMs = Math.max(0, now - activityMs);
    const matched = SESSION_BUCKET_SPECS.find((spec) => matchesBucket(ageMs, spec));
    const bucket = matched ? bucketsById.get(matched.id) : bucketsById.get('older_than_30_days');
    if (bucket) {
      bucket.sessions.push(session);
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

function inferUntitledSessionLabel(
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

interface AgentListItemProps {
  node: AgentSessionNode;
  isAgentActive: boolean;
  newSessionLabel: string;
  onOpenAgent: (agentId: string) => void;
  onCreateSessionForAgent: (agentId: string) => void;
}

const AgentListItem = memo(function AgentListItem({
  node,
  isAgentActive,
  newSessionLabel,
  onOpenAgent,
  onCreateSessionForAgent,
}: AgentListItemProps) {
  return (
    <div
      key={node.agentId}
      className={cn(
        'group flex items-center gap-1 rounded-[calc(var(--radius-interactive)+2px)] pr-1 transition-[background-color,color,box-shadow]',
        isAgentActive
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      <button
        type="button"
        data-testid={`agent-item-${node.agentId}`}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-sm font-medium"
        onClick={() => onOpenAgent(node.agentId)}
      >
        <AgentAvatar
          agentId={node.agentId}
          agentName={node.agentName}
          avatarSeed={node.avatarSeed}
          avatarStyle={node.avatarStyle}
          className="h-5 w-5"
          dataTestId={`agent-session-avatar-${node.agentId}`}
        />
        <span className="truncate">{node.agentName}</span>
      </button>
      <button
        type="button"
        data-testid={`agent-new-session-${node.agentId}`}
        className="shrink-0 rounded-full p-1 text-current/80 opacity-0 transition group-hover:opacity-100 hover:bg-card/15"
        aria-label={`${newSessionLabel} ${node.agentName}`}
        title={`${newSessionLabel} ${node.agentName}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCreateSessionForAgent(node.agentId);
        }}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
});

interface SessionListItemProps {
  session: ChatSession;
  sessionTitle: string;
  sessionMeta: string;
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  isCurrent: boolean;
  deleting: boolean;
  deleteLabel: string;
  onSwitchSession: (sessionKey: string) => void;
  onRequestDelete: (session: ChatSession) => void;
}

const SessionListItem = memo(function SessionListItem({
  session,
  sessionTitle,
  sessionMeta,
  agentId,
  agentName,
  avatarSeed,
  avatarStyle,
  isCurrent,
  deleting,
  deleteLabel,
  onSwitchSession,
  onRequestDelete,
}: SessionListItemProps) {
  return (
    <div
      key={session.key}
      className={cn(
        'group flex items-center gap-1 rounded-[calc(var(--radius-interactive)+2px)] transition-[background-color,color,box-shadow]',
        isCurrent
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
        onClick={() => onSwitchSession(session.key)}
      >
        <AgentAvatar
          agentId={agentId}
          agentName={agentName}
          avatarSeed={avatarSeed}
          avatarStyle={avatarStyle}
          className="h-4 w-4"
          dataTestId={`session-avatar-${session.key}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{sessionTitle}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground/80">{sessionMeta}</span>
        </span>
      </button>
      {!session.key.endsWith(':main') && (
        <button
        type="button"
        className="mr-1 shrink-0 rounded-full p-1 text-current/70 opacity-0 transition hover:bg-destructive/15 hover:text-destructive-foreground group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={deleteLabel}
        title={deleteLabel}
        disabled={deleting}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestDelete(session);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
});

export const AgentSessionsPane = memo(function AgentSessionsPane({
  expandedWidth = 300,
  collapsed = false,
  collapsedWidth = 52,
  onToggleCollapse,
  showRightDivider = true,
}: AgentSessionsPaneProps) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const agents = useSubagentsStore((state) => state.agents);
  const subagentsSnapshotReady = useSubagentsStore((state) => state.snapshotReady);
  const subagentsInitialLoading = useSubagentsStore((state) => state.initialLoading);
  const {
    sessions,
    sessionLabels,
    sessionLastActivity,
    currentSessionKey,
    switchSession,
    openAgentConversation,
    newSession,
    deleteSession,
  } = useChatStore(useShallow(selectAgentSessionsPaneState));
  const deferredSessions = useDeferredValue(sessions);
  const deferredSessionLabels = useDeferredValue(sessionLabels);
  const deferredSessionLastActivity = useDeferredValue(sessionLastActivity);
  const agentDataReady = subagentsSnapshotReady || agents.length > 0;
  const showAgentLoading = !agentDataReady || subagentsInitialLoading;
  const [collapsedSessionBuckets, setCollapsedSessionBuckets] = useState<Record<string, boolean>>(
    () => loadCollapsedSessionBucketMap(),
  );
  const [deletingSessionKeys, setDeletingSessionKeys] = useState<Record<string, true>>({});
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{
    key: string;
    title: string;
  } | null>(null);
  const sessionActivityIndexRef = useRef<SessionActivityIndex>({
    entriesByKey: new Map<string, SessionSortEntry>(),
    sortedKeys: [],
  });

  const sessionAggregation = useMemo<SessionAggregation>(() => {
    const nextIndex = buildIncrementalSessionActivityIndex({
      previous: sessionActivityIndexRef.current,
      sessions: deferredSessions,
      sessionLastActivityMap: deferredSessionLastActivity,
    });
    sessionActivityIndexRef.current = nextIndex;
    return buildSessionAggregation(nextIndex);
  }, [deferredSessionLastActivity, deferredSessions]);

  const agentSessionNodes = useMemo<AgentSessionNode[]>(() => {
    if (!agentDataReady) {
      return [];
    }
    const agentById = new Map(agents.map((agent) => [agent.id, agent] as const));
    const agentOrder = new Map(agents.map((agent, index) => [agent.id, index] as const));
    const sessionsByAgent = sessionAggregation.sessionsByAgent;

    const visibleAgentIds = new Set<string>([
      ...agents.map((agent) => agent.id),
      ...Array.from(sessionsByAgent.keys()),
    ]);

    return [...visibleAgentIds]
      .sort((left, right) => {
        const leftOrder = agentOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = agentOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }
        return left.localeCompare(right);
      })
      .map((agentId) => {
        const agent = agentById.get(agentId);
        return {
          agentId,
          agentName: agent?.name?.trim() || agentId,
          avatarSeed: agent?.avatarSeed,
          avatarStyle: agent?.avatarStyle,
          sessions: sessionsByAgent.get(agentId) ?? [],
        };
      });
  }, [agentDataReady, agents, sessionAggregation]);

  const preferredSessionKeyByAgent = useMemo(() => {
    return new Map(
      agentSessionNodes.map((node) => [node.agentId, resolvePreferredSessionKey(node.agentId, node.sessions)] as const),
    );
  }, [agentSessionNodes]);

  const agentNodeById = useMemo(() => {
    return new Map(agentSessionNodes.map((node) => [node.agentId, node] as const));
  }, [agentSessionNodes]);

  const activeAgentId = useMemo(() => {
    const current = parseAgentIdFromSessionKey(currentSessionKey);
    if (current) {
      return current;
    }
    return agentSessionNodes[0]?.agentId ?? 'main';
  }, [agentSessionNodes, currentSessionKey]);

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
        session: entry.session,
        agentId: entry.agentId,
        agentName: owner?.agentName ?? entry.agentId,
        avatarSeed: owner?.avatarSeed,
        avatarStyle: owner?.avatarStyle,
      });
    }
    return nodes;
  }, [agentNodeById, preferredSessionKeyByAgent, sessionAggregation]);

  const globalSessions = useMemo(() => globalSessionNodes.map((node) => node.session), [globalSessionNodes]);

  const globalSessionOwnerByKey = useMemo(() => {
    const map = new Map<string, SessionListNode>();
    for (const node of globalSessionNodes) {
      map.set(node.session.key, node);
    }
    return map;
  }, [globalSessionNodes]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SESSION_BUCKET_COLLAPSE_STORAGE_KEY,
        JSON.stringify(collapsedSessionBuckets),
      );
    } catch {
      // ignore localStorage failures
    }
  }, [collapsedSessionBuckets]);

  const handleSwitchSession = useCallback((sessionKey: string) => {
    startTransition(() => {
      switchSession(sessionKey);
      navigate('/');
    });
  }, [navigate, switchSession]);

  const handleOpenAgent = useCallback((agentId: string) => {
    startTransition(() => {
      openAgentConversation(agentId);
      navigate('/');
    });
  }, [navigate, openAgentConversation]);

  const handleCreateSessionForAgent = useCallback((agentId: string) => {
    startTransition(() => {
      newSession(agentId);
      navigate('/');
    });
  }, [navigate, newSession]);

  const toggleSessionBucket = useCallback((bucketId: SessionBucketSpec['id'], defaultCollapsed: boolean) => {
    const stateKey = createSessionBucketStateKey(bucketId);
    setCollapsedSessionBuckets((prev) => {
      const current = Object.prototype.hasOwnProperty.call(prev, stateKey)
        ? Boolean(prev[stateKey])
        : defaultCollapsed;
      return { ...prev, [stateKey]: !current };
    });
  }, []);

  const resolveSessionTitle = useCallback((session: ChatSession): string => {
    const topicTitle = deferredSessionLabels[session.key]?.trim();
    if (topicTitle) {
      return normalizeSessionTitle(topicTitle);
    }
    const explicit = (session.displayName || session.label || '').trim();
    if (explicit && explicit !== session.key) {
      return normalizeSessionTitle(explicit);
    }
    return inferUntitledSessionLabel(session, t);
  }, [deferredSessionLabels, t]);

  const globalSessionBuckets = useMemo(
    () => buildSessionBuckets(globalSessions, deferredSessionLastActivity, t),
    [deferredSessionLastActivity, globalSessions, t],
  );

  const sessionViewModelByKey = useMemo(() => {
    const map = new Map<string, {
      title: string;
      meta: string;
      agentId: string;
      agentName: string;
      avatarSeed?: string;
      avatarStyle?: AgentAvatarStyle;
      deleteLabel: string;
    }>();
    for (const session of globalSessions) {
      const sessionTitle = resolveSessionTitle(session);
      const sessionOwner = globalSessionOwnerByKey.get(session.key);
      const activityMs = resolveSessionActivityMs(session, deferredSessionLastActivity);
      const sessionMeta = sessionOwner
        ? `${sessionOwner.agentName} / ${formatSessionMeta(session, activityMs, i18n.language)}`
        : formatSessionMeta(session, activityMs, i18n.language);
      map.set(session.key, {
        title: sessionTitle,
        meta: sessionMeta,
        agentId: sessionOwner?.agentId ?? parseAgentIdFromSessionKey(session.key) ?? 'main',
        agentName: sessionOwner?.agentName ?? parseAgentIdFromSessionKey(session.key) ?? 'main',
        avatarSeed: sessionOwner?.avatarSeed,
        avatarStyle: sessionOwner?.avatarStyle,
        deleteLabel: t('sidebar.deleteSessionAria', { title: sessionTitle }),
      });
    }
    return map;
  }, [deferredSessionLastActivity, globalSessionOwnerByKey, globalSessions, i18n.language, resolveSessionTitle, t]);

  const requestDeleteSession = useCallback((session: ChatSession) => {
    if (session.key.endsWith(':main')) {
      return;
    }
    const title = resolveSessionTitle(session);
    setPendingDeleteSession({
      key: session.key,
      title,
    });
  }, [resolveSessionTitle]);

  const closeDeleteDialog = useCallback(() => {
    if (!pendingDeleteSession) {
      return;
    }
    if (deletingSessionKeys[pendingDeleteSession.key]) {
      return;
    }
    setPendingDeleteSession(null);
  }, [deletingSessionKeys, pendingDeleteSession]);

  const confirmDeleteSession = useCallback(async () => {
    if (!pendingDeleteSession) {
      return;
    }
    const sessionKey = pendingDeleteSession.key;
    setDeletingSessionKeys((prev) => ({ ...prev, [sessionKey]: true }));
    try {
      await deleteSession(sessionKey);
      setPendingDeleteSession(null);
    } finally {
      setDeletingSessionKeys((prev) => {
        const next = { ...prev };
        delete next[sessionKey];
        return next;
      });
    }
  }, [deleteSession, pendingDeleteSession]);

  return (
    <aside
      data-testid="agent-sessions-pane"
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden bg-card',
        showRightDivider && 'border-r [border-right-color:var(--divider-line)]',
      )}
      style={{ width: collapsed ? collapsedWidth : expandedWidth }}
    >
      {collapsed ? (
        <div className="flex flex-1 flex-col items-center gap-2 px-1 py-4">
          <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground [writing-mode:vertical-rl]">
            {t('sidebar.agentSessions')}
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('sidebar.agentSessions')}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => handleCreateSessionForAgent(activeAgentId)}
              aria-label={t('sidebar.newSession')}
              title={t('sidebar.newSession')}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 p-3">
            <section className="flex min-h-0 max-h-[42%] flex-col space-y-1">
              <p className="px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                {t('sidebar.subagents')}
              </p>
              <div
                data-testid="agent-list-scroll-area"
                className="min-h-0 overflow-y-auto pr-1"
              >
                {showAgentLoading ? (
                  <p data-testid="agent-list-loading" className="px-2 py-1 text-xs text-muted-foreground">
                    Loading...
                  </p>
                ) : agentSessionNodes.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">{t('sidebar.noSubagents')}</p>
                ) : (
                  <div className="space-y-1">
                    {agentSessionNodes.map((node) => (
                      <AgentListItem
                        key={node.agentId}
                        node={node}
                        isAgentActive={activeAgentId === node.agentId}
                        newSessionLabel={t('sidebar.newSession')}
                        onOpenAgent={handleOpenAgent}
                        onCreateSessionForAgent={handleCreateSessionForAgent}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="flex min-h-0 flex-1 flex-col space-y-1 border-t border-border/70 pt-4">
              <p className="px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                {t('sidebar.agentSessions')}
              </p>
              <div
                data-testid="session-list-scroll-area"
                className="min-h-0 flex-1 overflow-y-auto pr-1"
              >
                {showAgentLoading ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">Loading...</p>
                ) : globalSessions.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">{t('sidebar.noAgentSessions')}</p>
                ) : (
                  <div className="space-y-1">
                    {globalSessionBuckets.map((bucket) => {
                      const bucketStateKey = createSessionBucketStateKey(bucket.id);
                      const bucketCollapsed = Object.prototype.hasOwnProperty.call(collapsedSessionBuckets, bucketStateKey)
                        ? Boolean(collapsedSessionBuckets[bucketStateKey])
                        : bucket.defaultCollapsed;
                      return (
                        <div key={bucket.id} className="space-y-1">
                          <button
                            type="button"
                            onClick={() => toggleSessionBucket(bucket.id, bucket.defaultCollapsed)}
                            className="flex w-full items-center gap-2 rounded-[calc(var(--radius-interactive)+2px)] px-2.5 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                          >
                            {bucketCollapsed ? (
                              <ChevronRight className="h-3 w-3 shrink-0" />
                            ) : (
                              <ChevronDown className="h-3 w-3 shrink-0" />
                            )}
                            <span className="truncate">{bucket.label}</span>
                            <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                              {bucket.sessions.length}
                            </span>
                          </button>

                          {!bucketCollapsed && (
                            <div className="space-y-1">
                              {bucket.sessions.map((session) => {
                                const viewModel = sessionViewModelByKey.get(session.key);
                                const deleting = Boolean(deletingSessionKeys[session.key]);
                                return (
                                  <SessionListItem
                                    key={session.key}
                                    session={session}
                                    sessionTitle={viewModel?.title ?? inferUntitledSessionLabel(session, t)}
                                    sessionMeta={viewModel?.meta ?? readSessionSuffix(session.key)}
                                    agentId={viewModel?.agentId ?? parseAgentIdFromSessionKey(session.key) ?? 'main'}
                                    agentName={viewModel?.agentName ?? parseAgentIdFromSessionKey(session.key) ?? 'main'}
                                    avatarSeed={viewModel?.avatarSeed}
                                    avatarStyle={viewModel?.avatarStyle}
                                    isCurrent={currentSessionKey === session.key}
                                    deleting={deleting}
                                    deleteLabel={viewModel?.deleteLabel ?? t('sidebar.deleteSessionAria', { title: session.key })}
                                    onSwitchSession={handleSwitchSession}
                                    onRequestDelete={requestDeleteSession}
                                  />
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          </div>
        </>
      )}

      {pendingDeleteSession && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeDeleteDialog();
            }
          }}
        >
          <section
            role="dialog"
            aria-label={t('sidebar.deleteSessionDialogTitle', { title: pendingDeleteSession.title })}
            className="w-full max-w-md rounded-[1.25rem] border border-border bg-card p-5 shadow-elevated"
          >
            <header className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {t('sidebar.deleteSessionDialogTitle', { title: pendingDeleteSession.title })}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('actions.close')}
                onClick={closeDeleteDialog}
                disabled={Boolean(deletingSessionKeys[pendingDeleteSession.key])}
              >
                <X className="h-4 w-4" />
              </Button>
            </header>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('sidebar.deleteSessionDialogDescription', { title: pendingDeleteSession.title })}
            </p>
            <div className="mt-4 flex justify-end">
              <Button
                variant="destructive"
                type="button"
                onClick={() => void confirmDeleteSession()}
                disabled={Boolean(deletingSessionKeys[pendingDeleteSession.key])}
              >
                {deletingSessionKeys[pendingDeleteSession.key]
                  ? t('sidebar.deleteSessionDialogDeleting')
                  : t('sidebar.deleteSessionDialogConfirm')}
              </Button>
            </div>
          </section>
        </div>
      )}

      <PaneEdgeToggle
        side="right"
        onClick={onToggleCollapse}
        ariaLabel={collapsed ? t('sidebar.expandAgentSessions') : t('sidebar.collapseAgentSessions')}
        title={collapsed ? t('sidebar.expandAgentSessions') : t('sidebar.collapseAgentSessions')}
        icon={collapsed ? <ChevronRight className="h-2.5 w-2.5" /> : <ChevronLeft className="h-2.5 w-2.5" />}
      />
    </aside>
  );
});
