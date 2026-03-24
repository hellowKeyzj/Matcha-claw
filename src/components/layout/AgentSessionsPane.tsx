import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSubagentsStore } from '@/stores/subagents';
import { useChatStore, type ChatSession } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PaneEdgeToggle } from '@/components/layout/PaneEdgeToggle';

interface AgentSessionsPaneProps {
  expandedWidth?: number;
  collapsed?: boolean;
  collapsedWidth?: number;
  onToggleCollapse?: () => void;
}

interface AgentSessionNode {
  agentId: string;
  agentName: string;
  identityEmoji?: string;
  sessions: ChatSession[];
}

interface SessionListNode {
  session: ChatSession;
  agentId: string;
  agentName: string;
  identityEmoji?: string;
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

function resolvePreferredSessionKey(agentId: string, sessions: ChatSession[]): string {
  const canonical = `agent:${agentId}:main`;
  const canonicalMatch = sessions.find((session) => session.key === canonical);
  if (canonicalMatch) {
    return canonicalMatch.key;
  }
  if (sessions.length > 0) {
    return sessions[0].key;
  }
  return canonical;
}

function resolveAgentEmoji(explicitEmoji: string | undefined, isDefault: boolean): string {
  if (explicitEmoji && explicitEmoji.trim()) {
    return explicitEmoji;
  }
  return isDefault ? '⚙️' : '🤖';
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
  preferredSessionKey: string;
  isAgentActive: boolean;
  newSessionLabel: string;
  onSwitchSession: (sessionKey: string) => void;
  onCreateSessionForAgent: (agentId: string) => void;
}

const AgentListItem = memo(function AgentListItem({
  node,
  preferredSessionKey,
  isAgentActive,
  newSessionLabel,
  onSwitchSession,
  onCreateSessionForAgent,
}: AgentListItemProps) {
  return (
    <div
      key={node.agentId}
      className={cn(
        'group flex items-center gap-1 rounded-lg pr-1 transition-colors',
        isAgentActive
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/70 hover:text-accent-foreground',
      )}
    >
      <button
        type="button"
        data-testid={`agent-item-${node.agentId}`}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-sm font-medium"
        onClick={() => onSwitchSession(preferredSessionKey)}
      >
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs leading-none"
        >
          {node.identityEmoji}
        </span>
        <span className="truncate">{node.agentName}</span>
      </button>
      <button
        type="button"
        data-testid={`agent-new-session-${node.agentId}`}
        className="shrink-0 rounded p-1 text-muted-foreground/80 opacity-0 transition group-hover:opacity-100 hover:bg-accent"
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
  identityEmoji: string;
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
  identityEmoji,
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
        'group flex items-center gap-1 rounded-lg transition-colors',
        isCurrent
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/70 hover:text-accent-foreground',
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
        onClick={() => onSwitchSession(session.key)}
      >
        <span
          aria-hidden
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted/80 text-[10px] leading-none"
        >
          {identityEmoji}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{sessionTitle}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground/80">{sessionMeta}</span>
        </span>
      </button>
      {!session.key.endsWith(':main') && (
        <button
          type="button"
          className="mr-1 shrink-0 rounded p-1 text-muted-foreground/70 opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
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
}: AgentSessionsPaneProps) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const agents = useSubagentsStore((state) => state.agents);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const sessions = useChatStore((state) => state.sessions);
  const sessionLabels = useChatStore((state) => state.sessionLabels);
  const sessionLastActivity = useChatStore((state) => state.sessionLastActivity);
  const currentSessionKey = useChatStore((state) => state.currentSessionKey);
  const switchSession = useChatStore((state) => state.switchSession);
  const newSession = useChatStore((state) => state.newSession);
  const deleteSession = useChatStore((state) => state.deleteSession);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const isGatewayRunning = useGatewayStore((state) => state.status.state === 'running');
  const deferredSessions = useDeferredValue(sessions);
  const deferredSessionLabels = useDeferredValue(sessionLabels);
  const deferredSessionLastActivity = useDeferredValue(sessionLastActivity);
  const [collapsedSessionBuckets, setCollapsedSessionBuckets] = useState<Record<string, boolean>>(
    () => loadCollapsedSessionBucketMap(),
  );
  const [deletingSessionKeys, setDeletingSessionKeys] = useState<Record<string, true>>({});
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{
    key: string;
    title: string;
  } | null>(null);

  useEffect(() => {
    if (!isGatewayRunning) {
      return;
    }
    void loadAgents();
    void loadSessions();
  }, [isGatewayRunning, loadAgents, loadSessions]);

  const agentSessionNodes = useMemo<AgentSessionNode[]>(() => {
    const agentById = new Map(agents.map((agent) => [agent.id, agent] as const));
    const agentOrder = new Map(agents.map((agent, index) => [agent.id, index] as const));
    const sessionsByAgent = new Map<string, ChatSession[]>();

    for (const session of deferredSessions) {
      const agentId = parseAgentIdFromSessionKey(session.key);
      if (!agentId) {
        continue;
      }
      const bucket = sessionsByAgent.get(agentId) ?? [];
      bucket.push(session);
      sessionsByAgent.set(agentId, bucket);
    }

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
        const sortedSessions = [...(sessionsByAgent.get(agentId) ?? [])].sort((left, right) => {
          const leftActivity = deferredSessionLastActivity[left.key] ?? parseSessionTimestamp(left.key) ?? 0;
          const rightActivity = deferredSessionLastActivity[right.key] ?? parseSessionTimestamp(right.key) ?? 0;
          if (leftActivity !== rightActivity) {
            return rightActivity - leftActivity;
          }
          return left.key.localeCompare(right.key);
        });
        return {
          agentId,
          agentName: agent?.name?.trim() || agentId,
          identityEmoji: resolveAgentEmoji(agent?.identityEmoji ?? agent?.identity?.emoji, Boolean(agent?.isDefault)),
          sessions: sortedSessions,
        };
      });
  }, [agents, deferredSessionLastActivity, deferredSessions]);

  const preferredSessionKeyByAgent = useMemo(() => {
    return new Map(
      agentSessionNodes.map((node) => [node.agentId, resolvePreferredSessionKey(node.agentId, node.sessions)] as const),
    );
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
    for (const agentNode of agentSessionNodes) {
      const preferredSessionKey = preferredSessionKeyByAgent.get(agentNode.agentId);
      for (const session of agentNode.sessions) {
        if (session.key === preferredSessionKey) {
          continue;
        }
        nodes.push({
          session,
          agentId: agentNode.agentId,
          agentName: agentNode.agentName,
          identityEmoji: agentNode.identityEmoji,
        });
      }
    }

    nodes.sort((left, right) => {
      const leftActivity = deferredSessionLastActivity[left.session.key] ?? parseSessionTimestamp(left.session.key) ?? 0;
      const rightActivity = deferredSessionLastActivity[right.session.key] ?? parseSessionTimestamp(right.session.key) ?? 0;
      if (leftActivity !== rightActivity) {
        return rightActivity - leftActivity;
      }
      return left.session.key.localeCompare(right.session.key);
    });
    return nodes;
  }, [agentSessionNodes, deferredSessionLastActivity, preferredSessionKeyByAgent]);

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
    const map = new Map<string, { title: string; meta: string; emoji: string; deleteLabel: string }>();
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
        emoji: sessionOwner?.identityEmoji ?? '🤖',
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
      className="relative flex shrink-0 flex-col border-r border-border/80 bg-card"
      style={{ width: collapsed ? collapsedWidth : expandedWidth }}
    >
      {collapsed ? (
        <div className="flex flex-1 flex-col items-center gap-2 px-1 py-3">
          <span className="px-1 text-xs text-muted-foreground [writing-mode:vertical-rl]">
            {t('sidebar.agentSessions')}
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('sidebar.agentSessions')}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => handleCreateSessionForAgent(activeAgentId)}
              aria-label={t('sidebar.newSession')}
              title={t('sidebar.newSession')}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-2">
            <section className="flex min-h-0 max-h-[42%] flex-col space-y-1">
              <p className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('sidebar.subagents')}
              </p>
              <div
                data-testid="agent-list-scroll-area"
                className="min-h-0 overflow-y-auto pr-1"
              >
                {agentSessionNodes.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">{t('sidebar.noSubagents')}</p>
                ) : (
                  <div className="space-y-1">
                    {agentSessionNodes.map((node) => (
                      <AgentListItem
                        key={node.agentId}
                        node={node}
                        preferredSessionKey={preferredSessionKeyByAgent.get(node.agentId) ?? `agent:${node.agentId}:main`}
                        isAgentActive={activeAgentId === node.agentId}
                        newSessionLabel={t('sidebar.newSession')}
                        onSwitchSession={handleSwitchSession}
                        onCreateSessionForAgent={handleCreateSessionForAgent}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="flex min-h-0 flex-1 flex-col space-y-1 border-t border-border/70 pt-3">
              <p className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('sidebar.agentSessions')}
              </p>
              <div
                data-testid="session-list-scroll-area"
                className="min-h-0 flex-1 overflow-y-auto pr-1"
              >
                {globalSessions.length === 0 ? (
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
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
                          >
                            {bucketCollapsed ? (
                              <ChevronRight className="h-3 w-3 shrink-0" />
                            ) : (
                              <ChevronDown className="h-3 w-3 shrink-0" />
                            )}
                            <span className="truncate">{bucket.label}</span>
                            <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
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
                                    identityEmoji={viewModel?.emoji ?? '🤖'}
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
            className="w-full max-w-md rounded-lg border bg-background p-4 shadow-lg"
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
