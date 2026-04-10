/**
 * TitleBar Component
 * macOS: empty drag region (native traffic lights handled by hiddenInset).
 * Windows: custom title bar with window controls.
 * Linux: use native title bar for better IME compatibility.
 */
import { useState, useEffect } from 'react';
import { Minus, Square, X, Copy, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import logoSvg from '@/assets/logo.svg';
import { invokeIpc } from '@/lib/api-client';

export function TitleBar() {
  const platform = window.electron?.platform;
  if (platform === 'darwin') {
    return <div className="drag-region h-12 shrink-0 border-b border-border/70 bg-card/96 backdrop-blur-xl" />;
  }

  if (platform !== 'win32') {
    return null;
  }

  return <WindowsTitleBar />;
}

function WindowsTitleBar() {
  const [maximized, setMaximized] = useState(false);
  const navigate = useNavigate();
  const { t } = useTranslation();

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

  const handleOpenSettings = () => {
    navigate('/settings');
  };

  return (
    <div className="drag-region flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-card/96 px-3 backdrop-blur-xl">
      <div className="no-drag flex items-center gap-2">
        <img src={logoSvg} alt="MatchaClaw" className="h-5 w-auto" />
        <span className="select-none text-xs font-semibold tracking-[0.08em] text-muted-foreground">
          MatchaClaw
        </span>
      </div>

      <div className="no-drag flex h-full">
        <button
          onClick={handleOpenSettings}
          className="flex h-full w-11 items-center justify-center rounded-[var(--radius-pill)] text-muted-foreground transition-colors hover:bg-secondary/80 hover:text-foreground"
          title={t('sidebar.settings')}
        >
          <Settings className="h-4 w-4" />
        </button>
        <button
          onClick={handleMinimize}
          className="flex h-full w-11 items-center justify-center rounded-[var(--radius-pill)] text-muted-foreground transition-colors hover:bg-secondary/80 hover:text-foreground"
          title="Minimize"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          onClick={handleMaximize}
          className="flex h-full w-11 items-center justify-center rounded-[var(--radius-pill)] text-muted-foreground transition-colors hover:bg-secondary/80 hover:text-foreground"
          title={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={handleClose}
          className="flex h-full w-11 items-center justify-center rounded-[var(--radius-pill)] text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
