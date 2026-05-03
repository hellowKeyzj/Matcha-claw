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
import { useLayoutStore } from '@/stores/layout';
import { useSettingsStore } from '@/stores/settings';
import { useChatStore, type ApprovalItem } from '@/stores/chat';
import { selectSidebarNewSessionAction, selectSidebarPendingBlockersState } from '@/stores/chat/selectors';
import { resolveSessionListLabel } from '@/stores/chat/session-helpers';
import { getSessionMessageCount } from '@/stores/chat/store-state-helpers';
import { useGatewayStore } from '@/stores/gateway';
import { useTeamsStore } from '@/stores/teams';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { useSkillsStore } from '@/stores/skills';
import { prewarmPluginsData } from '@/stores/plugins-store';
import { Button } from '@/components/ui/button';
import { PaneEdgeToggle } from '@/components/layout/PaneEdgeToggle';
import { hostApiFetch } from '@/lib/host-api';
import { preloadLazyRouteForPath } from '@/lib/route-preload';
import { prefetchSubagentTemplateCatalog } from '@/services/openclaw/subagent-template-catalog';
import type { TeamMailboxMessage } from '@/features/teams/api/runtime-client';
import { useTranslation } from 'react-i18next';
import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { inferUntitledSessionLabel } from './useAgentSessionsPaneViewModel';

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
  width?: number;
  railWidth?: number;
  containerWidth?: number;
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

const EMPTY_TEAM_MAILBOX: TeamMailboxMessage[] = [];
const EMPTY_APPROVAL_ITEMS: ApprovalItem[] = [];
const teamMailboxCardsCacheByMailboxRef = new WeakMap<TeamMailboxMessage[], Map<string, PendingBlockerCard[]>>();
const approvalCardsCacheByApprovalsRef = new WeakMap<ApprovalItem[], Map<string, PendingBlockerCard[]>>();

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

interface SidebarTextLabelProps {
  collapsed?: boolean;
  className?: string;
  children: React.ReactNode;
}

function SidebarTextLabel({ collapsed, className, children }: SidebarTextLabelProps) {
  return (
    <span
      className={cn(
        'block min-w-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out',
        collapsed
          ? 'pointer-events-none w-0 flex-none -translate-x-1 opacity-0'
          : 'flex-1 translate-x-0 opacity-100',
        className,
      )}
    >
      <span className="block truncate">{children}</span>
    </span>
  );
}

function buildTeamMailboxBlockerCards(input: {
  teamId: string;
  teamName: string;
  mailbox: TeamMailboxMessage[];
  t: (key: string, options?: Record<string, unknown>) => string;
}): PendingBlockerCard[] {
  if (input.mailbox.length === 0) {
    return [];
  }
  const cards: PendingBlockerCard[] = [];
  const startIndex = Math.max(0, input.mailbox.length - TEAM_MAILBOX_SCAN_LIMIT);
  const latestDecisionAtByTask = new Map<string, number>();

  for (let index = input.mailbox.length - 1; index >= startIndex; index -= 1) {
    const message = input.mailbox[index];
    if (message.kind !== 'decision' || !message.relatedTaskId) {
      continue;
    }
    const prev = latestDecisionAtByTask.get(message.relatedTaskId) ?? 0;
    if (message.createdAt > prev) {
      latestDecisionAtByTask.set(message.relatedTaskId, message.createdAt);
    }
  }

  let perTeamCards = 0;
  for (let index = input.mailbox.length - 1; index >= startIndex; index -= 1) {
    if (perTeamCards >= TEAM_MAILBOX_CARD_LIMIT) {
      break;
    }
    const message = input.mailbox[index];
    if (message.kind !== 'question' || !message.relatedTaskId) {
      continue;
    }
    const decidedAt = latestDecisionAtByTask.get(message.relatedTaskId) ?? 0;
    if (decidedAt >= message.createdAt) {
      continue;
    }
    cards.push({
      id: `team:${input.teamId}:${message.msgId}`,
      source: 'team_mailbox',
      teamId: input.teamId,
      teamName: input.teamName,
      title: input.t('sidebar.pendingBlockerTask', { taskId: message.relatedTaskId }),
      content: message.content,
      from: message.fromAgentId,
      createdAt: message.createdAt,
    });
    perTeamCards += 1;
  }

  return cards;
}

