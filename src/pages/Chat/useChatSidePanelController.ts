import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useGatewayStore } from '@/stores/gateway';
import { useLayoutStore } from '@/stores/layout';
import { useChatStore } from '@/stores/chat';
import { useTaskSnapshotStore } from '@/stores/chat/task-snapshot-store';
import { readSessionsFromState } from '@/stores/chat/session-helpers';
import { listTaskSnapshot, type Task, type TaskListSnapshot } from '@/services/openclaw/task-manager-client';
import { isGatewayOperational } from '@/lib/gateway-status';
import { filterUnfinishedTasks } from '@/lib/task-domain';
import {
  clampChatSidePanelWidth,
  getDefaultChatSidePanelWidth,
  resolveChatSidePanelLayout,
  type ChatSidePanelWidthPolicy,
  type ChatSidePanelMode,
} from './chat-workspace-layout';

export type ChatSidePanelTab = 'tasks' | 'artifacts' | 'runtime';
export type TaskInboxTask = Task & { sourceSessionKey: string; scopeKey: string };

export const CHAT_RUNTIME_SURFACE_OPEN_EVENT = 'chat:open-runtime-surface';

export type ChatRuntimeSurfaceDescriptor =
  | {
    readonly kind: 'browser-tab';
    readonly targetId: string;
    readonly profile: string;
    readonly target: 'host' | 'node';
    readonly node?: string;
    readonly title?: string;
    readonly url?: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
  }
  | {
    readonly kind: 'mcp-app';
    readonly title?: string;
    readonly url?: string;
    readonly viewId?: string;
    readonly surface?: 'assistant_message' | 'node_panel';
    readonly preferredHeight?: number;
    readonly sandbox?: 'strict' | 'scripts';
    readonly boardWidgetName?: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
    readonly mcpApp?: {
      readonly viewId: string;
      readonly serverName?: string;
      readonly toolName?: string;
      readonly uiResourceUri?: string;
      readonly toolCallId?: string;
      readonly originSessionKey?: string;
      readonly resultMetaState?: 'unavailable';
    };
  };

let chatRuntimeSurfaceSnapshot: ChatRuntimeSurfaceDescriptor | null = null;
const chatRuntimeSurfaceListeners = new Set<() => void>();

export function getChatRuntimeSurfaceSnapshot(): ChatRuntimeSurfaceDescriptor | null {
  return chatRuntimeSurfaceSnapshot;
}

export function subscribeChatRuntimeSurface(listener: () => void): () => void {
  chatRuntimeSurfaceListeners.add(listener);
  return () => {
    chatRuntimeSurfaceListeners.delete(listener);
  };
}

export function openChatRuntimeSurface(surface: ChatRuntimeSurfaceDescriptor): void {
  window.dispatchEvent(new CustomEvent<ChatRuntimeSurfaceDescriptor>(CHAT_RUNTIME_SURFACE_OPEN_EVENT, { detail: surface }));
}

function publishChatRuntimeSurface(surface: ChatRuntimeSurfaceDescriptor): void {
  chatRuntimeSurfaceSnapshot = surface;
  for (const listener of chatRuntimeSurfaceListeners) {
    listener();
  }
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0))).sort((left, right) => left.localeCompare(right));
}

function taskInboxKey(task: TaskInboxTask): string {
  return `${task.sourceSessionKey}:${task.id}`;
}

function sortTaskInboxTasks(tasks: TaskInboxTask[]): TaskInboxTask[] {
  return [...tasks].sort((left, right) => {
    const leftUpdatedAt = Number.isFinite(left.updatedAt) ? left.updatedAt : 0;
    const rightUpdatedAt = Number.isFinite(right.updatedAt) ? right.updatedAt : 0;
    if (leftUpdatedAt !== rightUpdatedAt) {
      return rightUpdatedAt - leftUpdatedAt;
    }
    return taskInboxKey(left).localeCompare(taskInboxKey(right));
  });
}

function getSnapshotSessionKey(sessionKey: string, snapshot: TaskListSnapshot): string {
  return snapshot.scope?.sessionKey ?? sessionKey;
}

