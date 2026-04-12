/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 */
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Home,
  MessageSquare,
  Bot,
  Radio,
  Puzzle,
  Package,
  KeyRound,
  ListTodo,
  Users,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  Terminal,
  ExternalLink,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useTeamsStore } from '@/stores/teams';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { useSkillsStore } from '@/stores/skills';
import { useChannelsStore } from '@/stores/channels';
import { Button } from '@/components/ui/button';
import { PaneEdgeToggle } from '@/components/layout/PaneEdgeToggle';
import { hostApiFetch } from '@/lib/host-api';
import { preloadLazyRouteForPath } from '@/lib/route-preload';
import { prefetchSubagentTemplateCatalog } from '@/services/openclaw/subagent-template-catalog';
import { useTranslation } from 'react-i18next';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef } from 'react';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  collapsed?: boolean;
  onMouseEnter?: () => void;
  onFocus?: () => void;
  onNavigate?: (to: string) => void;
}

interface SidebarProps {
  expandedWidth?: number;
  collapsedWidth?: number;
  showRightDivider?: boolean;
}

interface PendingBlockerCard {
  id: string;
  source: 'team_mailbox' | 'chat_approval';
  teamId: string;
  teamName: string;
  title: string;
  content: string;
  from: string;
  createdAt: number;
  sessionKey?: string;
}

function simplifyMessage(content: string): string {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= 72) {
    return normalized;
  }
  return `${normalized.slice(0, 72)}...`;
}

function formatMessageTime(createdAt: number): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return '-';
  }
  return new Date(createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

const SIDEBAR_BLOCKER_RENDER_LIMIT = 8;
const TEAM_MAILBOX_SCAN_LIMIT = 80;
const TEAM_MAILBOX_CARD_LIMIT = 3;
const CHAT_APPROVAL_SCAN_LIMIT = 24;
const SIDEBAR_PREFETCH_FALLBACK_DELAY_MS = 120;
const SIDEBAR_PREFETCH_IDLE_TIMEOUT_MS = 400;

type PrefetchScheduleHandle =
  | { type: 'idle'; id: number }
  | { type: 'timeout'; id: number };

function NavItem({ to, icon, label, collapsed, onMouseEnter, onFocus, onNavigate }: NavItemProps) {
  return (
    <NavLink
      to={to}
      onMouseEnter={onMouseEnter}
      onFocus={onFocus}
      onClick={(event) => {
        if (!onNavigate) {
          return;
        }
        if (
          event.defaultPrevented
          || event.button !== 0
          || event.metaKey
          || event.ctrlKey
          || event.shiftKey
          || event.altKey
        ) {
          return;
        }
        event.preventDefault();
        onNavigate(to);
      }}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-[var(--radius-pill)] px-3.5 py-2.5 text-sm font-medium tracking-[-0.01em] transition-[background-color,color,box-shadow]',
          'hover:bg-secondary hover:text-foreground',
          isActive
            ? 'bg-secondary text-foreground'
            : 'text-muted-foreground',
          collapsed && 'justify-center px-2',
        )
      }
    >
      {icon}
      {!collapsed && <span className="flex-1">{label}</span>}
    </NavLink>
  );
}