function buildApprovalBlockerCards(input: {
  sessionKey: string;
  approvals: ApprovalItem[];
  sessionLabel: string;
  approvalTitlePrefix: string;
  approvalHint: string;
}): PendingBlockerCard[] {
  if (input.approvals.length === 0) {
    return [];
  }
  const cards: PendingBlockerCard[] = [];
  const startIndex = Math.max(0, input.approvals.length - CHAT_APPROVAL_SCAN_LIMIT);
  for (let index = input.approvals.length - 1; index >= startIndex; index -= 1) {
    const approval = input.approvals[index];
    const toolName = typeof approval.toolName === 'string' && approval.toolName.trim().length > 0
      ? approval.toolName.trim()
      : 'tool-call';
    cards.push({
      id: `chat-approval:${approval.id}`,
      source: 'chat_approval',
      teamId: '',
      teamName: input.sessionLabel,
      title: `${input.approvalTitlePrefix} · ${toolName}`,
      content: input.approvalHint,
      from: approval.id,
      createdAt: approval.createdAtMs,
      sessionKey: input.sessionKey,
    });
  }
  return cards;
}

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
          'flex items-center rounded-[var(--radius-pill)] px-3.5 py-2.5 text-sm font-medium tracking-[-0.01em] transition-[background-color,color,box-shadow]',
          'hover:bg-secondary hover:text-foreground',
          isActive
            ? 'bg-secondary text-foreground'
            : 'text-muted-foreground',
          collapsed ? 'justify-center gap-0 px-0' : 'gap-3',
        )
      }
    >
      {icon}
      <SidebarTextLabel collapsed={collapsed}>{label}</SidebarTextLabel>
    </NavLink>
  );
}

