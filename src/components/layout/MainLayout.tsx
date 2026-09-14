/**
 * Main Layout Component
 * TitleBar at top, then layout panes below.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { ChatWorkspaceHost } from './ChatWorkspaceHost';
import { TitleBar } from './TitleBar';
import { VerticalPaneResizer } from './VerticalPaneResizer';
import {
  CHAT_WORKSPACE_LAYOUT,
  resolveChatWorkspaceLayout,
} from '@/pages/Chat/chat-workspace-layout';
import { invokeIpc } from '@/lib/api-client';
import { useLayoutStore } from '@/stores/layout';

export function MainLayout() {
  const location = useLocation();
  const sidebarVisible = useLayoutStore((state) => state.sidebarVisible);
  const sidebarWidth = useLayoutStore((state) => state.sidebarWidth);
  const setSidebarWidth = useLayoutStore((state) => state.setSidebarWidth);
  const chatTakeoverMode = useLayoutStore((state) => state.chatTakeoverMode);
  const chatWindowRightDockLayout = useLayoutStore((state) => state.chatWindowRightDockLayout);
  const clearChatTakeoverMode = useLayoutStore((state) => state.clearChatTakeoverMode);
  const [containerWidth, setContainerWidth] = useState<number>(() => window.innerWidth);
  const layoutRef = useRef<HTMLDivElement>(null);
  const resizeRafRef = useRef<number | null>(null);
  const isChatRoute = location.pathname === '/';
  const chatTakeoverActive = isChatRoute && chatTakeoverMode !== 'none';
  const activeRightDockLayout = isChatRoute ? chatWindowRightDockLayout : null;

  const layoutContainerWidth = useMemo(() => {
    const dockLayout = activeRightDockLayout;
    if (!dockLayout || dockLayout.dockWidth <= 0) {
      return containerWidth;
    }
    return dockLayout.baseWidth;
  }, [activeRightDockLayout, containerWidth]);

  const workspaceLayout = useMemo(() => resolveChatWorkspaceLayout({
    containerWidth: layoutContainerWidth,
    sidebarVisible,
    sidebarWidth,
  }), [
    layoutContainerWidth,
    sidebarVisible,
    sidebarWidth,
  ]);

  const chatMainFlexWidth = useMemo(() => {
    if (!activeRightDockLayout || activeRightDockLayout.dockWidth <= 0) {
      return null;
    }
    const dockWidth = activeRightDockLayout.phase === 'opening' || activeRightDockLayout.phase === 'open' || activeRightDockLayout.phase === 'closing'
      ? activeRightDockLayout.dockWidth
      : 0;
    const leftOccupiedWidth = chatTakeoverActive ? 0 : workspaceLayout.sidebarOccupiedWidth;
    return Math.max(1, layoutContainerWidth - leftOccupiedWidth + dockWidth);
  }, [activeRightDockLayout, chatTakeoverActive, layoutContainerWidth, workspaceLayout.sidebarOccupiedWidth]);
  const mainStyle = chatMainFlexWidth == null
    ? undefined
    : { flex: `0 0 ${chatMainFlexWidth}px` };

  useEffect(() => {
    if (isChatRoute) {
      return;
    }
    clearChatTakeoverMode();
  }, [clearChatTakeoverMode, isChatRoute]);

  useEffect(() => {
    if (window.electron?.platform !== 'darwin') {
      return;
    }
    void invokeIpc('window:syncTrafficLightPosition', !sidebarVisible);
  }, [sidebarVisible]);

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
      setSidebarWidth(moveEvent.clientX - rect.left, layoutContainerWidth);
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
    <div className="app-shell-bg flex h-screen flex-col overflow-hidden bg-card">
      <TitleBar />

      <div
        ref={layoutRef}
        className="relative flex flex-1 overflow-hidden bg-card"
      >
        {!chatTakeoverActive ? (
          <Sidebar
            width={workspaceLayout.sidebarWidth}
            railWidth={CHAT_WORKSPACE_LAYOUT.sidebarRailWidth}
            containerWidth={layoutContainerWidth}
            showRightDivider={!sidebarVisible}
          />
        ) : null}
        {!chatTakeoverActive && sidebarVisible ? (
          <VerticalPaneResizer
            testId="layout-left-resizer"
            onMouseDown={startSidebarResize}
            ariaLabel="Resize sidebar"
            variant="subtle-border"
          />
        ) : null}
        <main className="min-w-0 flex-1 overflow-hidden bg-card" style={mainStyle}>
          {isChatRoute ? (
            <ChatWorkspaceHost takeoverMode={chatTakeoverMode} />
          ) : (
            <div data-page-scroll className="h-full overflow-auto bg-card px-5 py-4 md:px-8 md:py-6">
              <Outlet />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
