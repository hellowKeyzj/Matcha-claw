import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
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

const AGENT_GROUP_COLLAPSE_STORAGE_KEY = 'layout:agent-session-group-collapsed';
const SESSION_TITLE_MAX_LENGTH = 48;

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
  const isGatewayRunning = useGatewayStore((state) => state.status.state === 'running');
  const [collapsedAgentGroups, setCollapsedAgentGroups] = useState<Record<string, true>>(() => loadCollapsedAgentGroupMap());

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

    for (const session of sessions) {
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
          const leftActivity = sessionLastActivity[left.key] ?? parseSessionTimestamp(left.key) ?? 0;
          const rightActivity = sessionLastActivity[right.key] ?? parseSessionTimestamp(right.key) ?? 0;
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
  }, [agents, sessionLastActivity, sessions]);

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

  const resolveSessionTitle = (session: ChatSession): string => {
    const topicTitle = sessionLabels[session.key]?.trim();
    if (topicTitle) {
      return normalizeSessionTitle(topicTitle);
    }
    const explicit = (session.displayName || session.label || '').trim();
    if (explicit && explicit !== session.key) {
      return normalizeSessionTitle(explicit);
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
              onClick={newSession}
              aria-label={t('sidebar.newSession')}
              title={t('sidebar.newSession')}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 space-y-2 overflow-auto p-2">
            {agentSessionNodes.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">{t('sidebar.noSubagents')}</p>
            ) : (
              agentSessionNodes.map((node) => {
                const preferredSessionKey = resolvePreferredSessionKey(node.agentId, node.sessions);
                const childSessions = node.sessions.filter((session) => session.key !== preferredSessionKey);
                const groupCollapsed = Boolean(collapsedAgentGroupsInView[node.agentId]);
                const isMainSessionActive = currentSessionKey === preferredSessionKey;

                return (
                  <div key={node.agentId} className="space-y-1">
                    <button
                      type="button"
                      className={cn(
                        'flex min-w-0 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[15px] font-medium transition-colors',
                        'hover:bg-accent hover:text-accent-foreground',
                        isMainSessionActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
                      )}
                      onClick={() => {
                        if (!isMainSessionActive) {
                          handleSwitchSession(preferredSessionKey);
                          return;
                        }
                        toggleAgentGroup(node.agentId);
                      }}
                    >
                      <span
                        aria-hidden
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs leading-none"
                      >
                        {node.identityEmoji}
                      </span>
                      <span className="truncate">{node.agentName}</span>
                    </button>

                    {!groupCollapsed && (
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
                            >
                              <span
                                aria-hidden
                                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted/80 text-[10px] leading-none"
                              >
                                {node.identityEmoji}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">{resolveSessionTitle(session)}</span>
                                <span className="mt-0.5 block truncate text-xs text-muted-foreground/80">
                                  {formatSessionMeta(session.key, i18n.language)}
                                </span>
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
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
}
