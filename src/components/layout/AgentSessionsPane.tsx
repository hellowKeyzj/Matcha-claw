import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSubagentsStore } from '@/stores/subagents';
import { useChatStore, type ChatSession } from '@/stores/chat';
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

const AGENT_GROUP_COLLAPSE_STORAGE_KEY = 'layout:agent-session-group-collapsed';
const SESSION_TITLE_MAX_LENGTH = 48;

function parseAgentIdFromSessionKey(key: string): string | null {
  const matched = key.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? null;
}

function buildDefaultAgentSessionKey(agentId: string): string {
  return `agent:${agentId}:main`;
}

function readSessionSuffix(sessionKey: string): string {
  const suffix = sessionKey.split(':').slice(2).join(':');
  return suffix || sessionKey;
}

function normalizeSessionTitle(text: string): string {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return '';
  }
  if (cleaned.length <= SESSION_TITLE_MAX_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
}

function isTechnicalSessionName(name: string, sessionKey: string, agentId: string): boolean {
  const normalized = name.trim().toLowerCase();
  const suffix = readSessionSuffix(sessionKey).trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized === sessionKey.trim().toLowerCase() || normalized === suffix) {
    return true;
  }
  if (normalized === agentId.trim().toLowerCase()) {
    return true;
  }
  if (normalized === 'matchaclaw' || normalized === 'main') {
    return true;
  }
  if (normalized.startsWith('subagent:')) {
    return true;
  }
  if (/^session-\d{8,16}$/i.test(normalized)) {
    return true;
  }
  return false;
}

function resolvePreferredExplicitTitle(session: ChatSession, siblingSessions: ChatSession[], agentId: string): string | null {
  const candidate = (session.displayName || session.label || '').trim();
  if (!candidate || isTechnicalSessionName(candidate, session.key, agentId)) {
    return null;
  }
  const sameNameCount = siblingSessions.filter((item) => {
    const itemName = (item.displayName || item.label || '').trim();
    return itemName === candidate;
  }).length;
  if (sameNameCount > 1) {
    return null;
  }
  return normalizeSessionTitle(candidate);
}

function inferUntitledSessionLabel(session: ChatSession, t: (key: string, options?: Record<string, unknown>) => string): string {
  const suffix = readSessionSuffix(session.key).trim();
  const lowerSuffix = suffix.toLowerCase();
  if (lowerSuffix.startsWith('subagent:')) {
    return t('sidebar.subSession', { defaultValue: '子会话' });
  }
  if (/^session-\d{8,16}$/i.test(lowerSuffix)) {
    return t('sidebar.newSession', { defaultValue: '新会话' });
  }
  if (lowerSuffix === 'main') {
    return t('sidebar.defaultSession', { defaultValue: '默认会话' });
  }
  return t('sidebar.untitledSession', { defaultValue: '未命名会话' });
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
  if (matched[1].length <= 10) {
    return raw * 1000;
  }
  return raw;
}

