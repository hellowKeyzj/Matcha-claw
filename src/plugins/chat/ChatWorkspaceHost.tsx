import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentSessionsPane } from '@/plugins/chat/AgentSessionsPane';
import { Chat } from '@/plugins/chat';
import { useChatStore } from '@/plugins/chat/store';
import { isChatRuntimePreparing, useChatRuntime } from '@/plugins/chat/chat-session';
import { useLayoutStore } from '@/app/layout/store';
import { CHAT_WORKSPACE_LAYOUT, NAVIGATION_RAIL_WIDTH, getSidebarResizeMaxWidth, resolveChatWorkspaceLayout } from '@/app/layout/workspace';
import { isTraceEnabled } from '@/lib/trace-logger';

interface ChatWorkspaceHostProps {
  takeoverMode: 'none' | 'workspace';
}

const STARTUP_TRACE_PREFIX = '[startup-trace]';

export function ChatWorkspaceHost({
  takeoverMode,
}: ChatWorkspaceHostProps) {
  const { t } = useTranslation();
  const workspaceFullscreen = takeoverMode === 'workspace';
  const sidebarVisible = useLayoutStore((state) => state.sidebarVisible);
  const sidebarWidth = useLayoutStore((state) => state.sidebarWidth);
  const setSidebarWidth = useLayoutStore((state) => state.setSidebarWidth);
  const rightDockLayout = useLayoutStore((state) => state.viewportRightDockLayout);
  const hostRef = useRef<HTMLDivElement>(null);
  const resizeGestureRef = useRef<{ pointerId: number; element: HTMLDivElement; offset: number; cursor: string; userSelect: string } | null>(null);
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth - NAVIGATION_RAIL_WIDTH);
  // Dock expansion belongs to the right panel, not to the sessions column's resize budget.
  const layoutContainerWidth = rightDockLayout && rightDockLayout.dockWidth > 0
    ? rightDockLayout.baseWidth - (workspaceFullscreen ? 0 : NAVIGATION_RAIL_WIDTH)
    : containerWidth;
  const { runtime, directory } = useChatRuntime();
  const preparing = useChatStore((state) => isChatRuntimePreparing(state, runtime, directory.status));
  const sessionsEnabled = sidebarVisible && !workspaceFullscreen;
  const sessionsVisible = sessionsEnabled && !preparing;
  const workspaceLayout = resolveChatWorkspaceLayout({
    containerWidth: layoutContainerWidth,
    sidebarVisible: sessionsVisible,
    sidebarWidth,
  });

  useLayoutEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const applyResize = () => setContainerWidth(node.clientWidth);
    applyResize();
    const observer = new ResizeObserver(applyResize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const finishSessionsResize = useCallback(() => {
    const gesture = resizeGestureRef.current;
    if (!gesture) return;
    resizeGestureRef.current = null;
    if (gesture.element.hasPointerCapture(gesture.pointerId)) gesture.element.releasePointerCapture(gesture.pointerId);
    document.body.style.cursor = gesture.cursor;
    document.body.style.userSelect = gesture.userSelect;
  }, []);

  useEffect(() => {
    window.addEventListener('blur', finishSessionsResize);
    return () => {
      window.removeEventListener('blur', finishSessionsResize);
      finishSessionsResize();
    };
  }, [finishSessionsResize, sessionsVisible]);

  const startSessionsResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || resizeGestureRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeGestureRef.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      offset: event.clientX - event.currentTarget.getBoundingClientRect().left,
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const moveSessionsResize = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = resizeGestureRef.current;
    if (gesture?.pointerId !== event.pointerId) return;
    if (!(event.buttons & 1)) {
      finishSessionsResize();
      return;
    }
    const rect = hostRef.current?.getBoundingClientRect();
    if (rect) setSidebarWidth(event.clientX - rect.left - gesture.offset, layoutContainerWidth);
  };

  useEffect(() => {
    if (!isTraceEnabled()) return;
    console.info(JSON.stringify({
      prefix: STARTUP_TRACE_PREFIX,
      traceScope: 'renderer-boundary',
      source: 'chat-workspace-host',
      phase: 'mounted',
      at: Date.now(),
      takeoverMode,
    }));
  }, [takeoverMode]);

  return (
    <div
      ref={hostRef}
      data-testid="chat-workspace-host"
      data-takeover-mode={takeoverMode}
      className="flex h-full min-w-0 overflow-hidden bg-card"
    >
      <div
        id="chat-sessions-column"
        hidden={!sessionsVisible}
        className="h-full min-w-0 shrink-0 overflow-hidden bg-[hsl(var(--shell-surface-muted))]"
        style={{ width: workspaceLayout.sidebarWidth }}
      >
        {sessionsEnabled ? <AgentSessionsPane /> : null}
      </div>
      {sessionsVisible ? (
        <div
          role="separator"
          tabIndex={0}
          aria-label={t('common:sidebar.resizeSessions')}
          aria-orientation="vertical"
          aria-controls="chat-sessions-column"
          aria-valuemin={CHAT_WORKSPACE_LAYOUT.sidebarMinWidth}
          aria-valuemax={getSidebarResizeMaxWidth(layoutContainerWidth)}
          aria-valuenow={workspaceLayout.sidebarWidth}
          data-testid="chat-sessions-resizer"
          className="group relative w-1.5 shrink-0 touch-none cursor-col-resize bg-[hsl(var(--shell-surface-muted))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onPointerDown={startSessionsResize}
          onPointerMove={moveSessionsResize}
          onPointerUp={finishSessionsResize}
          onPointerCancel={finishSessionsResize}
          onLostPointerCapture={finishSessionsResize}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const nextWidth = event.key === 'Home' ? CHAT_WORKSPACE_LAYOUT.sidebarMinWidth
              : event.key === 'End' ? getSidebarResizeMaxWidth(layoutContainerWidth)
              : workspaceLayout.sidebarWidth + (event.key === 'ArrowLeft' ? -16 : 16);
            setSidebarWidth(nextWidth, layoutContainerWidth);
          }}
        >
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-px bg-[var(--divider-line)] transition-colors group-hover:bg-[var(--divider-line-hover)]" />
        </div>
      ) : null}
      <div className="min-w-0 flex-1 overflow-hidden bg-card">
        <Chat />
      </div>
    </div>
  );
}
