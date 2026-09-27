/**
 * TitleBar Component
 * macOS: drag region with native traffic lights handled by hiddenInset.
 * Windows: custom title bar with window controls.
 * Linux: use native title bar for better IME compatibility.
 */
import { useState, useEffect } from 'react';
import { Minus, Square, X, Copy, Settings, PanelRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import logoSvg from '@/assets/logo.svg';
import { invokeIpc } from '@/lib/api-client';
import { preloadLazyRouteForPath } from '@/lib/route-preload';
import { useLayoutStore } from '@/stores/layout';

export function TitleBar() {
  const platform = window.electron?.platform;
  if (platform === 'darwin') {
    return <MacTitleBar />;
  }

  if (platform !== 'win32') {
    return null;
  }

  return <WindowsTitleBar />;
}

function SidebarToggleButton() {
  const sidebarVisible = useLayoutStore((state) => state.sidebarVisible);
  const setSidebarVisible = useLayoutStore((state) => state.setSidebarVisible);
  const { t } = useTranslation();
  const label = sidebarVisible ? t('sidebar.collapseMenu') : t('sidebar.expandMenu');

  return (
    <button
      type="button"
      onClick={() => setSidebarVisible(!sidebarVisible)}
      className="flex h-7 w-7 items-center justify-center rounded-[10px] text-[hsl(var(--shell-icon))] transition-[background-color,color] hover:bg-[hsl(var(--shell-surface-hover))] hover:text-[hsl(var(--shell-icon-active))]"
      title={label}
      aria-label={label}
    >
      <PanelRight className="h-[17px] w-[17px]" />
    </button>
  );
}

function SettingsButton() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const handleOpenSettings = () => {
    navigate('/settings');
  };

  const handleSettingsHover = () => {
    void preloadLazyRouteForPath('/settings');
  };

  return (
    <button
      type="button"
      onClick={handleOpenSettings}
      onMouseEnter={handleSettingsHover}
      onFocus={handleSettingsHover}
      className="flex h-full w-10 items-center justify-center rounded-[10px] text-[hsl(var(--shell-icon))] transition-[background-color,color] hover:bg-[hsl(var(--shell-surface-hover))] hover:text-[hsl(var(--shell-icon-active))]"
      title={t('sidebar.settings')}
    >
      <Settings className="h-[17px] w-[17px]" />
    </button>
  );
}

function MacTitleBar() {
  return (
    <div className="drag-region flex h-12 shrink-0 items-center justify-end border-b bg-[hsl(var(--shell-surface))] px-3 [border-color:hsl(var(--shell-border))]">
      <div className="no-drag flex h-full">
        <SidebarToggleButton />
        <SettingsButton />
      </div>
    </div>
  );
}

function WindowsTitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // Check initial state
    invokeIpc('window:isMaximized').then((val) => {
      setMaximized(val as boolean);
    });
  }, []);

  const handleMinimize = () => {
    invokeIpc('window:minimize');
  };

  const handleMaximize = () => {
    invokeIpc('window:maximize').then(() => {
      invokeIpc('window:isMaximized').then((val) => {
        setMaximized(val as boolean);
      });
    });
  };

  const handleClose = () => {
    invokeIpc('window:close');
  };

  return (
    <div className="drag-region flex h-12 shrink-0 items-center justify-between border-b bg-[hsl(var(--shell-surface))] px-3 [border-color:hsl(var(--shell-border))]">
      <div className="no-drag flex h-full items-center gap-2">
        <SidebarToggleButton />
        <img src={logoSvg} alt="MatchaClaw" className="h-5 w-auto" />
        <span className="select-none text-[11px] font-semibold tracking-[0.12em] text-[hsl(var(--shell-text-muted))]">
          MatchaClaw
        </span>
      </div>

      <div className="no-drag flex h-full">
        <SettingsButton />
        <button
          onClick={handleMinimize}
          className="flex h-full w-10 items-center justify-center rounded-[10px] text-[hsl(var(--shell-icon))] transition-[background-color,color] hover:bg-[hsl(var(--shell-surface-hover))] hover:text-[hsl(var(--shell-icon-active))]"
          title="Minimize"
        >
          <Minus className="h-[17px] w-[17px]" />
        </button>
        <button
          onClick={handleMaximize}
          className="flex h-full w-10 items-center justify-center rounded-[10px] text-[hsl(var(--shell-icon))] transition-[background-color,color] hover:bg-[hsl(var(--shell-surface-hover))] hover:text-[hsl(var(--shell-icon-active))]"
          title={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? <Copy className="h-4 w-4" /> : <Square className="h-4 w-4" />}
        </button>
        <button
          onClick={handleClose}
          className="flex h-full w-10 items-center justify-center rounded-[10px] text-[hsl(var(--shell-icon))] transition-[background-color,color] hover:bg-destructive/90 hover:text-destructive-foreground"
          title="Close"
        >
          <X className="h-[17px] w-[17px]" />
        </button>
      </div>
    </div>
  );
}
