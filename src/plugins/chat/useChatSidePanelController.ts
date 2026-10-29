import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useGatewayStore } from '@/plugins/runtime/store';
import { useLayoutStore } from '@/app/layout/store';
import { useChatStore } from '@/plugins/chat/store';
import { isGatewayOperational } from '@/plugins/runtime/gateway-status';
import { buildSessionIdentityKey, sessionIdentitiesEqual, validateSessionIdentity, type SessionIdentity } from '@/types/desktop/runtime-address';
import {
  CHAT_WORKSPACE_LAYOUT,
  clampChatSidePanelWidth,
  resolveChatSidePanelLayout,
  type ChatSidePanelMode,
} from '@/app/layout/workspace';
import { useContributions } from '@/plugin-host/react';
import { chatSidePanels, type ChatPanelLayout, type ChatSidePanelContribution } from './extensions';
import { CHAT_PANEL_OPEN_EVENT, type ChatPanelContent, type ChatPanelRequest } from './workspace-actions';

export type ChatSidePanelTab = ChatSidePanelContribution['id'];

const DEFAULT_PANEL_LAYOUT: ChatPanelLayout = { position: 'right', fullscreen: false };

interface ChatSidePanelState {
  open: boolean;
  activeTab: ChatSidePanelTab;
  width: number;
}

interface PanelSessionState {
  identityKey: string | null;
  contents: Readonly<Record<string, ChatPanelContent>>;
  layouts: Readonly<Record<string, ChatPanelLayout>>;
}

