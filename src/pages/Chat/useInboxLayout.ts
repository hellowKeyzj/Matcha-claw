import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react';
import {
  CHAT_WORKSPACE_LAYOUT,
  clampPaneWidth,
  canExpandTaskInbox,
  getTaskInboxResizeMaxWidth,
  resolveTaskInboxLayout,
} from './chat-workspace-layout';

function loadTaskInboxWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem('chat:task-inbox-width') || CHAT_WORKSPACE_LAYOUT.taskInboxDefaultWidth);
    if (!Number.isFinite(raw)) {
      return CHAT_WORKSPACE_LAYOUT.taskInboxDefaultWidth;
    }
    return clampPaneWidth(
      raw,
      CHAT_WORKSPACE_LAYOUT.taskInboxMinWidth,
      CHAT_WORKSPACE_LAYOUT.taskInboxMaxWidth,
    );
  } catch {
    return CHAT_WORKSPACE_LAYOUT.taskInboxDefaultWidth;
  }
}

function readContainerWidth(chatLayoutRef: React.RefObject<HTMLDivElement | null>): number {
  return chatLayoutRef.current?.clientWidth ?? window.innerWidth;
}

export function useInboxLayout(
  enabled: boolean,
  chatLayoutRef: React.RefObject<HTMLDivElement | null>,
) {
  const resizeRafRef = useRef<number | null>(null);
  const [taskInboxUserCollapsed, setTaskInboxUserCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('chat:task-inbox-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const [taskInboxPreferredWidth, setTaskInboxPreferredWidth] = useState<number>(() => loadTaskInboxWidth());
  const [containerWidth, setContainerWidth] = useState<number>(() => window.innerWidth);

  const layout = useMemo(
    () => resolveTaskInboxLayout(taskInboxUserCollapsed, taskInboxPreferredWidth, containerWidth),
    [containerWidth, taskInboxPreferredWidth, taskInboxUserCollapsed],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem('chat:task-inbox-collapsed', taskInboxUserCollapsed ? '1' : '0');
    } catch {
      // ignore localStorage errors
    }
  }, [taskInboxUserCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem('chat:task-inbox-width', String(taskInboxPreferredWidth));
    } catch {
      // ignore localStorage errors
    }
  }, [taskInboxPreferredWidth]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const applyResize = () => {
      const nextContainerWidth = readContainerWidth(chatLayoutRef);
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
  }, [chatLayoutRef, enabled]);

  const setTaskInboxCollapsed = useCallback((next: SetStateAction<boolean>) => {
    const desiredCollapsed = typeof next === 'function'
      ? next(layout.taskInboxCollapsed)
      : next;
    setTaskInboxUserCollapsed(desiredCollapsed);
    if (!desiredCollapsed && canExpandTaskInbox(containerWidth)) {
      setTaskInboxPreferredWidth((prev) => clampPaneWidth(
        prev,
        CHAT_WORKSPACE_LAYOUT.taskInboxMinWidth,
        getTaskInboxResizeMaxWidth(containerWidth),
      ));
    }
  }, [containerWidth, layout.taskInboxCollapsed]);

  const startTaskInboxResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (layout.taskInboxCollapsed) {
      return;
    }
    event.preventDefault();

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = chatLayoutRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const rawWidth = rect.right - moveEvent.clientX - CHAT_WORKSPACE_LAYOUT.paneResizerWidth;
      const nextWidth = clampPaneWidth(
        rawWidth,
        CHAT_WORKSPACE_LAYOUT.taskInboxMinWidth,
        getTaskInboxResizeMaxWidth(rect.width),
      );
      setTaskInboxPreferredWidth(nextWidth);
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

  return {
    taskInboxCollapsed: layout.taskInboxCollapsed,
    setTaskInboxCollapsed,
    taskInboxWidth: layout.taskInboxWidth,
    startTaskInboxResize,
    taskInboxResizerWidth: CHAT_WORKSPACE_LAYOUT.paneResizerWidth,
  };
}
