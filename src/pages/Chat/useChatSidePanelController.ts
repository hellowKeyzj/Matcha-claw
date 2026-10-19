import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useGatewayStore } from '@/stores/gateway';
import { useLayoutStore } from '@/stores/layout';
import { useChatStore } from '@/stores/chat';
import { isGatewayOperational } from '@/lib/gateway-status';
import { buildSessionIdentityKey, sessionIdentitiesEqual, validateSessionIdentity, type SessionIdentity } from '@/types/desktop/runtime-address';
import {
  CHAT_WORKSPACE_LAYOUT,
  clampChatSidePanelWidth,
  resolveChatSidePanelLayout,
  type ChatSidePanelMode,
} from '@/components/layout/chat-workspace-layout';

import { decodeOpenClawRuntimeSurfaceDescriptor, type OpenClawRuntimeSurfaceDescriptor } from '@/types/openclaw-runtime-surface';
import type { BoardChatDock } from '@/types/board';

export type ChatSidePanelTab = 'artifacts' | 'runtime' | 'board';

export const CHAT_RUNTIME_SURFACE_OPEN_EVENT = 'chat:open-runtime-surface';

export type ChatRuntimeSurfaceDescriptor =
  | OpenClawRuntimeSurfaceDescriptor
  | {
    readonly kind: 'team-graph';
    readonly sourceSessionIdentity: SessionIdentity;
    readonly teamId: string;
    readonly runId: string;
    readonly title?: string;
  }
  | {
    readonly kind: 'browser-tab';
    readonly sourceSessionIdentity: SessionIdentity;
    readonly targetId: string;
    readonly profile: string;
    readonly target: 'host' | 'node';
    readonly node?: string;
    readonly title?: string;
    readonly url?: string;
  };

export function openChatRuntimeSurface(surface: ChatRuntimeSurfaceDescriptor): void {
  window.dispatchEvent(new CustomEvent<ChatRuntimeSurfaceDescriptor>(CHAT_RUNTIME_SURFACE_OPEN_EVENT, { detail: surface }));
}


interface ChatSidePanelState {
  open: boolean;
  activeTab: ChatSidePanelTab;
  width: number;
}

function isStoredSidePanelTab(value: string | null): value is ChatSidePanelTab {
  return value === 'artifacts' || value === 'runtime' || value === 'board';
}

function readStoredPanelState(): ChatSidePanelState {
  try {
    const storedTab = window.localStorage.getItem('chat:side-panel-tab');
    const storedWidth = Number(window.localStorage.getItem('chat:side-panel-width'));
    return {
      open: false,
      activeTab: isStoredSidePanelTab(storedTab) ? storedTab : 'artifacts',
      width: Number.isFinite(storedWidth) && storedWidth > 0
        ? storedWidth
        : CHAT_WORKSPACE_LAYOUT.sidePanelDefaultWidth,
    };
  } catch {
    return {
      open: false,
      activeTab: 'artifacts',
      width: CHAT_WORKSPACE_LAYOUT.sidePanelDefaultWidth,
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
  const [runtimeSurface, setRuntimeSurface] = useState<ChatRuntimeSurfaceDescriptor | null>(null);
  const [boardChatDock, setBoardChatDock] = useState<BoardChatDock>('left');
  const [boardFullscreen, setBoardFullscreen] = useState(false);
  const sessionIdentityKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : null;
  const [selectedSessionIdentityKey, setSelectedSessionIdentityKey] = useState(sessionIdentityKey);
  if (selectedSessionIdentityKey !== sessionIdentityKey) {
    setSelectedSessionIdentityKey(sessionIdentityKey);
    setRuntimeSurface(null);
    setBoardChatDock('left');
    setBoardFullscreen(false);
  }
  const [containerWidth, setContainerWidth] = useState<number>(() => (
    typeof window === 'undefined' ? 0 : window.innerWidth
  ));
  const isGatewayRunning = isGatewayOperational(gatewayStatus);
  const activePreferredWidth = clampChatSidePanelWidth(
    panelState.width,
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
      window.localStorage.setItem('chat:side-panel-width', String(panelState.width));
    } catch {
      // ignore localStorage errors
    }
  }, [panelState.activeTab, panelState.width]);

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
      if (!enabled || !sessionIdentity) return;
      if (surface.kind === 'team-graph' || surface.kind === 'browser-tab') {
        if (validateSessionIdentity(surface.sourceSessionIdentity)
          || !sessionIdentitiesEqual(surface.sourceSessionIdentity, sessionIdentity)) return;
        if (surface.kind === 'team-graph' && (typeof surface.teamId !== 'string' || !surface.teamId.trim()
          || typeof surface.runId !== 'string' || !surface.runId.trim())) return;
      } else if (!decodeOpenClawRuntimeSurfaceDescriptor(surface)
        || !sessionIdentitiesEqual(surface.sessionIdentity, sessionIdentity)) {
        return;
      }
      setRuntimeSurface(surface);
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
    setRuntimeSurface(null);
    setBoardFullscreen(false);
  }, [clearChatTakeoverMode]);

  const setSidePanelWidth = useCallback((nextWidth: number) => {
    setPanelState((prev) => {
      const clamped = clampChatSidePanelWidth(nextWidth, readContainerWidth(chatLayoutRef));
      return prev.width === clamped ? prev : { ...prev, width: clamped };
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
    runtimeSurface,
    sidePanelInline: panelState.activeTab === 'board' && (boardFullscreen || boardChatDock === 'bottom' || boardChatDock === 'hidden'),
    boardChatDock: panelState.activeTab === 'board' ? boardChatDock : undefined,
    boardFullscreen: panelState.open && panelState.activeTab === 'board' && boardFullscreen,
    setBoardChatDock,
    setBoardFullscreen,
    artifactWorkbenchFullscreen,
    openSidePanel,
    setActiveSidePanelTab,
    closeSidePanel,
    setSidePanelWidth,
    toggleArtifactWorkbenchFullscreen,
  };
}
