import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useGatewayStore } from '@/stores/gateway';
import { useLayoutStore } from '@/stores/layout';
import { useChatStore } from '@/stores/chat';
import { isGatewayOperational } from '@/lib/gateway-status';
import { buildSessionIdentityKey, sessionIdentitiesEqual, validateSessionIdentity, type SessionIdentity } from '@/types/desktop/runtime-address';
import {
  clampChatSidePanelWidth,
  getDefaultChatSidePanelWidth,
  resolveChatSidePanelLayout,
  type ChatSidePanelWidthPolicy,
  type ChatSidePanelMode,
} from '@/components/layout/chat-workspace-layout';

export type ChatSidePanelTab = 'artifacts' | 'runtime';

export const CHAT_RUNTIME_SURFACE_OPEN_EVENT = 'chat:open-runtime-surface';

export type ChatRuntimeSurfaceDescriptor =
  | {
    readonly kind: 'team-graph';
    readonly sourceSessionIdentity: SessionIdentity;
    readonly teamId: string;
    readonly runId: string;
    readonly title?: string;
  }
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

type SharedChatRuntimeSurface = Exclude<ChatRuntimeSurfaceDescriptor, { kind: 'team-graph' }>;

let chatRuntimeSurfaceSnapshot: SharedChatRuntimeSurface | null = null;
const chatRuntimeSurfaceListeners = new Set<() => void>();

export function getChatRuntimeSurfaceSnapshot(): SharedChatRuntimeSurface | null {
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

function publishChatRuntimeSurface(surface: SharedChatRuntimeSurface): void {
  chatRuntimeSurfaceSnapshot = surface;
  for (const listener of chatRuntimeSurfaceListeners) {
    listener();
  }
}

interface ChatSidePanelState {
  open: boolean;
  activeTab: ChatSidePanelTab;
  lightWidth: number;
  artifactWidth: number;
}

function isStoredSidePanelTab(value: string | null): value is ChatSidePanelTab {
  return value === 'artifacts' || value === 'runtime';
}

function resolveSidePanelWidthPolicy(tab: ChatSidePanelTab): ChatSidePanelWidthPolicy {
  return tab === 'artifacts' ? 'artifacts' : 'light';
}

function readStoredPanelState(): ChatSidePanelState {
  try {
    const storedTab = window.localStorage.getItem('chat:side-panel-tab');
    const storedLightWidth = Number(window.localStorage.getItem('chat:side-panel-light-width'));
    const storedArtifactWidth = Number(window.sessionStorage.getItem('chat:side-panel-artifact-width'));
    return {
      open: false,
      activeTab: isStoredSidePanelTab(storedTab) ? storedTab : 'artifacts',
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
      activeTab: 'artifacts',
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
  sessionIdentity?: SessionIdentity,
) {
  const gatewayStatus = useGatewayStore((state) => state.status);
  const chatTakeoverMode = useLayoutStore((state) => state.chatTakeoverMode);
  const setChatTakeoverMode = useLayoutStore((state) => state.setChatTakeoverMode);
  const clearChatTakeoverMode = useLayoutStore((state) => state.clearChatTakeoverMode);
  const sessionsLoadedOnce = useChatStore((state) => state.sessionCatalogStatus.hasLoadedOnce);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const resizeRafRef = useRef<number | null>(null);
  const [panelState, setPanelState] = useState<ChatSidePanelState>(() => readStoredPanelState());
  const [selectedTeamGraphSurface, setTeamGraphSurface] = useState<Extract<ChatRuntimeSurfaceDescriptor, { kind: 'team-graph' }> | null>(null);
  const sessionIdentityKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : null;
  const [selectedSessionIdentityKey, setSelectedSessionIdentityKey] = useState(sessionIdentityKey);
  if (selectedSessionIdentityKey !== sessionIdentityKey) {
    setSelectedSessionIdentityKey(sessionIdentityKey);
    setTeamGraphSurface(null);
  }
  const teamGraphSurface = selectedTeamGraphSurface && sessionIdentity
    && sessionIdentitiesEqual(selectedTeamGraphSurface.sourceSessionIdentity, sessionIdentity)
    ? selectedTeamGraphSurface
    : null;
  const [containerWidth, setContainerWidth] = useState<number>(() => (
    typeof window === 'undefined' ? 0 : window.innerWidth
  ));
  const isGatewayRunning = isGatewayOperational(gatewayStatus);
  const activeWidthPolicy = resolveSidePanelWidthPolicy(panelState.activeTab);
  const activeStoredWidth = activeWidthPolicy === 'artifacts'
    ? panelState.artifactWidth
    : panelState.lightWidth;
  const activePreferredWidth = clampChatSidePanelWidth(
    activeStoredWidth,
    Number.POSITIVE_INFINITY,
  );
  const artifactWorkbenchFullscreen = (
    panelState.open
    && panelState.activeTab === 'artifacts'
    && chatTakeoverMode === 'artifact-workbench'
  );
  const layout = useMemo(
    () => resolveChatSidePanelLayout(panelState.open, containerWidth, activePreferredWidth),
    [activePreferredWidth, containerWidth, panelState.open],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem('chat:side-panel-tab', panelState.activeTab);
      window.localStorage.setItem('chat:side-panel-light-width', String(panelState.lightWidth));
      window.sessionStorage.setItem('chat:side-panel-artifact-width', String(panelState.artifactWidth));
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
      if (!surface) {
        return;
      }
      if (surface.kind === 'team-graph') {
        if (!enabled || !sessionIdentity || validateSessionIdentity(surface.sourceSessionIdentity)
          || !sessionIdentitiesEqual(surface.sourceSessionIdentity, sessionIdentity)
          || typeof surface.teamId !== 'string' || !surface.teamId.trim()
          || typeof surface.runId !== 'string' || !surface.runId.trim()) {
          return;
        }
        setTeamGraphSurface(surface);
      } else if (surface.kind === 'browser-tab' || surface.kind === 'mcp-app') {
        setTeamGraphSurface(null);
        publishChatRuntimeSurface(surface);
      } else {
        return;
      }
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
  }, [clearChatTakeoverMode, enabled, sessionIdentity]);

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
      const clamped = clampChatSidePanelWidth(nextWidth, readContainerWidth(chatLayoutRef));
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
    activeSidePanelTab: panelState.activeTab,
    teamGraphSurface,
    artifactWorkbenchFullscreen,
    openSidePanel,
    setActiveSidePanelTab,
    closeSidePanel,
    setSidePanelWidth,
    toggleArtifactWorkbenchFullscreen,
  };
}