function readStoredPanelState(panels: readonly ChatSidePanelContribution[]): ChatSidePanelState {
  try {
    const storedTab = window.localStorage.getItem('chat:side-panel-tab');
    const storedWidth = Number(window.localStorage.getItem('chat:side-panel-width'));
    return {
      open: false,
      activeTab: panels.find((panel) => panel.id === storedTab)?.id ?? 'artifacts',
      width: Number.isFinite(storedWidth) && storedWidth > 0
        ? storedWidth
        : CHAT_WORKSPACE_LAYOUT.sidePanelDefaultWidth,
    };
  } catch {
    return { open: false, activeTab: 'artifacts', width: CHAT_WORKSPACE_LAYOUT.sidePanelDefaultWidth };
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
  const viewportTakeover = useLayoutStore((state) => state.viewportTakeover);
  const setViewportTakeover = useLayoutStore((state) => state.setViewportTakeover);
  const clearViewportTakeover = useLayoutStore((state) => state.clearViewportTakeover);
  const sessionsLoadedOnce = useChatStore((state) => state.sessionCatalogStatus.hasLoadedOnce);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const resizeRafRef = useRef<number | null>(null);
  const panels = useContributions(chatSidePanels);
  const [panelState, setPanelState] = useState<ChatSidePanelState>(() => readStoredPanelState(panels));
  const sessionIdentityKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : null;
  const [panelSession, setPanelSession] = useState<PanelSessionState>(() => ({ identityKey: sessionIdentityKey, contents: {}, layouts: {} }));
  if (panelSession.identityKey !== sessionIdentityKey) {
    setPanelSession({ identityKey: sessionIdentityKey, contents: {}, layouts: {} });
  }
  const panelLayout = panelSession.layouts[panelState.activeTab] ?? DEFAULT_PANEL_LAYOUT;
  const panelContent = panelSession.contents[panelState.activeTab] ?? null;
  const [containerWidth, setContainerWidth] = useState<number>(() => (
    typeof window === 'undefined' ? 0 : window.innerWidth
  ));
  const isGatewayRunning = isGatewayOperational(gatewayStatus);
  const activePreferredWidth = clampChatSidePanelWidth(panelState.width, Number.POSITIVE_INFINITY);
  const artifactWorkbenchFullscreen = panelState.open
    && panelState.activeTab === 'artifacts'
    && viewportTakeover;
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

  useEffect(() => () => clearViewportTakeover(), [clearViewportTakeover]);

  const openPanel = useCallback((request: ChatPanelRequest) => {
    if (!enabled || !sessionIdentity || validateSessionIdentity(request.sessionIdentity)
      || !sessionIdentitiesEqual(request.sessionIdentity, sessionIdentity)
      || !panels.some((panel) => panel.id === request.id)) return;
    if (request.content) {
      const content = request.content;
      setPanelSession((current) => current.identityKey === sessionIdentityKey
        ? { ...current, contents: { ...current.contents, [request.id]: content } }
        : current);
    }
    setPanelState((prev) => ({ ...prev, open: true, activeTab: request.id }));
    clearViewportTakeover();
  }, [clearViewportTakeover, enabled, panels, sessionIdentity, sessionIdentityKey]);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const request = (event as CustomEvent<ChatPanelRequest>).detail;
      if (request) openPanel(request);
    };
    window.addEventListener(CHAT_PANEL_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(CHAT_PANEL_OPEN_EVENT, handleOpen);
  }, [openPanel]);

  useEffect(() => {
    if (!panelState.open || panelState.activeTab !== 'artifacts') clearViewportTakeover();
  }, [clearViewportTakeover, panelState.activeTab, panelState.open]);

  useEffect(() => {
    const applyResize = () => {
      const nextContainerWidth = readContainerWidth(chatLayoutRef);
      setContainerWidth((prev) => prev === nextContainerWidth ? prev : nextContainerWidth);
    };
    const scheduleResize = () => {
      if (resizeRafRef.current != null) return;
      resizeRafRef.current = window.requestAnimationFrame(() => {
        resizeRafRef.current = null;
        applyResize();
      });
    };
    scheduleResize();
    const layoutNode = chatLayoutRef.current;
    const observer = typeof ResizeObserver === 'function' && layoutNode
      ? new ResizeObserver(scheduleResize) : null;
    if (observer && layoutNode) observer.observe(layoutNode);
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
    if (enabled && isGatewayRunning && !sessionsLoadedOnce) void loadSessions();
  }, [enabled, isGatewayRunning, loadSessions, sessionsLoadedOnce]);

  const openSidePanel = useCallback(() => {
    setPanelState((prev) => prev.open ? prev : { ...prev, open: true });
  }, []);

  const setActiveSidePanelTab = useCallback((tab: ChatSidePanelTab) => {
    setPanelState((prev) => prev.open && prev.activeTab === tab ? prev : { ...prev, open: true, activeTab: tab });
    if (tab !== 'artifacts') clearViewportTakeover();
  }, [clearViewportTakeover]);

  const closeSidePanel = useCallback(() => {
    setPanelState((prev) => ({ ...prev, open: false }));
    clearViewportTakeover();
    setPanelSession((current) => ({
      ...current,
      contents: {},
      layouts: Object.fromEntries(Object.entries(current.layouts).map(([id, value]) => [id, { ...value, fullscreen: false }])),
    }));
  }, [clearViewportTakeover]);

  const setPanelLayout = useCallback((patch: Partial<ChatPanelLayout>) => {
    const id = panelState.activeTab;
    setPanelSession((current) => {
      if (current.identityKey !== sessionIdentityKey) return current;
      const previous = current.layouts[id] ?? DEFAULT_PANEL_LAYOUT;
      const next = { ...previous, ...patch };
      if (previous.position === next.position && previous.fullscreen === next.fullscreen) return current;
      return { ...current, layouts: { ...current.layouts, [id]: next } };
    });
  }, [panelState.activeTab, sessionIdentityKey]);

  const setSidePanelWidth = useCallback((nextWidth: number) => {
    setPanelState((prev) => {
      const clamped = clampChatSidePanelWidth(nextWidth, readContainerWidth(chatLayoutRef));
      return prev.width === clamped ? prev : { ...prev, width: clamped };
    });
  }, [chatLayoutRef]);

  const toggleArtifactWorkbenchFullscreen = useCallback(() => {
    setPanelState((prev) => prev.activeTab === 'artifacts' ? { ...prev, open: true } : prev);
    setViewportTakeover(!viewportTakeover);
  }, [viewportTakeover, setViewportTakeover]);

  return {
    sidePanelOpen: layout.sidePanelOpen,
    sidePanelMode: layout.sidePanelMode as ChatSidePanelMode,
    sidePanelWidth: artifactWorkbenchFullscreen ? containerWidth
      : layout.sidePanelOpen && layout.sidePanelMode === 'docked' ? activePreferredWidth : layout.sidePanelWidth,
    sidePanelPreferredWidth: activePreferredWidth,
    activeSidePanelTab: panelState.activeTab,
    panelContent,
    panelLayout,
    setPanelLayout,
    openPanel,
    sidePanelInline: panelLayout.fullscreen || panelLayout.position === 'top' || panelLayout.position === 'full',
    artifactWorkbenchFullscreen,
    openSidePanel,
    setActiveSidePanelTab,
    closeSidePanel,
    setSidePanelWidth,
    toggleArtifactWorkbenchFullscreen,
  };
}
