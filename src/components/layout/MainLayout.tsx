/**
 * Main Layout Component
 * TitleBar at top, then resizable panes below.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { ChatWorkspaceHost } from './ChatWorkspaceHost';
import { TitleBar } from './TitleBar';
import { VerticalPaneResizer } from './VerticalPaneResizer';
import { cn } from '@/lib/utils';
import {
  CHAT_WORKSPACE_LAYOUT,
  clampPaneWidth,
  getAgentSessionsResizeMaxWidth,
  getSidebarResizeMaxWidth,
  resolveChatWorkspaceLayout,
} from '@/pages/Chat/chat-workspace-layout';
import { useSettingsStore } from '@/stores/settings';

function loadSidebarWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem('layout:sidebar-width') || CHAT_WORKSPACE_LAYOUT.sidebarDefaultWidth);
    if (!Number.isFinite(raw)) {
      return CHAT_WORKSPACE_LAYOUT.sidebarDefaultWidth;
    }
    return clampPaneWidth(raw, CHAT_WORKSPACE_LAYOUT.sidebarMinWidth, CHAT_WORKSPACE_LAYOUT.sidebarMaxWidth);
  } catch {
    return CHAT_WORKSPACE_LAYOUT.sidebarDefaultWidth;
  }
}

function loadAgentSessionsWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem('layout:agent-sessions-width') || CHAT_WORKSPACE_LAYOUT.agentSessionsDefaultWidth);
    if (!Number.isFinite(raw)) {
      return CHAT_WORKSPACE_LAYOUT.agentSessionsDefaultWidth;
    }
    return clampPaneWidth(
      raw,
      CHAT_WORKSPACE_LAYOUT.agentSessionsMinWidth,
      CHAT_WORKSPACE_LAYOUT.agentSessionsMaxWidth,
    );
  } catch {
    return CHAT_WORKSPACE_LAYOUT.agentSessionsDefaultWidth;
  }
}

export function MainLayout() {
  const location = useLocation();
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const [sidebarPreferredWidth, setSidebarPreferredWidth] = useState<number>(() => loadSidebarWidth());
  const [agentSessionsPreferredWidth, setAgentSessionsPreferredWidth] = useState<number>(() => loadAgentSessionsWidth());
  const [agentSessionsUserCollapsed, setAgentSessionsUserCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('layout:agent-sessions-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const [containerWidth, setContainerWidth] = useState<number>(() => window.innerWidth);
  const layoutRef = useRef<HTMLDivElement>(null);
  const resizeRafRef = useRef<number | null>(null);
  const isChatRoute = location.pathname === '/';

  const workspaceLayout = useMemo(() => resolveChatWorkspaceLayout({
    containerWidth,
    sidebarCollapsed,
    sidebarPreferredWidth,
    agentSessionsUserCollapsed,
    agentSessionsPreferredWidth,
  }), [
    agentSessionsPreferredWidth,
    agentSessionsUserCollapsed,
    containerWidth,
    sidebarCollapsed,
    sidebarPreferredWidth,
  ]);

  useEffect(() => {
    try {
      window.localStorage.setItem('layout:sidebar-width', String(sidebarPreferredWidth));
    } catch {
      // ignore localStorage errors
    }
  }, [sidebarPreferredWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem('layout:agent-sessions-collapsed', agentSessionsUserCollapsed ? '1' : '0');
    } catch {
      // ignore localStorage errors
    }
  }, [agentSessionsUserCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem('layout:agent-sessions-width', String(agentSessionsPreferredWidth));
    } catch {
      // ignore localStorage errors
    }
  }, [agentSessionsPreferredWidth]);

  useEffect(() => {
    const applyResize = () => {
      const nextContainerWidth = layoutRef.current?.clientWidth ?? window.innerWidth;
      setContainerWidth((prev) => (prev === nextContainerWidth ? prev : nextContainerWidth));
    };

    const scheduleResize = () => {
      if (resizeRafRef.current != null) {
        return;
      }
      resizeRafRef.current = window.requestAnimationFrame(() => {
        resizeRafRef.current = null;
        applyResize();
      });
    };

    scheduleResize();
    window.addEventListener('resize', scheduleResize);
    return () => {
      window.removeEventListener('resize', scheduleResize);
      if (resizeRafRef.current != null) {
        window.cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, []);

  const setAgentSessionsCollapsed = useCallback((next: SetStateAction<boolean>) => {
    const desiredCollapsed = typeof next === 'function'
      ? next(workspaceLayout.agentSessionsCollapsed)
      : next;
    setAgentSessionsUserCollapsed(desiredCollapsed);
    if (!desiredCollapsed) {
      setAgentSessionsPreferredWidth((prev) => clampPaneWidth(
        prev,
        CHAT_WORKSPACE_LAYOUT.agentSessionsMinWidth,
        getAgentSessionsResizeMaxWidth(containerWidth, workspaceLayout.sidebarWidth, sidebarCollapsed),
      ));
    }
  }, [containerWidth, sidebarCollapsed, workspaceLayout.agentSessionsCollapsed, workspaceLayout.sidebarWidth]);

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
      const nextWidth = clampPaneWidth(
        moveEvent.clientX - rect.left,
        CHAT_WORKSPACE_LAYOUT.sidebarMinWidth,
        getSidebarResizeMaxWidth(rect.width),
      );
      setSidebarPreferredWidth(nextWidth);
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
    if (workspaceLayout.agentSessionsCollapsed) {
      return;
    }
    event.preventDefault();

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = layoutRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const renderedSidebarWidth = workspaceLayout.sidebarWidth;
      const sidebarResizerWidth = sidebarCollapsed ? 0 : CHAT_WORKSPACE_LAYOUT.paneResizerWidth;
      const paneLeft = rect.left + renderedSidebarWidth + sidebarResizerWidth;
      const nextWidth = clampPaneWidth(
        moveEvent.clientX - paneLeft,
        CHAT_WORKSPACE_LAYOUT.agentSessionsMinWidth,
        getAgentSessionsResizeMaxWidth(rect.width, renderedSidebarWidth, sidebarCollapsed),
      );
      setAgentSessionsPreferredWidth(nextWidth);
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
        className="flex flex-1 overflow-hidden bg-card"
      >
        <Sidebar
          expandedWidth={workspaceLayout.sidebarWidth}
          collapsedWidth={CHAT_WORKSPACE_LAYOUT.sidebarCollapsedWidth}
          showRightDivider={sidebarCollapsed}
        />
        {!sidebarCollapsed && (
          <VerticalPaneResizer
            testId="layout-left-resizer"
            onMouseDown={startSidebarResize}
            ariaLabel="Resize sidebar"
            variant="subtle-border"
          />
        )}
        <main className="relative min-w-0 flex-1 overflow-hidden bg-card">
          <ChatWorkspaceHost
            isActive={isChatRoute}
            agentSessionsWidth={workspaceLayout.agentSessionsWidth}
            agentSessionsCollapsed={workspaceLayout.agentSessionsCollapsed}
            agentSessionsCollapsedWidth={CHAT_WORKSPACE_LAYOUT.agentSessionsCollapsedWidth}
            onToggleAgentSessionsCollapse={() => setAgentSessionsCollapsed((prev) => !prev)}
            onAgentSessionsResizeStart={startAgentSessionsResize}
          />
          {!isChatRoute && (
            <div
              data-testid="main-layout-route-overlay"
              className={cn(
                'absolute inset-0 z-10 h-full overflow-auto bg-card px-5 py-4 md:px-8 md:py-6',
              )}
            >
              <Outlet />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