const SidebarPendingBlockers = memo(function SidebarPendingBlockers() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const teams = useTeamsStore((state) => state.teams);
  const mailboxByTeamId = useTeamsStore((state) => state.mailboxByTeamId);
  const setActiveTeam = useTeamsStore((state) => state.setActiveTeam);
  const pendingApprovalsBySession = useChatStore((state) => state.pendingApprovalsBySession);
  const sessionLabels = useChatStore((state) => state.sessionLabels);
  const chatSessions = useChatStore((state) => state.sessions);
  const deferredTeams = useDeferredValue(teams);
  const deferredMailboxByTeamId = useDeferredValue(mailboxByTeamId);
  const deferredPendingApprovalsBySession = useDeferredValue(pendingApprovalsBySession);
  const deferredSessionLabels = useDeferredValue(sessionLabels);
  const deferredChatSessions = useDeferredValue(chatSessions);

  const pendingBlockers = useMemo<PendingBlockerCard[]>(() => {
    const cards: PendingBlockerCard[] = [];
    for (const team of deferredTeams) {
      const mailbox = deferredMailboxByTeamId[team.id] ?? [];
      if (mailbox.length === 0) {
        continue;
      }
      const startIndex = Math.max(0, mailbox.length - TEAM_MAILBOX_SCAN_LIMIT);

      const latestDecisionAtByTask = new Map<string, number>();
      for (let index = mailbox.length - 1; index >= startIndex; index -= 1) {
        const message = mailbox[index];
        if (message.kind !== 'decision' || !message.relatedTaskId) {
          continue;
        }
        const prev = latestDecisionAtByTask.get(message.relatedTaskId) ?? 0;
        if (message.createdAt > prev) {
          latestDecisionAtByTask.set(message.relatedTaskId, message.createdAt);
        }
      }

      let perTeamCards = 0;
      for (let index = mailbox.length - 1; index >= startIndex; index -= 1) {
        if (perTeamCards >= TEAM_MAILBOX_CARD_LIMIT) {
          break;
        }
        const message = mailbox[index];
        if (message.kind !== 'question') {
          continue;
        }
        if (!message.relatedTaskId) {
          continue;
        }
        if (message.relatedTaskId) {
          const decidedAt = latestDecisionAtByTask.get(message.relatedTaskId) ?? 0;
          if (decidedAt >= message.createdAt) {
            continue;
          }
        }
        const title = message.relatedTaskId
          ? t('sidebar.pendingBlockerTask', { taskId: message.relatedTaskId })
          : t('sidebar.pendingBlockerGeneral');
        cards.push({
          id: `team:${team.id}:${message.msgId}`,
          source: 'team_mailbox',
          teamId: team.id,
          teamName: team.name,
          title,
          content: message.content,
          from: message.fromAgentId,
          createdAt: message.createdAt,
        });
        perTeamCards += 1;
      }
    }

    const sessionDisplayNameByKey = new Map(
      deferredChatSessions.map((session) => [session.key, session.displayName || session.key]),
    );
    let approvalCards = 0;
    for (const [sessionKey, approvals] of Object.entries(deferredPendingApprovalsBySession)) {
      const startIndex = Math.max(0, approvals.length - CHAT_APPROVAL_SCAN_LIMIT);
      for (let index = approvals.length - 1; index >= startIndex; index -= 1) {
        if (approvalCards >= CHAT_APPROVAL_SCAN_LIMIT) {
          break;
        }
        const approval = approvals[index];
        const toolName = typeof approval.toolName === 'string' && approval.toolName.trim().length > 0
          ? approval.toolName.trim()
          : 'tool-call';
        const sessionLabel = deferredSessionLabels[sessionKey]
          || sessionDisplayNameByKey.get(sessionKey)
          || sessionKey;
        cards.push({
          id: `chat-approval:${approval.id}`,
          source: 'chat_approval',
          teamId: '',
          teamName: sessionLabel,
          title: `${t('sidebar.pendingBlockerTypeApproval')} · ${toolName}`,
          content: t('sidebar.pendingBlockerApprovalHint'),
          from: approval.id,
          createdAt: approval.createdAtMs,
          sessionKey,
        });
        approvalCards += 1;
      }
    }

    return cards
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, SIDEBAR_BLOCKER_RENDER_LIMIT);
  }, [
    deferredChatSessions,
    deferredMailboxByTeamId,
    deferredPendingApprovalsBySession,
    deferredSessionLabels,
    deferredTeams,
    t,
  ]);

  return (
    <section className="mt-4 rounded-[1rem] border border-border/80 bg-secondary/55 p-2.5">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">{t('sidebar.pendingBlockers')}</h3>
        <span className="text-[11px] text-muted-foreground">{pendingBlockers.length}</span>
      </header>
      {pendingBlockers.length === 0 ? (
        <div className="rounded-[calc(var(--radius-interactive)+2px)] border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          {t('sidebar.pendingBlockersEmpty')}
        </div>
      ) : (
        <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
          {pendingBlockers.map((card) => (
            <button
              key={card.id}
              type="button"
              className="w-full rounded-[calc(var(--radius-interactive)+2px)] border border-border bg-card px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow] hover:border-input hover:bg-secondary hover:shadow-whisper"
              onClick={() => {
                if (card.source === 'team_mailbox') {
                  setActiveTeam(card.teamId);
                  navigate(`/teams/${card.teamId}`);
                  return;
                }
                if (card.source === 'chat_approval' && card.sessionKey) {
                  navigate(`/?session=${encodeURIComponent(card.sessionKey)}`);
                  return;
                }
                navigate('/tasks');
              }}
            >
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="truncate">
                  {card.source === 'team_mailbox'
                    ? card.teamName
                    : t('sidebar.pendingBlockerSourceChat')}
                </span>
                <span>{formatMessageTime(card.createdAt)}</span>
              </div>
              <div className="mt-1 truncate text-xs font-medium text-foreground">
                {card.title}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {simplifyMessage(card.content)}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {card.source === 'team_mailbox'
                  ? t('sidebar.pendingBlockerFrom', { from: card.from })
                  : t('sidebar.pendingBlockerApprovalId', { id: card.from })}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
});

export function Sidebar({
  expandedWidth = 256,
  collapsedWidth = 64,
  showRightDivider = true,
}: SidebarProps) {
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((state) => state.setSidebarCollapsed);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const newSession = useChatStore((state) => state.newSession);
  const gatewayState = useGatewayStore((state) => state.status.state);
  const taskCenterInitialized = useTaskCenterStore((state) => state.initialized);
  const initTaskCenter = useTaskCenterStore((state) => state.init);
  const refreshTaskCenter = useTaskCenterStore((state) => state.refreshTasks);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const fetchChannels = useChannelsStore((state) => state.fetchChannels);
  const prefetchHandlesRef = useRef<Map<string, PrefetchScheduleHandle>>(new Map());

  const navigate = useNavigate();
  const location = useLocation();
  const isOnChat = location.pathname === '/';
  const { t } = useTranslation();

  const openDevConsole = async () => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        error?: string;
      }>('/api/gateway/control-ui');
      if (result.success && result.url) {
        window.electron.openExternal(result.url);
      } else {
        console.error('Failed to get Dev Console URL:', result.error);
      }
    } catch (error) {
      console.error('Error opening Dev Console:', error);
    }
  };

  const navItems = [
    { to: '/tasks', icon: <ListTodo className="h-5 w-5" />, label: t('sidebar.tasks') },
    { to: '/subagents', icon: <Bot className="h-5 w-5" />, label: t('sidebar.subagents') },
    { to: '/teams', icon: <Users className="h-5 w-5" />, label: t('sidebar.teams') },
    { to: '/providers', icon: <KeyRound className="h-5 w-5" />, label: t('settings:aiProviders.title') },
    { to: '/skills', icon: <Puzzle className="h-5 w-5" />, label: t('sidebar.skills') },
    { to: '/plugins', icon: <Package className="h-5 w-5" />, label: t('sidebar.plugins') },
    { to: '/channels', icon: <Radio className="h-5 w-5" />, label: t('sidebar.channels') },
    { to: '/dashboard', icon: <Home className="h-5 w-5" />, label: t('sidebar.dashboard') },
    { to: '/security', icon: <ShieldCheck className="h-5 w-5" />, label: t('sidebar.security') },
  ];

  const prefetchNavPath = useCallback((path: string) => {
    void preloadLazyRouteForPath(path);

    if (path === '/subagents') {
      void prefetchSubagentTemplateCatalog();
      return;
    }

    if (gatewayState !== 'running') {
      return;
    }

    if (path === '/skills') {
      void fetchSkills();
      return;
    }

    if (path === '/dashboard') {
      void fetchChannels({ silent: true });
      return;
    }

    if (path === '/tasks') {
      if (!taskCenterInitialized) {
        void initTaskCenter();
      }
      void refreshTaskCenter();
    }
  }, [
    fetchChannels,
    fetchSkills,
    gatewayState,
    initTaskCenter,
    refreshTaskCenter,
    taskCenterInitialized,
  ]);

  const clearPrefetchHandle = useCallback((path: string) => {
    const current = prefetchHandlesRef.current.get(path);
    if (!current) {
      return;
    }
    if (current.type === 'idle') {
      if ('cancelIdleCallback' in window && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(current.id);
      }
    } else {
      window.clearTimeout(current.id);
    }
    prefetchHandlesRef.current.delete(path);
  }, []);

  const scheduleNavPrefetch = useCallback((path: string) => {
    if (prefetchHandlesRef.current.has(path)) {
      return;
    }

    const runPrefetch = () => {
      prefetchHandlesRef.current.delete(path);
      prefetchNavPath(path);
    };

    if ('requestIdleCallback' in window && typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(runPrefetch, { timeout: SIDEBAR_PREFETCH_IDLE_TIMEOUT_MS });
      prefetchHandlesRef.current.set(path, { type: 'idle', id: idleId });
      return;
    }

    const timeoutId = window.setTimeout(runPrefetch, SIDEBAR_PREFETCH_FALLBACK_DELAY_MS);
    prefetchHandlesRef.current.set(path, { type: 'timeout', id: timeoutId });
  }, [prefetchNavPath]);

  useEffect(() => {
    if (gatewayState !== 'running' || taskCenterInitialized) {
      return;
    }
    void initTaskCenter();
  }, [gatewayState, initTaskCenter, taskCenterInitialized]);

  useEffect(() => () => {
    const paths = Array.from(prefetchHandlesRef.current.keys());
    for (const path of paths) {
      clearPrefetchHandle(path);
    }
  }, [clearPrefetchHandle]);

  const navigateToPath = useCallback((to: string) => {
    if (location.pathname === to) {
      return;
    }
    navigate(to);
  }, [location.pathname, navigate]);

  return (
    <aside
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden bg-card transition-[width] duration-300',
        showRightDivider && 'border-r [border-right-color:var(--divider-line)]',
      )}
      style={{ width: sidebarCollapsed ? collapsedWidth : expandedWidth }}
    >
      <nav className="flex flex-1 flex-col gap-1.5 overflow-hidden p-3">
        <button
          type="button"
          onClick={() => {
            const { messages } = useChatStore.getState();
            if (isOnChat && messages.length > 0) {
              newSession();
            }
            navigate('/');
          }}
          className={cn(
            'flex items-center gap-3 rounded-[var(--radius-pill)] px-3.5 py-2.5 text-sm font-medium tracking-[-0.01em] text-muted-foreground transition-[background-color,color,box-shadow]',
            'hover:bg-secondary hover:text-foreground',
            sidebarCollapsed && 'justify-center px-2',
          )}
        >
          <MessageSquare className="h-5 w-5 shrink-0" />
          {!sidebarCollapsed && <span className="flex-1 text-left">{t('sidebar.newChat')}</span>}
        </button>

        {navItems.map((item) => (
          <NavItem
            key={item.to}
            {...item}
            collapsed={sidebarCollapsed}
            onMouseEnter={() => scheduleNavPrefetch(item.to)}
            onFocus={() => scheduleNavPrefetch(item.to)}
            onNavigate={navigateToPath}
          />
        ))}

        {!sidebarCollapsed && <SidebarPendingBlockers />}
      </nav>

      <div className="space-y-2 p-3 pt-0">
        {devModeUnlocked && !sidebarCollapsed && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={openDevConsole}
          >
            <Terminal className="mr-2 h-4 w-4" />
            {t('sidebar.devConsole')}
            <ExternalLink className="ml-auto h-3 w-3" />
          </Button>
        )}
      </div>

      <PaneEdgeToggle
        side="right"
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        ariaLabel={sidebarCollapsed ? t('sidebar.expandMenu') : t('sidebar.collapseMenu')}
        title={sidebarCollapsed ? t('sidebar.expandMenu') : t('sidebar.collapseMenu')}
        icon={sidebarCollapsed ? <ChevronRight className="h-2.5 w-2.5" /> : <ChevronLeft className="h-2.5 w-2.5" />}
      />
    </aside>
  );
}