interface ChatSidePanelState {
  open: boolean;
  activeTab: ChatSidePanelTab;
  lightWidth: number;
  artifactWidth: number;
}

function isStoredSidePanelTab(value: string | null): value is ChatSidePanelTab {
  return value === 'tasks' || value === 'artifacts' || value === 'runtime';
}

function resolveSidePanelWidthPolicy(tab: ChatSidePanelTab): ChatSidePanelWidthPolicy {
  return tab === 'artifacts' ? 'artifacts' : 'light';
}

function readStoredPanelState(): ChatSidePanelState {
  try {
    const storedTab = window.localStorage.getItem('chat:side-panel-tab');
    const storedLightWidth = Number(window.localStorage.getItem('chat:side-panel-light-width'));
    const storedArtifactWidth = Number(window.localStorage.getItem('chat:side-panel-artifact-width'));
    return {
      open: false,
      activeTab: isStoredSidePanelTab(storedTab) ? storedTab : 'tasks',
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
  const sessions = useChatStore((state) => readSessionsFromState(state));
  const sessionsLoadedOnce = useChatStore((state) => state.sessionCatalogStatus.hasLoadedOnce);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const taskSnapshots = useTaskSnapshotStore((state) => state.snapshots);
  const getSessionTaskScopeKey = useTaskSnapshotStore((state) => state.getSessionTaskScopeKey);
  const taskScopeKey = useTaskSnapshotStore((state) => state.getSessionTaskScopeKey(currentSessionKey ?? ''));
  const derivedPlanStatus = useTaskSnapshotStore((state) => state.getDerivedPlanStatus(taskScopeKey));
  const resizeRafRef = useRef<number | null>(null);
  const taskInboxRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const [taskInboxLoading, setTaskInboxLoading] = useState(false);
  const [taskInboxError, setTaskInboxError] = useState<string | null>(null);
  const [panelState, setPanelState] = useState<ChatSidePanelState>(() => readStoredPanelState());
  const [containerWidth, setContainerWidth] = useState<number>(() => (
    typeof window === 'undefined' ? 0 : readContainerWidth(chatLayoutRef)
  ));
  const isGatewayRunning = isGatewayOperational(gatewayStatus);
  const taskInboxTasks = useMemo(() => sortTaskInboxTasks(filterUnfinishedTasks(sessions.flatMap((session) => {
    const scopeKey = getSessionTaskScopeKey(session.key);
    const snapshot = taskSnapshots[scopeKey];
    if (!snapshot) {
      return [];
    }
    const sourceSessionKey = session.key;
    return snapshot.tasks.map((task) => ({
      ...task,
      createdAt: task.createdAt ?? 0,
      updatedAt: task.updatedAt ?? task.createdAt ?? 0,
      sourceSessionKey,
      scopeKey: snapshot.scope?.key ?? scopeKey,
    }));
  }))), [getSessionTaskScopeKey, sessions, taskSnapshots]);
  const unfinishedTaskCount = taskInboxTasks.length;
  const activeWidthPolicy = resolveSidePanelWidthPolicy(panelState.activeTab);
  const activeStoredWidth = activeWidthPolicy === 'artifacts'
    ? panelState.artifactWidth
    : panelState.lightWidth;
  const activePreferredWidth = clampChatSidePanelWidth(
    activeStoredWidth,
    Number.POSITIVE_INFINITY,
    activeWidthPolicy,
  );
  const artifactWorkbenchFullscreen = (
    panelState.open
    && panelState.activeTab === 'artifacts'
    && chatTakeoverMode === 'artifact-workbench'
  );
  const layout = useMemo(
    () => resolveChatSidePanelLayout(panelState.open, containerWidth, activePreferredWidth, activeWidthPolicy),
    [activePreferredWidth, activeWidthPolicy, containerWidth, panelState.open],
  );

  const refreshTaskInbox = useCallback(async () => {
    if (taskInboxRefreshPromiseRef.current) {
      return taskInboxRefreshPromiseRef.current;
    }

    const refreshPromise = (async () => {
      setTaskInboxLoading(true);
      setTaskInboxError(null);
      try {
        const chatState = useChatStore.getState();
        const activeSessions = readSessionsFromState(chatState);
        const sessionKeys = uniqueSorted(activeSessions.map((session) => session.key));
        const sessionByKey = new Map(activeSessions.map((session) => [session.key, session]));
        const snapshots = await Promise.all(sessionKeys.map(async (sessionKey) => {
          const session = sessionByKey.get(sessionKey)!;
          return {
            sessionKey,
            snapshot: await listTaskSnapshot({ sessionKey: session.sessionIdentity.sessionKey, sessionIdentity: session.sessionIdentity }),
          };
        }));
        for (const { sessionKey, snapshot } of snapshots) {
          useTaskSnapshotStore.getState().reportTaskCenterSnapshot({
            sessionKey: getSnapshotSessionKey(sessionKey, snapshot),
            recordKey: sessionKey,
            ...(snapshot.scope ? { scope: snapshot.scope } : {}),
            tasks: snapshot.tasks,
            todos: snapshot.todos,
            source: 'replay',
          });
        }
      } catch (error) {
        setTaskInboxError(error instanceof Error ? error.message : String(error));
      } finally {
        setTaskInboxLoading(false);
      }
    })();

    taskInboxRefreshPromiseRef.current = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (taskInboxRefreshPromiseRef.current === refreshPromise) {
        taskInboxRefreshPromiseRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('chat:side-panel-tab', panelState.activeTab);
      window.localStorage.setItem('chat:side-panel-light-width', String(panelState.lightWidth));
      window.localStorage.setItem('chat:side-panel-artifact-width', String(panelState.artifactWidth));
    } catch {
      // ignore localStorage errors
    }
  }, [panelState.activeTab, panelState.artifactWidth, panelState.lightWidth]);

  useEffect(() => {
    return () => {
      clearChatTakeoverMode();
    };
  }, [clearChatTakeoverMode]);

  useEffect(() => {
    const openRuntimeSurface = (event: Event) => {
      const surface = (event as CustomEvent<ChatRuntimeSurfaceDescriptor>).detail;
      if (!surface || (surface.kind !== 'browser-tab' && surface.kind !== 'mcp-app')) {
        return;
      }
      publishChatRuntimeSurface(surface);
      setPanelState((prev) => ({
        ...prev,
        open: true,
        activeTab: 'runtime',
      }));
      clearChatTakeoverMode();
    };
    window.addEventListener(CHAT_RUNTIME_SURFACE_OPEN_EVENT, openRuntimeSurface);
    return () => {
      window.removeEventListener(CHAT_RUNTIME_SURFACE_OPEN_EVENT, openRuntimeSurface);
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
    if (!enabled || !isGatewayRunning || sessionsLoadedOnce) {
      return;
    }
    void loadSessions();
  }, [enabled, isGatewayRunning, loadSessions, sessionsLoadedOnce]);

  const openSidePanel = useCallback(() => {
    setPanelState((prev) => {
      if (prev.open) {
        return prev;
      }
      return {
        ...prev,
        open: true,
      };
    });
  }, []);

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
    sidePanelWidth: artifactWorkbenchFullscreen
      ? containerWidth
      : layout.sidePanelOpen && layout.sidePanelMode === 'docked'
        ? activePreferredWidth
        : layout.sidePanelWidth,
    sidePanelPreferredWidth: activePreferredWidth,
    sidePanelWidthPolicy: activeWidthPolicy,
    activeSidePanelTab: panelState.activeTab,
    artifactWorkbenchFullscreen,
    taskInboxTasks,
    taskInboxLoading,
    taskInboxError,
    unfinishedTaskCount,
    derivedPlanStatus,
    refreshTaskInbox,
    clearTaskInboxError: () => setTaskInboxError(null),
    openSidePanel,
    setActiveSidePanelTab,
    closeSidePanel,
    setSidePanelWidth,
    toggleArtifactWorkbenchFullscreen,
  };
}
