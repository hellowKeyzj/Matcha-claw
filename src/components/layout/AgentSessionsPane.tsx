import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSubagentsStore } from '@/stores/subagents';
import { useChatStore, type ChatSession } from '@/stores/chat';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

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
const SESSION_TOPIC_CACHE_STORAGE_KEY = 'layout:agent-session-topic-cache';
const SESSION_TITLE_MAX_LENGTH = 48;

function parseAgentIdFromSessionKey(key: string): string | null {
  const matched = key.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? null;
}

function buildDefaultAgentSessionKey(agentId: string): string {
  return `agent:${agentId}:${agentId}`;
}

function readSessionSuffix(sessionKey: string): string {
  const suffix = sessionKey.split(':').slice(2).join(':');
  return suffix || sessionKey;
}

function isGenericSessionName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return normalized === 'clawx' || normalized === 'main';
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return (content as Array<{ type?: string; text?: string }>)
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n');
}

function normalizeSessionTopic(text: string): string {
  const cleaned = text
    .replace(/\[media attached:[^\]]+\]/gi, ' ')
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

function loadSessionTopicCache(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(SESSION_TOPIC_CACHE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.entries(parsed as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
      if (typeof value === 'string' && value.trim()) {
        acc[key] = value.trim();
      }
      return acc;
    }, {});
  } catch {
    return {};
  }
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
  if (isGenericSessionName(normalized)) {
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
  return normalizeSessionTopic(candidate);
}

