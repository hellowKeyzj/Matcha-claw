import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useGatewayStore } from '@/stores/gateway';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import { resolveChatSidePanelLayout, type ChatSidePanelMode } from './chat-workspace-layout';

export type ChatSidePanelTab = 'tasks' | 'skills';

const TASK_INBOX_POLL_FAST_MS = 5_000;
const TASK_INBOX_POLL_NORMAL_MS = 15_000;
const TASK_INBOX_POLL_BACKGROUND_MS = 60_000;

interface ChatSidePanelState {
  open: boolean;
  activeTab: ChatSidePanelTab;
}

function readStoredPanelState(): ChatSidePanelState {
  try {
    const open = window.localStorage.getItem('chat:side-panel-open') === '1';
    const storedTab = window.localStorage.getItem('chat:side-panel-tab');
    return {
      open,
      activeTab: storedTab === 'skills' ? 'skills' : 'tasks',
    };
  } catch {
    return {
      open: false,
      activeTab: 'tasks',
    };
  }
}

function readContainerWidth(chatLayoutRef: RefObject<HTMLDivElement | null>): number {
  return chatLayoutRef.current?.clientWidth ?? window.innerWidth;
}

export function useChatSidePanelController(
  enabled: boolean,
  chatLayoutRef: RefObject<HTMLDivElement | null>,
) {
  const gatewayStatus = useGatewayStore((state) => state.status);
  const tasks = useTaskInboxStore((state) => state.tasks);
  const initialized = useTaskInboxStore((state) => state.initialized);
  const init = useTaskInboxStore((state) => state.init);
  const refreshTasks = useTaskInboxStore((state) => state.refreshTasks);
  const resizeRafRef = useRef<number | null>(null);
  const [panelState, setPanelState] = useState<ChatSidePanelState>(() => readStoredPanelState());
  const [containerWidth, setContainerWidth] = useState<number>(() => (
    typeof window === 'undefined' ? 0 : window.innerWidth
  ));
  const isGatewayRunning = gatewayStatus.state === 'running';
  const unfinishedTaskCount = tasks.length;
  const hasActiveTasks = useMemo(
    () => tasks.some((task) => task.status === 'pending' || task.status === 'in_progress'),
    [tasks],
  );
  const layout = useMemo(
    () => resolveChatSidePanelLayout(panelState.open, containerWidth),
    [containerWidth, panelState.open],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem('chat:side-panel-open', panelState.open ? '1' : '0');
      window.localStorage.setItem('chat:side-panel-tab', panelState.activeTab);
    } catch {
      // ignore localStorage errors
    }
  }, [panelState.activeTab, panelState.open]);

  useEffect(() => {
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

    const layoutNode = chatLayoutRef.current;
    const observer = typeof ResizeObserver === 'function' && layoutNode
      ? new ResizeObserver(() => {
        scheduleResize();
      })
      : null;
    if (observer && layoutNode) {
      observer.observe(layoutNode);
    }

    window.addEventListener('resize', scheduleResize);
    return () => {
      window.removeEventListener('resize', scheduleResize);
      observer?.disconnect();
      if (resizeRafRef.current != null) {
        window.cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, [chatLayoutRef]);

  useEffect(() => {
    if (!enabled || !isGatewayRunning) {
      return;
    }
    if (!initialized) {
      void init();
      return;
    }
    void refreshTasks();
  }, [enabled, init, initialized, isGatewayRunning, refreshTasks]);

  useEffect(() => {
    if (!enabled || !isGatewayRunning || !initialized) {
      return;
    }

    let timer: number | undefined;
    let disposed = false;

    const clearTimer = () => {
      if (typeof timer === 'number') {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };

    const resolveDelay = () => {
      if (document.visibilityState !== 'visible') {
        return TASK_INBOX_POLL_BACKGROUND_MS;
      }
      return hasActiveTasks ? TASK_INBOX_POLL_FAST_MS : TASK_INBOX_POLL_NORMAL_MS;
    };

    const scheduleNext = () => {
      if (disposed) {
        return;
      }
      clearTimer();
      timer = window.setTimeout(() => {
        void refreshTasks().finally(() => {
          scheduleNext();
        });
      }, resolveDelay());
    };

    const handleVisibilityChange = () => {
      if (disposed) {
        return;
      }
      clearTimer();
      if (document.visibilityState === 'visible') {
        void refreshTasks().finally(() => {
          scheduleNext();
        });
        return;
      }
      scheduleNext();
    };

    scheduleNext();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      clearTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, hasActiveTasks, initialized, isGatewayRunning, refreshTasks]);

  const toggleSidePanel = useCallback(() => {
    setPanelState((prev) => ({
      ...prev,
      open: !prev.open,
    }));
  }, []);

  const setActiveSidePanelTab = useCallback((tab: ChatSidePanelTab) => {
    setPanelState((prev) => ({
      open: true,
      activeTab: tab,
      ...(prev.open && prev.activeTab === tab ? prev : {}),
    }));
  }, []);

  const closeSidePanel = useCallback(() => {
    setPanelState((prev) => ({ ...prev, open: false }));
  }, []);

  return {
    sidePanelOpen: layout.sidePanelOpen,
    sidePanelMode: layout.sidePanelMode as ChatSidePanelMode,
    sidePanelWidth: layout.sidePanelWidth,
    activeSidePanelTab: panelState.activeTab,
    unfinishedTaskCount,
    toggleSidePanel,
    setActiveSidePanelTab,
    closeSidePanel,
  };
}
