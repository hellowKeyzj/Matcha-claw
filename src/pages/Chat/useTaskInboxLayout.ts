import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

const TASK_INBOX_MIN_WIDTH = 260;
const TASK_INBOX_MAX_WIDTH = 560;
const TASK_INBOX_DEFAULT_WIDTH = 360;
const TASK_INBOX_RESIZER_WIDTH = 6;
const CHAT_MAIN_MIN_WIDTH = 520;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadTaskInboxWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem('chat:task-inbox-width') || TASK_INBOX_DEFAULT_WIDTH);
    if (!Number.isFinite(raw)) {
      return TASK_INBOX_DEFAULT_WIDTH;
    }
    return clamp(raw, TASK_INBOX_MIN_WIDTH, TASK_INBOX_MAX_WIDTH);
  } catch {
    return TASK_INBOX_DEFAULT_WIDTH;
  }
}

function clampTaskInboxWidth(width: number, containerWidth: number): number {
  const maxWidth = Math.max(
    TASK_INBOX_MIN_WIDTH,
    containerWidth - CHAT_MAIN_MIN_WIDTH - TASK_INBOX_RESIZER_WIDTH,
  );
  return clamp(width, TASK_INBOX_MIN_WIDTH, Math.min(TASK_INBOX_MAX_WIDTH, maxWidth));
}

export function useTaskInboxLayout(
  chatLayoutRef: React.RefObject<HTMLDivElement | null>,
) {
  const resizeRafRef = useRef<number | null>(null);
  const [taskInboxCollapsed, setTaskInboxCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('chat:task-inbox-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const [taskInboxWidth, setTaskInboxWidth] = useState<number>(() => loadTaskInboxWidth());

  useEffect(() => {
    try {
      window.localStorage.setItem('chat:task-inbox-collapsed', taskInboxCollapsed ? '1' : '0');
    } catch {
      // ignore localStorage errors
    }
  }, [taskInboxCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem('chat:task-inbox-width', String(taskInboxWidth));
    } catch {
      // ignore localStorage errors
    }
  }, [taskInboxWidth]);

  useEffect(() => {
    const applyResize = () => {
      const containerWidth = chatLayoutRef.current?.clientWidth ?? window.innerWidth;
      setTaskInboxWidth((prev) => {
        const next = clampTaskInboxWidth(prev, containerWidth);
        return next === prev ? prev : next;
      });
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
  }, [chatLayoutRef]);

  const startTaskInboxResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (taskInboxCollapsed) {
      return;
    }
    event.preventDefault();

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = chatLayoutRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const rawWidth = rect.right - moveEvent.clientX - TASK_INBOX_RESIZER_WIDTH;
      const next = clampTaskInboxWidth(rawWidth, rect.width);
      setTaskInboxWidth(next);
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
    taskInboxCollapsed,
    setTaskInboxCollapsed,
    taskInboxWidth,
    startTaskInboxResize,
    taskInboxResizerWidth: TASK_INBOX_RESIZER_WIDTH,
  };
}
