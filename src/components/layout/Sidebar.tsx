/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 * No longer fixed - sits inside the flex layout below the title bar.
 */
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Home,
  MessageSquare,
  Radio,
  Puzzle,
  Clock,
  Settings,
  ChevronLeft,
  ChevronRight,
  Terminal,
  ExternalLink,
  Bot,
  Users,
  ListTodo,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { useChatStore } from '@/stores/chat';
import { useTeamsStore } from '@/stores/teams';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PaneEdgeToggle } from '@/components/layout/PaneEdgeToggle';
import { useTranslation } from 'react-i18next';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  collapsed?: boolean;
  onClick?: () => void;
}

function NavItem({ to, icon, label, badge, collapsed, onClick }: NavItemProps) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          'hover:bg-accent hover:text-accent-foreground',
          isActive
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground',
          collapsed && 'justify-center px-2'
        )
      }
    >
      {icon}
      {!collapsed && (
        <>
          <span className="flex-1">{label}</span>
          {badge && (
            <Badge variant="secondary" className="ml-auto">
              {badge}
            </Badge>
          )}
        </>
      )}
    </NavLink>
  );
}

interface SidebarProps {
  expandedWidth?: number;
  collapsedWidth?: number;
}

export function Sidebar({ expandedWidth = 256, collapsedWidth = 64 }: SidebarProps) {
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((state) => state.setSidebarCollapsed);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const teams = useTeamsStore((state) => state.teams);
  const activeTeamId = useTeamsStore((state) => state.activeTeamId);
  const teamsRoute = activeTeamId && teams.some((team) => team.id === activeTeamId)
    ? `/teams/${activeTeamId}`
    : '/teams';

  const newSession = useChatStore((s) => s.newSession);

  const navigate = useNavigate();
  const location = useLocation();

  const openDevConsole = async () => {
    try {
      const result = await window.electron.ipcRenderer.invoke('gateway:getControlUiUrl') as {
        success: boolean;
        url?: string;
        error?: string;
      };
      if (result.success && result.url) {
        window.electron.openExternal(result.url);
      } else {
        console.error('Failed to get Dev Console URL:', result.error);
      }
    } catch (err) {
      console.error('Error opening Dev Console:', err);
    }
  };

  const { t } = useTranslation();

  const navItems = [
    { to: '/cron', icon: <Clock className="h-5 w-5" />, label: t('sidebar.cronTasks') },
    { to: '/tasks', icon: <ListTodo className="h-5 w-5" />, label: t('sidebar.tasks') },
    { to: '/skills', icon: <Puzzle className="h-5 w-5" />, label: t('sidebar.skills') },
    { to: '/channels', icon: <Radio className="h-5 w-5" />, label: t('sidebar.channels') },
    { to: '/subagents', icon: <Bot className="h-5 w-5" />, label: t('sidebar.subagents') },
    { to: teamsRoute, icon: <Users className="h-5 w-5" />, label: t('sidebar.agentsWorkspace') },
    { to: '/dashboard', icon: <Home className="h-5 w-5" />, label: t('sidebar.dashboard') },
    { to: '/settings', icon: <Settings className="h-5 w-5" />, label: t('sidebar.settings') },
  ];

  return (
    <aside
      className={cn(
        'relative flex shrink-0 flex-col border-r bg-background transition-all duration-300'
      )}
      style={{ width: sidebarCollapsed ? collapsedWidth : expandedWidth }}
    >
      {/* Navigation */}
      <nav className="flex-1 overflow-hidden flex flex-col p-2 gap-1">
        {/* Chat nav item: from non-chat routes it only navigates to chat;
            on chat route it acts as "New Chat". */}
        <button
          onClick={() => {
            const { messages } = useChatStore.getState();
            const isChatRoute = location.pathname === '/';
            if (isChatRoute && messages.length > 0) newSession();
            navigate('/');
          }}
          className={cn(
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            'hover:bg-accent hover:text-accent-foreground text-muted-foreground',
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
          />
        ))}

      </nav>

      {/* Footer */}
      <div className="p-2 space-y-2">
        {devModeUnlocked && !sidebarCollapsed && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={openDevConsole}
          >
            <Terminal className="h-4 w-4 mr-2" />
            {t('sidebar.devConsole')}
            <ExternalLink className="h-3 w-3 ml-auto" />
          </Button>
        )}
      </div>

      <PaneEdgeToggle
        side="right"
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        ariaLabel={sidebarCollapsed
          ? t('sidebar.expandMenu', { defaultValue: '展开菜单栏' })
          : t('sidebar.collapseMenu', { defaultValue: '收起菜单栏' })}
        title={sidebarCollapsed
          ? t('sidebar.expandMenu', { defaultValue: '展开菜单栏' })
          : t('sidebar.collapseMenu', { defaultValue: '收起菜单栏' })}
        icon={sidebarCollapsed ? <ChevronRight className="h-2.5 w-2.5" /> : <ChevronLeft className="h-2.5 w-2.5" />}
      />
    </aside>
  );
}
