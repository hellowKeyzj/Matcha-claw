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
import { Button } from '@/components/ui/button';
import { PaneEdgeToggle } from '@/components/layout/PaneEdgeToggle';
import { hostApiFetch } from '@/lib/host-api';
import { useTranslation } from 'react-i18next';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  collapsed?: boolean;
}

interface SidebarProps {
  expandedWidth?: number;
  collapsedWidth?: number;
}

function NavItem({ to, icon, label, collapsed }: NavItemProps) {
  return (
    <NavLink
      to={to}
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

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r bg-background transition-all duration-300"
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
          <NavItem key={item.to} {...item} collapsed={sidebarCollapsed} />
        ))}
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
