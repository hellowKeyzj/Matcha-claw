/**
 * Main Layout Component
 * TitleBar at top, then resizable panes below.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { AgentSessionsPane } from './AgentSessionsPane';
import { TitleBar } from './TitleBar';
import { VerticalPaneResizer } from './VerticalPaneResizer';
import { useSettingsStore } from '@/stores/settings';

const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 256;
const SIDEBAR_COLLAPSED_WIDTH = 64;
const LAYOUT_RESIZER_WIDTH = 6;
const AGENT_SESSIONS_PANE_MIN_WIDTH = 220;
const AGENT_SESSIONS_PANE_MAX_WIDTH = 520;
const AGENT_SESSIONS_PANE_DEFAULT_WIDTH = 300;
const AGENT_SESSIONS_COLLAPSED_WIDTH = 52;
const MAIN_CONTENT_MIN_WIDTH = 520;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadSidebarWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem('layout:sidebar-width') || SIDEBAR_DEFAULT_WIDTH);
    if (!Number.isFinite(raw)) {
      return SIDEBAR_DEFAULT_WIDTH;
    }
    return clamp(raw, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function loadAgentSessionsWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem('layout:agent-sessions-width') || AGENT_SESSIONS_PANE_DEFAULT_WIDTH);
    if (!Number.isFinite(raw)) {
      return AGENT_SESSIONS_PANE_DEFAULT_WIDTH;
    }
    return clamp(raw, AGENT_SESSIONS_PANE_MIN_WIDTH, AGENT_SESSIONS_PANE_MAX_WIDTH);
  } catch {
    return AGENT_SESSIONS_PANE_DEFAULT_WIDTH;
  }
}

export function MainLayout() {
  const location = useLocation();
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => loadSidebarWidth());
  const [agentSessionsWidth, setAgentSessionsWidth] = useState<number>(() => loadAgentSessionsWidth());
  const [agentSessionsCollapsed, setAgentSessionsCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('layout:agent-sessions-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const layoutRef = useRef<HTMLDivElement>(null);
  const isChatRoute = location.pathname === '/';

  const getRenderedSidebarWidth = useCallback(
    () => (sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth),
    [sidebarCollapsed, sidebarWidth],
  );

  const getAgentSessionsMaxWidth = useCallback((containerWidth: number, renderedSidebarWidth: number) => {
    const sidebarResizerWidth = sidebarCollapsed ? 0 : LAYOUT_RESIZER_WIDTH;
    const reserved = MAIN_CONTENT_MIN_WIDTH + renderedSidebarWidth + sidebarResizerWidth + LAYOUT_RESIZER_WIDTH;
    return Math.max(AGENT_SESSIONS_PANE_MIN_WIDTH, containerWidth - reserved);
  }, [sidebarCollapsed]);

  const getSidebarMaxWidth = useCallback((containerWidth: number) => {
    const agentPaneWidth = isChatRoute
      ? (agentSessionsCollapsed ? AGENT_SESSIONS_COLLAPSED_WIDTH : agentSessionsWidth + LAYOUT_RESIZER_WIDTH)
      : 0;
    const sidebarResizerWidth = sidebarCollapsed ? 0 : LAYOUT_RESIZER_WIDTH;
    const reserved = MAIN_CONTENT_MIN_WIDTH + agentPaneWidth + sidebarResizerWidth;
    return Math.max(SIDEBAR_MIN_WIDTH, containerWidth - reserved);
  }, [agentSessionsCollapsed, agentSessionsWidth, isChatRoute, sidebarCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem('layout:sidebar-width', String(sidebarWidth));
    } catch {
      // ignore localStorage errors
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem('layout:agent-sessions-collapsed', agentSessionsCollapsed ? '1' : '0');
    } catch {
      // ignore localStorage errors
    }
  }, [agentSessionsCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem('layout:agent-sessions-width', String(agentSessionsWidth));
    } catch {
      // ignore localStorage errors
    }
  }, [agentSessionsWidth]);

  useEffect(() => {
    const handleResize = () => {
      const layoutWidth = layoutRef.current?.clientWidth ?? window.innerWidth;
      const maxSidebarWidth = getSidebarMaxWidth(layoutWidth);
      const nextSidebarWidth = sidebarCollapsed
        ? SIDEBAR_COLLAPSED_WIDTH
        : clamp(sidebarWidth, SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, maxSidebarWidth));

      if (!sidebarCollapsed) {
        setSidebarWidth(nextSidebarWidth);
      }

      if (isChatRoute && !agentSessionsCollapsed) {
        const maxAgentWidth = getAgentSessionsMaxWidth(layoutWidth, nextSidebarWidth);
        setAgentSessionsWidth((prev) => clamp(
          prev,
          AGENT_SESSIONS_PANE_MIN_WIDTH,
          Math.min(AGENT_SESSIONS_PANE_MAX_WIDTH, maxAgentWidth),
        ));
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [
    agentSessionsCollapsed,
    getAgentSessionsMaxWidth,
    getSidebarMaxWidth,
    isChatRoute,
    sidebarCollapsed,
    sidebarWidth,
  ]);

  const startSidebarResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (sidebarCollapsed) {
      return;
    }
    event.preventDefault();

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = layoutRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const maxSidebarWidth = getSidebarMaxWidth(rect.width);
      const nextWidth = clamp(
        moveEvent.clientX - rect.left,
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, maxSidebarWidth),
      );
      setSidebarWidth(nextWidth);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const startAgentSessionsResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!isChatRoute || agentSessionsCollapsed) {
      return;
    }
    event.preventDefault();

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = layoutRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const renderedSidebarWidth = getRenderedSidebarWidth();
      const sidebarResizerWidth = sidebarCollapsed ? 0 : LAYOUT_RESIZER_WIDTH;
      const paneLeft = rect.left + renderedSidebarWidth + sidebarResizerWidth;
      const maxAgentWidth = getAgentSessionsMaxWidth(rect.width, renderedSidebarWidth);
      const nextWidth = clamp(
        moveEvent.clientX - paneLeft,
        AGENT_SESSIONS_PANE_MIN_WIDTH,
        Math.min(AGENT_SESSIONS_PANE_MAX_WIDTH, maxAgentWidth),
      );
      setAgentSessionsWidth(nextWidth);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div className="app-shell-bg flex h-screen flex-col overflow-hidden bg-background">
      <TitleBar />

      <div
        ref={layoutRef}
        className="flex flex-1 overflow-hidden"
      >
        <Sidebar expandedWidth={sidebarWidth} collapsedWidth={SIDEBAR_COLLAPSED_WIDTH} />
        {!sidebarCollapsed && (
          <VerticalPaneResizer
            testId="layout-left-resizer"
            onMouseDown={startSidebarResize}
            ariaLabel="Resize sidebar"
          />
        )}
        {isChatRoute && (
          <AgentSessionsPane
            expandedWidth={agentSessionsWidth}
            collapsed={agentSessionsCollapsed}
            collapsedWidth={AGENT_SESSIONS_COLLAPSED_WIDTH}
            onToggleCollapse={() => setAgentSessionsCollapsed((prev) => !prev)}
          />
        )}
        {isChatRoute && !agentSessionsCollapsed && (
          <VerticalPaneResizer
            testId="layout-agent-sessions-resizer"
            onMouseDown={startAgentSessionsResize}
            ariaLabel="Resize agent sessions pane"
            variant="subtle-border"
          />
        )}
        <main className="min-w-0 flex-1 overflow-auto bg-card p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
