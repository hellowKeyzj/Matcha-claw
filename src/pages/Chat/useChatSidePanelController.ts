import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useGatewayStore } from '@/stores/gateway';
import { useLayoutStore } from '@/stores/layout';
import { useChatStore } from '@/stores/chat';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { useTaskSnapshotStore } from '@/stores/chat/task-snapshot-store';
import { isGatewayOperational } from '@/lib/gateway-status';
import { filterUnfinishedTasks } from '@/lib/task-domain';
import {
  clampChatSidePanelWidth,
  getDefaultChatSidePanelWidth,
  resolveChatSidePanelLayout,
  type ChatSidePanelWidthPolicy,
  type ChatSidePanelMode,
} from './chat-workspace-layout';

export type ChatSidePanelTab = 'tasks' | 'skills' | 'artifacts';

const TASK_INBOX_POLL_FAST_MS = 5_000;
const TASK_INBOX_POLL_NORMAL_MS = 15_000;
const TASK_INBOX_POLL_BACKGROUND_MS = 60_000;

interface ChatSidePanelState {
  open: boolean;
  activeTab: ChatSidePanelTab;
  lightWidth: number;
  artifactWidth: number;
}

function resolveSidePanelWidthPolicy(tab: ChatSidePanelTab): ChatSidePanelWidthPolicy {
  return tab === 'artifacts' ? 'artifacts' : 'light';
}

