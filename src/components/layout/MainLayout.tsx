/**
 * Main Layout Component
 * TitleBar at top, then layout panes below.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { ChatWorkspaceHost } from './ChatWorkspaceHost';
import { TitleBar } from './TitleBar';
import { VerticalPaneResizer } from './VerticalPaneResizer';
import {
  CHAT_WORKSPACE_LAYOUT,
  resolveChatWorkspaceLayout,
} from '@/pages/Chat/chat-workspace-layout';
import { useLayoutStore } from '@/stores/layout';

export function MainLayout() {
  const location = useLocation();
  const sidebarVisible = useLayoutStore((state) => state.sidebarVisible);
  const sidebarWidth = useLayoutStore((state) => state.sidebarWidth);
  const setSidebarWidth = useLayoutStore((state) => state.setSidebarWidth);
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
    sidebarVisible,
    sidebarWidth,
    agentSessionsUserCollapsed,
  }), [
    agentSessionsUserCollapsed,
    containerWidth,
    sidebarVisible,
    sidebarWidth,
  ]);

  useEffect(() => {
    try {
      window.localStorage.setItem('layout:agent-sessions-collapsed', agentSessionsUserCollapsed ? '1' : '0');
    } catch {
      // ignore localStorage errors
    }
  }, [agentSessionsUserCollapsed]);

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
  }, [workspaceLayout.agentSessionsCollapsed]);

  const startSidebarResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!sidebarVisible) {
      return;
    }
    event.preventDefault();

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = layoutRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      setSidebarWidth(moveEvent.clientX - rect.left, rect.width);
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
          width={workspaceLayout.sidebarWidth}
          railWidth={CHAT_WORKSPACE_LAYOUT.sidebarRailWidth}
          containerWidth={containerWidth}
          showRightDivider={!sidebarVisible}
        />
        {sidebarVisible && (
          <VerticalPaneResizer
            testId="layout-left-resizer"
            onMouseDown={startSidebarResize}
            ariaLabel="Resize sidebar"
            variant="subtle-border"
          />
        )}
        <main className="min-w-0 flex-1 overflow-hidden bg-card">
          {isChatRoute ? (
            <ChatWorkspaceHost
              agentSessionsWidth={workspaceLayout.agentSessionsWidth}
              agentSessionsCollapsed={workspaceLayout.agentSessionsCollapsed}
              agentSessionsCollapsedWidth={CHAT_WORKSPACE_LAYOUT.agentSessionsCollapsedWidth}
              onToggleAgentSessionsCollapse={() => setAgentSessionsCollapsed((prev) => !prev)}
            />
          ) : (
            <div className="h-full overflow-auto bg-card px-5 py-4 md:px-8 md:py-6">
              <Outlet />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