function formatSessionMeta(sessionKey: string, locale: string): string {
  const ts = parseSessionTimestamp(sessionKey);
  if (ts) {
    return new Date(ts).toLocaleString(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  const suffix = readSessionSuffix(sessionKey);
  return suffix.length > 36 ? `${suffix.slice(0, 36)}...` : suffix;
}

function resolvePreferredSessionKey(agentId: string, sessions: ChatSession[]): string {
  const canonical = buildDefaultAgentSessionKey(agentId);
  const matchedCanonical = sessions.find((session) => session.key === canonical);
  if (matchedCanonical) {
    return matchedCanonical.key;
  }
  if (sessions.length > 0) {
    return sessions[0].key;
  }
  return canonical;
}

function resolveAgentEmoji(agentId: string, explicitEmoji?: string): string {
  if (explicitEmoji && explicitEmoji.trim()) {
    return explicitEmoji;
  }
  return agentId === 'main' ? '\u2699\uFE0F' : '\uD83E\uDD16';
}

function loadCollapsedAgentGroupMap(): Record<string, true> {
  try {
    const raw = window.localStorage.getItem(AGENT_GROUP_COLLAPSE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return {};
    }
    return parsed.reduce<Record<string, true>>((acc, item) => {
      if (typeof item === 'string' && item.trim()) {
        acc[item] = true;
      }
      return acc;
    }, {});
  } catch {
    return {};
  }
}

export function AgentSessionsPane({
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
  const loadSessions = useChatStore((state) => state.loadSessions);
  const [collapsedAgentGroups, setCollapsedAgentGroups] = useState<Record<string, true>>(() => loadCollapsedAgentGroupMap());

  useEffect(() => {
    void loadAgents();
    void loadSessions();
  }, [loadAgents, loadSessions]);

  const agentSessionNodes = useMemo<AgentSessionNode[]>(() => {
    const agentById = new Map(agents.map((agent) => [agent.id, agent] as const));
    const agentOrder = new Map(agents.map((agent, index) => [agent.id, index] as const));
    const sessionsByAgent = new Map<string, ChatSession[]>();

    for (const session of sessions) {
      const agentId = parseAgentIdFromSessionKey(session.key);
      if (!agentId) {
        continue;
      }
      const bucket = sessionsByAgent.get(agentId) ?? [];
      bucket.push(session);
      sessionsByAgent.set(agentId, bucket);
    }

    const allAgentIds = new Set<string>([
      ...agents.map((agent) => agent.id),
      ...sessionsByAgent.keys(),
    ]);
    if (!allAgentIds.has('main')) {
      allAgentIds.add('main');
    }

    return [...allAgentIds]
      .sort((left, right) => {
        if (left === 'main' && right !== 'main') return -1;
        if (right === 'main' && left !== 'main') return 1;
        const leftOrder = agentOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = agentOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }
        return left.localeCompare(right);
      })
      .map((agentId) => {
        const agent = agentById.get(agentId);
        const fallbackName = agentId === 'main'
          ? t('sidebar.mainAgent', { defaultValue: 'Main Agent' })
          : agentId;
        const emoji = resolveAgentEmoji(agentId, agent?.identityEmoji ?? agent?.identity?.emoji);
        const sortedSessions = [...(sessionsByAgent.get(agentId) ?? [])].sort((left, right) => {
          const leftActivity = sessionLastActivity[left.key] ?? parseSessionTimestamp(left.key) ?? 0;
          const rightActivity = sessionLastActivity[right.key] ?? parseSessionTimestamp(right.key) ?? 0;
          if (leftActivity !== rightActivity) {
            return rightActivity - leftActivity;
          }
          return left.key.localeCompare(right.key);
        });
        return {
          agentId,
          agentName: agent?.name?.trim() || fallbackName,
          identityEmoji: emoji,
          sessions: sortedSessions,
        };
      });
  }, [agents, sessions, sessionLastActivity, t]);

  const collapsedAgentGroupsInView = useMemo<Record<string, true>>(() => {
    const activeAgentIds = new Set(agentSessionNodes.map((item) => item.agentId));
    const next: Record<string, true> = {};
    for (const agentId of Object.keys(collapsedAgentGroups)) {
      if (activeAgentIds.has(agentId)) {
        next[agentId] = true;
      }
    }
    return next;
  }, [agentSessionNodes, collapsedAgentGroups]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        AGENT_GROUP_COLLAPSE_STORAGE_KEY,
        JSON.stringify(Object.keys(collapsedAgentGroupsInView)),
      );
    } catch {
      // ignore localStorage failures
    }
  }, [collapsedAgentGroupsInView]);

  const handleSwitchSession = (sessionKey: string) => {
    switchSession(sessionKey);
    navigate('/');
  };

  const toggleAgentGroup = (agentId: string) => {
    setCollapsedAgentGroups((prev) => {
      if (prev[agentId]) {
        const next = { ...prev };
        delete next[agentId];
        return next;
      }
      return { ...prev, [agentId]: true };
    });
  };

  const expandAgentGroup = (agentId: string) => {
    setCollapsedAgentGroups((prev) => {
      if (!prev[agentId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
  };

  const handleAgentRowClick = (params: {
    agentId: string;
    preferredSessionKey: string;
    activeAgent: boolean;
  }) => {
    const { agentId, preferredSessionKey, activeAgent } = params;
    if (!activeAgent) {
      expandAgentGroup(agentId);
      handleSwitchSession(preferredSessionKey);
      return;
    }
    toggleAgentGroup(agentId);
  };

  const resolveSessionTitle = (session: ChatSession, siblingSessions: ChatSession[], agentId: string): string => {
    const topicTitle = sessionLabels[session.key]?.trim();
    if (topicTitle) {
      return topicTitle;
    }
    const explicitTitle = resolvePreferredExplicitTitle(session, siblingSessions, agentId);
    if (explicitTitle) {
      return explicitTitle;
    }
    return inferUntitledSessionLabel(session, t);
  };

  return (
    <aside
      data-testid="agent-sessions-pane"
      className="relative flex shrink-0 flex-col border-r bg-background"
      style={{ width: collapsed ? collapsedWidth : expandedWidth }}
    >
      {collapsed ? (
        <>
          <div className="flex flex-1 flex-col items-center gap-2 px-1 py-3">
            <span className="px-1 text-xs text-muted-foreground [writing-mode:vertical-rl]">
              {t('sidebar.agentSessions')}
            </span>
          </div>
        </>
      ) : null}

      {!collapsed ? (
        <>
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('sidebar.agentSessions')}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={newSession}
              aria-label={t('chat:toolbar.newSession', { defaultValue: '新会话' })}
              title={t('chat:toolbar.newSession', { defaultValue: '新会话' })}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 space-y-2 overflow-auto p-2">
            {agentSessionNodes.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {t('sidebar.noSubagents')}
              </p>
            ) : (
              agentSessionNodes.map((node) => {
                const preferredSessionKey = resolvePreferredSessionKey(node.agentId, node.sessions);
                const childSessions = node.sessions.filter((session) => session.key !== preferredSessionKey);
                const isMainSessionActive = currentSessionKey === preferredSessionKey;
                const groupCollapsed = Boolean(collapsedAgentGroupsInView[node.agentId]);
                return (
                  <div key={node.agentId} className="space-y-1">
                    <button
                      type="button"
                      className={cn(
                        'flex min-w-0 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[15px] font-medium transition-colors',
                        'hover:bg-accent hover:text-accent-foreground',
                        isMainSessionActive
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground',
                      )}
                      onClick={() => handleAgentRowClick({
                        agentId: node.agentId,
                        preferredSessionKey,
                        activeAgent: isMainSessionActive,
                      })}
                      aria-expanded={!groupCollapsed}
                      aria-label={isMainSessionActive
                        ? (groupCollapsed ? t('sidebar.expandAgentGroup') : t('sidebar.collapseAgentGroup'))
                        : t('sidebar.openMainSession', { defaultValue: '进入主会话' })}
                      title={isMainSessionActive
                        ? (groupCollapsed ? t('sidebar.expandAgentGroup') : t('sidebar.collapseAgentGroup'))
                        : t('sidebar.openMainSession', { defaultValue: '进入主会话' })}
                    >
                      <span
                        aria-hidden
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs leading-none"
                      >
                        {node.identityEmoji}
                      </span>
                      <span className="truncate">{node.agentName}</span>
                    </button>

                    {!groupCollapsed ? (
                      <div className="ml-5 space-y-1">
                        {childSessions.length === 0 ? (
                          <p className="px-2 py-1 text-xs text-muted-foreground">
                            {t('sidebar.noAgentSessions')}
                          </p>
                        ) : (
                          childSessions.map((session) => (
                            <button
                              key={session.key}
                              type="button"
                              className={cn(
                                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
                                currentSessionKey === session.key
                                  ? 'bg-accent text-accent-foreground'
                                  : 'text-muted-foreground hover:bg-accent/70 hover:text-accent-foreground',
                              )}
                              onClick={() => handleSwitchSession(session.key)}
                              title={session.key}
                            >
                              <span
                                aria-hidden
                                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted/80 text-[10px] leading-none"
                              >
                                {node.identityEmoji}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">{resolveSessionTitle(session, node.sessions, node.agentId)}</span>
                                <span className="mt-0.5 block truncate text-xs text-muted-foreground/80">
                                  {formatSessionMeta(session.key, i18n.language)}
                                </span>
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </>
      ) : null}

      <PaneEdgeToggle
        side="right"
        onClick={onToggleCollapse}
        ariaLabel={collapsed ? t('sidebar.expandAgentSessions') : t('sidebar.collapseAgentSessions')}
        title={collapsed ? t('sidebar.expandAgentSessions') : t('sidebar.collapseAgentSessions')}
        icon={collapsed ? <ChevronRight className="h-2.5 w-2.5" /> : <ChevronLeft className="h-2.5 w-2.5" />}
      />
    </aside>
  );
}