function readStoredPanelState(): ChatSidePanelState {
  try {
    const open = window.localStorage.getItem('chat:side-panel-open') === '1';
    const storedTab = window.localStorage.getItem('chat:side-panel-tab');
    const storedLightWidth = Number(window.localStorage.getItem('chat:side-panel-light-width'));
    const storedArtifactWidth = Number(window.localStorage.getItem('chat:side-panel-artifact-width'));
    return {
      open,
      activeTab: storedTab === 'skills' || storedTab === 'artifacts' ? storedTab : 'tasks',
      lightWidth: Number.isFinite(storedLightWidth) && storedLightWidth > 0
        ? storedLightWidth
        : getDefaultChatSidePanelWidth('light'),
      artifactWidth: Number.isFinite(storedArtifactWidth) && storedArtifactWidth > 0
        ? storedArtifactWidth
        : getDefaultChatSidePanelWidth('artifacts'),
    };
  } catch {
    return {
      open: false,
      activeTab: 'tasks',
      lightWidth: getDefaultChatSidePanelWidth('light'),
      artifactWidth: getDefaultChatSidePanelWidth('artifacts'),
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
  const chatTakeoverMode = useLayoutStore((state) => state.chatTakeoverMode);
  const setChatTakeoverMode = useLayoutStore((state) => state.setChatTakeoverMode);
  const clearChatTakeoverMode = useLayoutStore((state) => state.clearChatTakeoverMode);
  const currentSessionKey = useChatStore((state) => state.currentSessionKey);
  const tasks = useTaskSnapshotStore((state) => state.getPersistentTaskDataList(currentSessionKey));
  const derivedPlanStatus = useTaskSnapshotStore((state) => state.getDerivedPlanStatus(currentSessionKey));
  const initialized = useTaskCenterStore((state) => state.initialized);
  const init = useTaskCenterStore((state) => state.init);
  const refreshTasks = useTaskCenterStore((state) => state.refreshTasks);
  const resizeRafRef = useRef<number | null>(null);
  const [panelState, setPanelState] = useState<ChatSidePanelState>(() => readStoredPanelState());
  const [containerWidth, setContainerWidth] = useState<number>(() => (
    typeof window === 'undefined' ? 0 : readContainerWidth(chatLayoutRef)
  ));
  const isGatewayRunning = isGatewayOperational(gatewayStatus);
  const unfinishedTaskCount = useMemo(() => filterUnfinishedTasks(tasks).length, [tasks]);
  const hasActiveTasks = useMemo(
    () => tasks.some((task) => task.status === 'pending' || task.status === 'in_progress'),
    [tasks],
  );
  const activeWidthPolicy = resolveSidePanelWidthPolicy(panelState.activeTab);
  const activeStoredWidth = activeWidthPolicy === 'artifacts'
    ? panelState.artifactWidth
    : panelState.lightWidth;
  const artifactWorkbenchFullscreen = (
    panelState.open
    && panelState.activeTab === 'artifacts'
    && chatTakeoverMode === 'artifact-workbench'
  );
  const layout = useMemo(
    () => resolveChatSidePanelLayout(panelState.open, containerWidth, activeStoredWidth, activeWidthPolicy),
    [activeStoredWidth, activeWidthPolicy, containerWidth, panelState.open],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem('chat:side-panel-open', panelState.open ? '1' : '0');
      window.localStorage.setItem('chat:side-panel-tab', panelState.activeTab);
      window.localStorage.setItem('chat:side-panel-light-width', String(panelState.lightWidth));
      window.localStorage.setItem('chat:side-panel-artifact-width', String(panelState.artifactWidth));
    } catch {
      // ignore localStorage errors
    }
  }, [panelState.activeTab, panelState.artifactWidth, panelState.lightWidth, panelState.open]);

  useEffect(() => {
    return () => {
      clearChatTakeoverMode();
    };
  }, [clearChatTakeoverMode]);

  useEffect(() => {
    if (!panelState.open || panelState.activeTab !== 'artifacts') {
      clearChatTakeoverMode();
    }
  }, [clearChatTakeoverMode, panelState.activeTab, panelState.open]);

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
      void init(currentSessionKey);
      return;
    }
    void refreshTasks({ sessionKey: currentSessionKey });
  }, [currentSessionKey, enabled, init, initialized, isGatewayRunning, refreshTasks]);

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
          void refreshTasks({ sessionKey: currentSessionKey }).finally(() => {
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
        void refreshTasks({ sessionKey: currentSessionKey }).finally(() => {
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
  }, [currentSessionKey, enabled, hasActiveTasks, initialized, isGatewayRunning, refreshTasks]);

  const toggleSidePanel = useCallback(() => {
    setPanelState((prev) => ({
      ...prev,
      open: !prev.open,
    }));
    clearChatTakeoverMode();
  }, [clearChatTakeoverMode]);

  const setActiveSidePanelTab = useCallback((tab: ChatSidePanelTab) => {
    setPanelState((prev) => {
      if (prev.open && prev.activeTab === tab) {
        return prev;
      }
      return {
        ...prev,
        open: true,
        activeTab: tab,
      };
    });
    if (tab !== 'artifacts') {
      clearChatTakeoverMode();
    }
  }, [clearChatTakeoverMode]);

  const closeSidePanel = useCallback(() => {
    setPanelState((prev) => ({
      ...prev,
      open: false,
    }));
    clearChatTakeoverMode();
  }, [clearChatTakeoverMode]);

  const setSidePanelWidth = useCallback((nextWidth: number) => {
    setPanelState((prev) => {
      const nextPolicy = resolveSidePanelWidthPolicy(prev.activeTab);
      const clamped = clampChatSidePanelWidth(nextWidth, readContainerWidth(chatLayoutRef), nextPolicy);
      if (nextPolicy === 'artifacts') {
        if (prev.artifactWidth === clamped) {
          return prev;
        }
        return {
          ...prev,
          artifactWidth: clamped,
        };
      }
      if (prev.lightWidth === clamped) {
        return prev;
      }
      return {
        ...prev,
        lightWidth: clamped,
      };
    });
  }, [chatLayoutRef]);

  const toggleArtifactWorkbenchFullscreen = useCallback(() => {
    setPanelState((prev) => {
      if (prev.activeTab !== 'artifacts') {
        return prev;
      }
      return {
        ...prev,
        open: true,
      };
    });
    setChatTakeoverMode(chatTakeoverMode === 'artifact-workbench' ? 'none' : 'artifact-workbench');
  }, [chatTakeoverMode, setChatTakeoverMode]);

  return {
    sidePanelOpen: layout.sidePanelOpen,
    sidePanelMode: layout.sidePanelMode as ChatSidePanelMode,
    sidePanelWidth: artifactWorkbenchFullscreen ? containerWidth : layout.sidePanelWidth,
    activeSidePanelTab: panelState.activeTab,
    artifactWorkbenchFullscreen,
    unfinishedTaskCount,
    derivedPlanStatus,
    toggleSidePanel,
    setActiveSidePanelTab,
    closeSidePanel,
    setSidePanelWidth,
    toggleArtifactWorkbenchFullscreen,
  };
}
