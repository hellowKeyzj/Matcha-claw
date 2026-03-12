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
  Clock,
  ListTodo,
  Users,
  Settings,
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
import { Button } from '@/components/ui/button';
import { PaneEdgeToggle } from '@/components/layout/PaneEdgeToggle';
import { hostApiFetch } from '@/lib/host-api';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo } from 'react';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  collapsed?: boolean;
  onMouseEnter?: () => void;
}

interface SidebarProps {
  expandedWidth?: number;
  collapsedWidth?: number;
}

interface PendingBlockerCard {
  id: string;
  source: 'team_mailbox' | 'task_manager';
  teamId: string;
  teamName: string;
  title: string;
  content: string;
  from: string;
  createdAt: number;
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

function NavItem({ to, icon, label, collapsed, onMouseEnter }: NavItemProps) {
  return (
    <NavLink
      to={to}
      onMouseEnter={onMouseEnter}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          'hover:bg-accent hover:text-accent-foreground',
          isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
          collapsed && 'justify-center px-2',
        )
      }
    >
      {icon}
      {!collapsed && <span className="flex-1">{label}</span>}
    </NavLink>
  );
}

export function Sidebar({ expandedWidth = 256, collapsedWidth = 64 }: SidebarProps) {
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((state) => state.setSidebarCollapsed);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const newSession = useChatStore((state) => state.newSession);
  const gatewayState = useGatewayStore((state) => state.status.state);
  const teams = useTeamsStore((state) => state.teams);
  const mailboxByTeamId = useTeamsStore((state) => state.mailboxByTeamId);
  const setActiveTeam = useTeamsStore((state) => state.setActiveTeam);
  const taskCenterInitialized = useTaskCenterStore((state) => state.initialized);
  const taskCenterTasks = useTaskCenterStore((state) => state.tasks);
  const blockedQueue = useTaskCenterStore((state) => state.blockedQueue);
  const initTaskCenter = useTaskCenterStore((state) => state.init);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);

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
    { to: '/cron', icon: <Clock className="h-5 w-5" />, label: t('sidebar.cronTasks') },
    { to: '/skills', icon: <Puzzle className="h-5 w-5" />, label: t('sidebar.skills') },
    { to: '/channels', icon: <Radio className="h-5 w-5" />, label: t('sidebar.channels') },
    { to: '/subagents', icon: <Bot className="h-5 w-5" />, label: t('sidebar.subagents') },
    { to: '/tasks', icon: <ListTodo className="h-5 w-5" />, label: t('sidebar.tasks') },
    { to: '/teams', icon: <Users className="h-5 w-5" />, label: t('sidebar.teams') },
    { to: '/dashboard', icon: <Home className="h-5 w-5" />, label: t('sidebar.dashboard') },
    { to: '/settings', icon: <Settings className="h-5 w-5" />, label: t('sidebar.settings') },
  ];

  const prefetchSkillsOnHover = useCallback(() => {
    if (gatewayState !== 'running') {
      return;
    }
    void fetchSkills();
  }, [fetchSkills, gatewayState]);

  useEffect(() => {
    if (gatewayState !== 'running' || taskCenterInitialized) {
      return;
    }
    void initTaskCenter();
  }, [gatewayState, initTaskCenter, taskCenterInitialized]);

  const pendingBlockers = useMemo<PendingBlockerCard[]>(() => {
    const cards: PendingBlockerCard[] = [];
    for (const team of teams) {
      const mailbox = mailboxByTeamId[team.id] ?? [];
      if (mailbox.length === 0) {
        continue;
      }

      const latestDecisionAtByTask = new Map<string, number>();
      for (const message of mailbox) {
        if (message.kind !== 'decision' || !message.relatedTaskId) {
          continue;
        }
        const prev = latestDecisionAtByTask.get(message.relatedTaskId) ?? 0;
        if (message.createdAt > prev) {
          latestDecisionAtByTask.set(message.relatedTaskId, message.createdAt);
        }
      }

      for (const message of mailbox) {
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
      }
    }

    const taskById = new Map(taskCenterTasks.map((task) => [task.id, task]));
    for (const blocked of blockedQueue) {
      const task = taskById.get(blocked.taskId);
      const statusLabel = blocked.type === 'waiting_approval'
        ? t('sidebar.pendingBlockerTypeApproval')
        : t('sidebar.pendingBlockerTypeInput');
      const goal = typeof task?.goal === 'string' && task.goal.trim().length > 0
        ? task.goal.trim()
        : blocked.taskId;
      cards.push({
        id: `task:${blocked.taskId}:${blocked.confirmId}`,
        source: 'task_manager',
        teamId: '',
        teamName: t('sidebar.tasks'),
        title: `${statusLabel} · ${goal}`,
        content: blocked.prompt,
        from: blocked.taskId,
        createdAt: (
          (typeof task?.updated_at === 'number' ? task.updated_at : 0)
          || (typeof task?.created_at === 'number' ? task.created_at : 0)
          || 0
        ),
      });
    }

    return cards
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 8);
  }, [blockedQueue, mailboxByTeamId, t, taskCenterTasks, teams]);

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-border/80 bg-card transition-all duration-300"
      style={{ width: sidebarCollapsed ? collapsedWidth : expandedWidth }}
    >
      <nav className="flex flex-1 flex-col gap-1 overflow-hidden p-2">
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
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors',
            'hover:bg-accent hover:text-accent-foreground',
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
            onMouseEnter={item.to === '/skills' ? prefetchSkillsOnHover : undefined}
          />
        ))}

        {!sidebarCollapsed && (
          <section className="mt-3 rounded-lg border border-border/70 bg-muted/30 p-2">
            <header className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-foreground">{t('sidebar.pendingBlockers')}</h3>
              <span className="text-[11px] text-muted-foreground">{pendingBlockers.length}</span>
            </header>
            {pendingBlockers.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/70 px-2 py-3 text-center text-xs text-muted-foreground">
                {t('sidebar.pendingBlockersEmpty')}
              </div>
            ) : (
              <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                {pendingBlockers.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className="w-full rounded-md border border-border/70 bg-background px-2 py-2 text-left transition-colors hover:bg-accent/50"
                    onClick={() => {
                      if (card.source === 'team_mailbox') {
                        setActiveTeam(card.teamId);
                        navigate(`/teams/${card.teamId}`);
                        return;
                      }
                      navigate('/tasks');
                    }}
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span className="truncate">
                        {card.source === 'team_mailbox'
                          ? card.teamName
                          : t('sidebar.pendingBlockerSourceTask')}
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
                        : t('sidebar.pendingBlockerTaskId', { taskId: card.from })}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </nav>

      <div className="space-y-2 p-2">
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