function inferUntitledSessionLabel(session: ChatSession, agentId: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  const suffix = readSessionSuffix(session.key).trim();
  const lowerSuffix = suffix.toLowerCase();
  if (lowerSuffix.startsWith('subagent:')) {
    return t('sidebar.subSession', { defaultValue: '子会话' });
  }
  if (/^session-\d{8,16}$/i.test(lowerSuffix)) {
    return t('sidebar.newSession', { defaultValue: '新会话' });
  }
  if (lowerSuffix === agentId.toLowerCase() || lowerSuffix === 'main') {
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

function extractTopicFromMessages(messages: Array<{ role?: string; content?: unknown }>): string {
  for (const role of ['user', 'assistant']) {
    for (const message of messages) {
      if ((message.role || '').toLowerCase() !== role) {
        continue;
      }
      const candidate = normalizeSessionTopic(extractContentText(message.content));
      if (candidate) {
        return candidate;
      }
    }
  }
  return '';
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
  const messages = useChatStore((state) => state.messages);
  const currentSessionKey = useChatStore((state) => state.currentSessionKey);
  const switchSession = useChatStore((state) => state.switchSession);
  const newSession = useChatStore((state) => state.newSession);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const [collapsedAgentGroups, setCollapsedAgentGroups] = useState<Record<string, true>>(() => loadCollapsedAgentGroupMap());
  const [sessionTopicCache, setSessionTopicCache] = useState<Record<string, string>>(() => loadSessionTopicCache());
  const resolvingSessionKeysRef = useRef<Set<string>>(new Set());
  const attemptedSessionKeysRef = useRef<Set<string>>(new Set());

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
        return {
          agentId,
          agentName: agent?.name?.trim() || fallbackName,
          identityEmoji: emoji,
          sessions: (sessionsByAgent.get(agentId) ?? []).sort((left, right) => left.key.localeCompare(right.key)),
        };
      });
  }, [agents, sessions, t]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        AGENT_GROUP_COLLAPSE_STORAGE_KEY,
        JSON.stringify(Object.keys(collapsedAgentGroups)),
      );
    } catch {
      // ignore localStorage failures
    }
  }, [collapsedAgentGroups]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SESSION_TOPIC_CACHE_STORAGE_KEY,
        JSON.stringify(sessionTopicCache),
      );
    } catch {
      // ignore localStorage failures
    }
  }, [sessionTopicCache]);

  useEffect(() => {
    const activeAgentIds = new Set(agentSessionNodes.map((item) => item.agentId));
    setCollapsedAgentGroups((prev) => {
      const next: Record<string, true> = {};
      let changed = false;
      for (const agentId of Object.keys(prev)) {
        if (activeAgentIds.has(agentId)) {
          next[agentId] = true;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [agentSessionNodes]);

  useEffect(() => {
    attemptedSessionKeysRef.current.delete(currentSessionKey);
  }, [currentSessionKey]);

  useEffect(() => {
    if (collapsed || !currentSessionKey || messages.length === 0) {
      return;
    }
    const currentAgentId = parseAgentIdFromSessionKey(currentSessionKey);
    if (!currentAgentId) {
      return;
    }
    const currentSession = sessions.find((item) => item.key === currentSessionKey);
    if (!currentSession) {
      return;
    }
    const siblingSessions = sessions.filter((item) => parseAgentIdFromSessionKey(item.key) === currentAgentId);
    const explicitTitle = resolvePreferredExplicitTitle(currentSession, siblingSessions, currentAgentId);
    if (explicitTitle) {
      return;
    }
    const topic = extractTopicFromMessages(messages as Array<{ role?: string; content?: unknown }>);
    if (!topic) {
      return;
    }
    setSessionTopicCache((prev) => {
      if (prev[currentSessionKey] === topic) {
        return prev;
      }
      return {
        ...prev,
        [currentSessionKey]: topic,
      };
    });
  }, [collapsed, currentSessionKey, messages, sessions]);

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

  const unresolvedSessions = useMemo(() => {
    if (collapsed) {
      return [] as Array<{ sessionKey: string; agentId: string; siblings: ChatSession[] }>;
    }
    const items: Array<{ sessionKey: string; agentId: string; siblings: ChatSession[] }> = [];
    for (const node of agentSessionNodes) {
      for (const session of node.sessions) {
        const explicitTitle = resolvePreferredExplicitTitle(session, node.sessions, node.agentId);
        if (explicitTitle) {
          continue;
        }
        if (sessionTopicCache[session.key]) {
          continue;
        }
        if (attemptedSessionKeysRef.current.has(session.key)) {
          continue;
        }
        items.push({
          sessionKey: session.key,
          agentId: node.agentId,
          siblings: node.sessions,
        });
      }
    }
    return items;
  }, [agentSessionNodes, collapsed, sessionTopicCache]);

  useEffect(() => {
    if (collapsed || unresolvedSessions.length === 0) {
      return;
    }
    let cancelled = false;
    const pendingBatch = unresolvedSessions
      .filter((item) => !resolvingSessionKeysRef.current.has(item.sessionKey))
      .slice(0, 8);
    if (pendingBatch.length === 0) {
      return;
    }

    const fetchSessionTopic = async (sessionKey: string): Promise<string | null> => {
      try {
        const rawResult = await window.electron.ipcRenderer.invoke(
          'gateway:rpc',
          'chat.history',
          { sessionKey, limit: 60 },
        ) as unknown;
        if (!rawResult || typeof rawResult !== 'object' || !('success' in rawResult)) {
          return null;
        }
        const result = rawResult as { success: boolean; result?: Record<string, unknown> };
        if (!result.success || !result.result) {
          return null;
        }
        const rawMessages = Array.isArray(result.result.messages) ? result.result.messages : [];
        const messages = rawMessages as Array<{ role?: string; content?: unknown }>;
        for (const role of ['user', 'assistant']) {
          for (const message of messages) {
            if ((message.role || '').toLowerCase() !== role) {
              continue;
            }
            const candidate = normalizeSessionTopic(extractContentText(message.content));
            if (candidate) {
              return candidate;
            }
          }
        }
        return null;
      } catch {
        return null;
      }
    };

    const resolveTopics = async () => {
      for (const item of pendingBatch) {
        if (cancelled) {
          return;
        }
        attemptedSessionKeysRef.current.add(item.sessionKey);
        resolvingSessionKeysRef.current.add(item.sessionKey);
        const topic = await fetchSessionTopic(item.sessionKey);
        resolvingSessionKeysRef.current.delete(item.sessionKey);
        if (cancelled || !topic) {
          continue;
        }
        setSessionTopicCache((prev) => {
          if (prev[item.sessionKey] === topic) {
            return prev;
          }
          return {
            ...prev,
            [item.sessionKey]: topic,
          };
        });
      }
    };

    void resolveTopics();

    return () => {
      cancelled = true;
    };
  }, [collapsed, unresolvedSessions]);

  const resolveSessionTitle = (session: ChatSession, siblingSessions: ChatSession[], agentId: string): string => {
    const explicitTitle = resolvePreferredExplicitTitle(session, siblingSessions, agentId);
    if (explicitTitle) {
      return explicitTitle;
    }
    const topicTitle = sessionTopicCache[session.key];
    if (topicTitle) {
      return topicTitle;
    }
    return inferUntitledSessionLabel(session, agentId, t);
  };

  return (
    <aside
      data-testid="agent-sessions-pane"
      className="flex shrink-0 flex-col border-r bg-background"
      style={{ width: collapsed ? collapsedWidth : expandedWidth }}
    >
      {collapsed ? (
        <>
          <div className="flex flex-1 flex-col items-center gap-2 px-1 py-3">
            <span className="px-1 text-xs text-muted-foreground [writing-mode:vertical-rl]">
              {t('sidebar.agentSessions')}
            </span>
          </div>
          <div className="p-2">
            <Button
              variant="ghost"
              size="icon"
              className="w-full"
              onClick={onToggleCollapse}
              aria-label={t('sidebar.expandAgentSessions')}
              title={t('sidebar.expandAgentSessions')}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
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
            const activeAgent = currentSessionKey === preferredSessionKey
              || node.sessions.some((session) => session.key === currentSessionKey);
            const groupCollapsed = Boolean(collapsedAgentGroups[node.agentId]);
            return (
              <div key={node.agentId} className="space-y-1">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[15px] font-medium transition-colors',
                      'hover:bg-accent hover:text-accent-foreground',
                      activeAgent
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground',
                    )}
                    onClick={() => handleSwitchSession(preferredSessionKey)}
                  >
                    <span
                      aria-hidden
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs leading-none"
                    >
                      {node.identityEmoji}
                    </span>
                    <span className="truncate">{node.agentName}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => toggleAgentGroup(node.agentId)}
                    aria-label={groupCollapsed ? t('sidebar.expandAgentGroup') : t('sidebar.collapseAgentGroup')}
                    title={groupCollapsed ? t('sidebar.expandAgentGroup') : t('sidebar.collapseAgentGroup')}
                  >
                    {groupCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>
                </div>

                {!groupCollapsed ? (
                  <div className="ml-5 space-y-1">
                    {node.sessions.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-muted-foreground">
                        {t('sidebar.noAgentSessions')}
                      </p>
                    ) : (
                    node.sessions.map((session) => (
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
        <div className="p-2">
          <Button
            variant="ghost"
            size="icon"
            className="w-full"
            onClick={onToggleCollapse}
            aria-label={t('sidebar.collapseAgentSessions')}
            title={t('sidebar.collapseAgentSessions')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>
      </>
      ) : null}
    </aside>
  );
}
