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
import { resolveChatWorkspaceLayout } from './chat-workspace-layout';
import { invokeIpc } from '@/lib/api-client';
import { StableScrollArea } from '@/components/scroll';
import { useLayoutStore } from '@/stores/layout';

type PageViewportMode = 'document' | 'workspace';

const WORKSPACE_PAGE_PATH_PREFIXES = ['/wiki'] as const;

const PAGE_VIEWPORT_CLASS_NAME: Record<PageViewportMode, string> = {
  document: 'h-full overflow-auto overscroll-contain bg-[hsl(var(--shell-surface))] px-5 py-4 [scrollbar-gutter:stable] md:px-8 md:py-6',
  workspace: 'h-full overflow-auto overscroll-contain bg-[hsl(var(--shell-surface))] [scrollbar-gutter:stable]',
};

function resolvePageViewportMode(pathname: string): PageViewportMode {
  return WORKSPACE_PAGE_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
    ? 'workspace'
    : 'document';
}

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
  const pageViewportMode = resolvePageViewportMode(location.pathname);
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
    <div className="flex h-screen flex-col overflow-hidden bg-[hsl(var(--shell-window))]">
      <TitleBar />

      <div
        ref={layoutRef}
        className="relative flex flex-1 overflow-hidden bg-[hsl(var(--shell-surface))]"
      >
        {!chatTakeoverActive && sidebarVisible ? (
          <Sidebar
            width={workspaceLayout.sidebarWidth}
            showRightDivider={false}
          />
        ) : null}
        {!chatTakeoverActive && !sidebarVisible ? (
          <div className="group/sidebar-peek absolute inset-y-0 left-0 z-30 w-3">
            <div className="absolute inset-y-0 left-0 w-3" />
            <div className="absolute inset-y-0 left-0 -translate-x-full transform-gpu shadow-[var(--shell-shadow-overlay)] transition-transform duration-200 ease-out will-change-transform group-hover/sidebar-peek:translate-x-0 motion-reduce:transition-none">
              <Sidebar
                width={sidebarWidth}
                overlay
                showRightDivider
              />
            </div>
          </div>
        ) : null}
        {!chatTakeoverActive && sidebarVisible ? (
          <VerticalPaneResizer
            testId="layout-left-resizer"
            onMouseDown={startSidebarResize}
            ariaLabel="Resize sidebar"
            variant="subtle-border"
          />
        ) : null}
        <main className="min-w-0 flex-1 overflow-hidden bg-[hsl(var(--shell-surface))]" style={mainStyle}>
          {isChatRoute ? (
            <ChatWorkspaceHost takeoverMode={chatTakeoverMode} />
          ) : (
            <StableScrollArea
              data-page-scroll
              className={PAGE_VIEWPORT_CLASS_NAME[pageViewportMode]}
            >
              <Outlet />
            </StableScrollArea>
          )}
        </main>
      </div>
    </div>
  );
}