const SidebarPendingBlockers = memo(function SidebarPendingBlockers() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const teams = useTeamsStore((state) => state.teams);
  const mailboxByTeamId = useTeamsStore((state) => state.mailboxByTeamId);
  const setActiveTeam = useTeamsStore((state) => state.setActiveTeam);
  const { pendingApprovalsBySession, loadedSessions, chatSessions } = useChatStore(useShallow(selectSidebarPendingBlockersState));
  const deferredTeams = useDeferredValue(teams);
  const deferredMailboxByTeamId = useDeferredValue(mailboxByTeamId);
  const deferredPendingApprovalsBySession = useDeferredValue(pendingApprovalsBySession);
  const deferredloadedSessions = useDeferredValue(loadedSessions);
  const deferredChatSessions = useDeferredValue(chatSessions);
  const deferredSessionTitles = useMemo(() => {
    const next: Record<string, string> = {};
    const sessionByKey = new Map(
      deferredChatSessions.map((session) => [session.key, session] as const),
    );
    for (const sessionKey of Object.keys(deferredloadedSessions)) {
      const label = resolveSessionListLabel({ loadedSessions: deferredloadedSessions }, sessionKey, sessionByKey.get(sessionKey)?.label ?? null);
      if (label) {
        next[sessionKey] = label;
        continue;
      }
      next[sessionKey] = inferUntitledSessionLabel(sessionByKey.get(sessionKey) ?? { key: sessionKey }, t);
    }
    return next;
  }, [deferredChatSessions, deferredloadedSessions, t]);

  const teamMailboxCards = useMemo(() => {
    const cards: PendingBlockerCard[] = [];

    for (const team of deferredTeams) {
      const mailbox = deferredMailboxByTeamId[team.id] ?? EMPTY_TEAM_MAILBOX;
      let variants = teamMailboxCardsCacheByMailboxRef.get(mailbox);
      if (!variants) {
        variants = new Map<string, PendingBlockerCard[]>();
        teamMailboxCardsCacheByMailboxRef.set(mailbox, variants);
      }
      const variantKey = `${team.id}|${team.name}|${i18n.language}`;
      let teamCards = variants.get(variantKey);
      if (!teamCards) {
        teamCards = buildTeamMailboxBlockerCards({
          teamId: team.id,
          teamName: team.name,
          mailbox,
          t,
        });
        variants.set(variantKey, teamCards);
      }
      if (teamCards.length > 0) {
        cards.push(...teamCards);
      }
    }

    return cards;
  }, [deferredMailboxByTeamId, deferredTeams, i18n.language, t]);

  const approvalCards = useMemo(() => {
    const cards: PendingBlockerCard[] = [];
    let approvalCardsCount = 0;
    const approvalTitlePrefix = t('sidebar.pendingBlockerTypeApproval');
    const approvalHint = t('sidebar.pendingBlockerApprovalHint');

    for (const [sessionKey, approvalItems] of Object.entries(deferredPendingApprovalsBySession)) {
      if (approvalCardsCount >= CHAT_APPROVAL_SCAN_LIMIT) {
        break;
      }
      const approvals = approvalItems ?? EMPTY_APPROVAL_ITEMS;
      const sessionLabel = deferredSessionTitles[sessionKey]
        || sessionKey;
      let variants = approvalCardsCacheByApprovalsRef.get(approvals);
      if (!variants) {
        variants = new Map<string, PendingBlockerCard[]>();
        approvalCardsCacheByApprovalsRef.set(approvals, variants);
      }
      const variantKey = `${sessionKey}|${sessionLabel}|${i18n.language}|${approvalTitlePrefix}|${approvalHint}`;
      let sessionCards = variants.get(variantKey);
      if (!sessionCards) {
        sessionCards = buildApprovalBlockerCards({
          sessionKey,
          approvals,
          sessionLabel,
          approvalTitlePrefix,
          approvalHint,
        });
        variants.set(variantKey, sessionCards);
      }
      if (sessionCards.length === 0) {
        continue;
      }
      const remain = CHAT_APPROVAL_SCAN_LIMIT - approvalCardsCount;
      if (sessionCards.length <= remain) {
        cards.push(...sessionCards);
        approvalCardsCount += sessionCards.length;
      } else {
        cards.push(...sessionCards.slice(0, remain));
        approvalCardsCount += remain;
      }
    }
    return cards;
  }, [
    deferredPendingApprovalsBySession,
    deferredSessionTitles,
    i18n.language,
    t,
  ]);

  const pendingBlockers = useMemo<PendingBlockerCard[]>(() => {
    return [...teamMailboxCards, ...approvalCards]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, SIDEBAR_BLOCKER_RENDER_LIMIT);
  }, [approvalCards, teamMailboxCards]);

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
  width = 256,
  railWidth = 64,
  showRightDivider = true,
}: SidebarProps) {
  const sidebarVisible = useLayoutStore((state) => state.sidebarVisible);
  const toggleSidebar = useLayoutStore((state) => state.toggleSidebar);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const newSession = useChatStore(selectSidebarNewSessionAction);
  const gatewayState = useGatewayStore((state) => state.status.state);
  const taskCenterInitialized = useTaskCenterStore((state) => state.initialized);
  const initTaskCenter = useTaskCenterStore((state) => state.init);
  const refreshTaskCenter = useTaskCenterStore((state) => state.refreshTasks);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const skillsSnapshotReady = useSkillsStore((state) => state.snapshotReady);
  const prefetchHandlesRef = useRef<Map<string, PrefetchScheduleHandle>>(new Map());

  const navigate = useNavigate();
  const location = useLocation();
  const isOnChat = location.pathname === '/';
  const sidebarCollapsed = !sidebarVisible;
  const sidebarExpanded = !sidebarCollapsed;
  const deferredSidebarExpanded = useDeferredValue(sidebarExpanded);
  const showExpandedExtras = sidebarExpanded && deferredSidebarExpanded;
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
      void fetchSkills({ silent: true });
      return;
    }

    if (path === '/tasks') {
      if (!taskCenterInitialized) {
        void initTaskCenter();
      }
      void refreshTaskCenter({ silent: true });
      return;
    }

    if (path === '/plugins') {
      void prewarmPluginsData();
    }
  }, [
    fetchSkills,
    gatewayState,
    initTaskCenter,
    prewarmPluginsData,
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
    if (to === '/skills' && gatewayState === 'running' && !skillsSnapshotReady) {
      void fetchSkills({ silent: true });
    }
    startTransition(() => {
      navigate(to);
    });
  }, [fetchSkills, gatewayState, location.pathname, navigate, skillsSnapshotReady]);

  return (
    <aside
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden bg-card',
        showRightDivider && 'border-r [border-right-color:var(--divider-line)]',
      )}
      style={{ width: sidebarCollapsed ? railWidth : width }}
    >
      <nav className="flex flex-1 flex-col gap-1.5 overflow-hidden p-3">
        <button
          type="button"
          onClick={() => {
            const { currentSessionKey, loadedSessions } = useChatStore.getState();
            const hasMessages = getSessionMessageCount(loadedSessions[currentSessionKey]) > 0;
            if (isOnChat && hasMessages) {
              newSession();
            }
            startTransition(() => {
              navigate('/');
            });
          }}
          className={cn(
            'flex items-center rounded-[var(--radius-pill)] px-3.5 py-2.5 text-sm font-medium tracking-[-0.01em] text-muted-foreground transition-[background-color,color,box-shadow]',
            'hover:bg-secondary hover:text-foreground',
            sidebarCollapsed ? 'justify-center gap-0 px-0' : 'gap-3',
          )}
        >
          <MessageSquare className="h-5 w-5 shrink-0" />
          <SidebarTextLabel collapsed={sidebarCollapsed} className="text-left">
            {t('sidebar.newChat')}
          </SidebarTextLabel>
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

        {showExpandedExtras && <SidebarPendingBlockers />}
      </nav>

      <div className="space-y-2 p-3 pt-0">
        {devModeUnlocked && showExpandedExtras && (
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
        onClick={toggleSidebar}
        ariaLabel={sidebarCollapsed ? t('sidebar.expandMenu') : t('sidebar.collapseMenu')}
        title={sidebarCollapsed ? t('sidebar.expandMenu') : t('sidebar.collapseMenu')}
        icon={sidebarCollapsed ? <ChevronRight className="h-2.5 w-2.5" /> : <ChevronLeft className="h-2.5 w-2.5" />}
      />
    </aside>
  );
}
