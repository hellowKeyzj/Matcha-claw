/**
 * Main Layout Component
 * TitleBar at top, then sidebar + content below.
 */
import { useEffect, useRef, useState } from 'react';
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

  function getRenderedSidebarWidth(): number {
    return sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth;
  }

  function getAgentSessionsMaxWidth(containerWidth: number, renderedSidebarWidth: number): number {
    const sidebarResizerWidth = sidebarCollapsed ? 0 : LAYOUT_RESIZER_WIDTH;
    const reserved = MAIN_CONTENT_MIN_WIDTH + renderedSidebarWidth + sidebarResizerWidth + LAYOUT_RESIZER_WIDTH;
    return Math.max(AGENT_SESSIONS_PANE_MIN_WIDTH, containerWidth - reserved);
  }

  function getSidebarMaxWidth(containerWidth: number): number {
    const agentPaneWidth = isChatRoute
      ? (agentSessionsCollapsed ? AGENT_SESSIONS_COLLAPSED_WIDTH : agentSessionsWidth + LAYOUT_RESIZER_WIDTH)
      : 0;
    const sidebarResizerWidth = sidebarCollapsed ? 0 : LAYOUT_RESIZER_WIDTH;
    const reserved = MAIN_CONTENT_MIN_WIDTH + agentPaneWidth + sidebarResizerWidth;
    return Math.max(SIDEBAR_MIN_WIDTH, containerWidth - reserved);
  }

  useEffect(() => {
    try {
      window.localStorage.setItem('layout:sidebar-width', String(sidebarWidth));
    } catch {
      // ignore localStorage failures
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem('layout:agent-sessions-collapsed', agentSessionsCollapsed ? '1' : '0');
    } catch {
      // ignore localStorage failures
    }
  }, [agentSessionsCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem('layout:agent-sessions-width', String(agentSessionsWidth));
    } catch {
      // ignore localStorage failures
    }
  }, [agentSessionsWidth]);

  useEffect(() => {
    const handleResize = () => {
      const layoutWidth = layoutRef.current?.clientWidth ?? window.innerWidth;
      const maxWidth = getSidebarMaxWidth(layoutWidth);
      const nextSidebarWidth = sidebarCollapsed
        ? SIDEBAR_COLLAPSED_WIDTH
        : clamp(sidebarWidth, SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, maxWidth));

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
  }, [agentSessionsCollapsed, isChatRoute, sidebarCollapsed, sidebarWidth, agentSessionsWidth]);

  const startSidebarResize = (event: React.MouseEvent<HTMLDivElement>) => {
    if (sidebarCollapsed) {
      return;
    }
    event.preventDefault();
    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = layoutRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const maxWidth = getSidebarMaxWidth(rect.width);
      const nextWidth = clamp(
        moveEvent.clientX - rect.left,
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, maxWidth),
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

  const startAgentSessionsResize = (event: React.MouseEvent<HTMLDivElement>) => {
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
      const agentPaneLeft = rect.left + renderedSidebarWidth + sidebarResizerWidth;
      const maxWidth = getAgentSessionsMaxWidth(rect.width, renderedSidebarWidth);
      const nextWidth = clamp(
        moveEvent.clientX - agentPaneLeft,
        AGENT_SESSIONS_PANE_MIN_WIDTH,
        Math.min(AGENT_SESSIONS_PANE_MAX_WIDTH, maxWidth),
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
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Title bar: drag region on macOS, icon + controls on Windows */}
      <TitleBar />

      {/* Below the title bar: sidebar + content */}
      <div ref={layoutRef} className="flex flex-1 overflow-hidden">
        <Sidebar expandedWidth={sidebarWidth} />
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
        <main className="min-w-0 flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
