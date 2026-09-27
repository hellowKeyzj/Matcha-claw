import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { useLayoutStore } from '@/stores/layout';
import { invokeIpc } from '@/lib/api-client';
import {
  CHAT_WORKSPACE_LAYOUT,
  clampChatSidePanelWidth,
  type ChatSidePanelMode,
  type ChatSidePanelWidthPolicy,
  type ChatWindowDockPhase,
} from '@/components/layout/chat-workspace-layout';

interface WindowRightDockResult {
  appliedWidth: number;
}

interface WindowRightDockOptions {
  resizeWindow?: boolean;
  currentDockWidth?: number;
}

type ChatWindowDockState =
  | {
    phase: 'closed';
    mode: 'docked';
    sidePanelWidth: number;
    mainWidth: null;
    appliedDockWidth: 0;
  }
  | {
    phase: 'opening';
    mode: 'docked';
    sidePanelWidth: number;
    mainWidth: number;
    anchorMainWidth: number;
    baseWidth: number;
    anchorBaseWidth: number;
    appliedDockWidth: 0;
  }
  | {
    phase: 'open';
    mode: 'docked';
    sidePanelWidth: number;
    mainWidth: number;
    anchorMainWidth: number;
    baseWidth: number;
    anchorBaseWidth: number;
    appliedDockWidth: number;
  }
  | {
    phase: 'open';
    mode: 'overlay';
    sidePanelWidth: number;
    mainWidth: null;
    appliedDockWidth: 0;
  }
  | {
    phase: 'closing';
    mode: ChatSidePanelMode;
    sidePanelWidth: number;
    mainWidth: number;
    anchorMainWidth: number;
    baseWidth: number;
    anchorBaseWidth: number;
    appliedDockWidth: number;
  };

interface UseChatWindowDockControllerOptions {
  enabled: boolean;
  panelOpen: boolean;
  preferredWidth: number;
  renderWidth: number;
  widthPolicy: ChatSidePanelWidthPolicy;
  artifactWorkbenchFullscreen: boolean;
  chatLayoutRef: RefObject<HTMLDivElement | null>;
  openPanel: () => void;
  closePanel: () => void;
  setPanelWidth: (width: number) => void;
}

function createClosedDockState(sidePanelWidth: number): ChatWindowDockState {
  return {
    phase: 'closed',
    mode: 'docked',
    sidePanelWidth,
    mainWidth: null,
    appliedDockWidth: 0,
  };
}

function normalizeWidth(width: number): number {
  return Math.max(0, Math.round(width));
}

function normalizePanelWidth(width: number, containerWidth: number, policy: ChatSidePanelWidthPolicy): number {
  return clampChatSidePanelWidth(normalizeWidth(width), containerWidth || Number.POSITIVE_INFINITY, policy);
}

function readLayoutWidth(chatLayoutRef: RefObject<HTMLDivElement | null>): number {
  return normalizeWidth(chatLayoutRef.current?.getBoundingClientRect().width ?? window.innerWidth);
}

function readMainWidth(
  chatLayoutRef: RefObject<HTMLDivElement | null>,
  sidePanelWidth: number,
  mode: ChatSidePanelMode,
): number {
  const stageNode = chatLayoutRef.current?.firstElementChild;
  if (stageNode instanceof HTMLElement) {
    const measuredWidth = normalizeWidth(stageNode.getBoundingClientRect().width);
    if (measuredWidth > 0) {
      return measuredWidth;
    }
  }
  const layoutWidth = readLayoutWidth(chatLayoutRef);
  if (mode === 'docked') {
    return Math.max(1, layoutWidth - sidePanelWidth - CHAT_WORKSPACE_LAYOUT.paneResizerWidth);
  }
  return Math.max(1, layoutWidth);
}

function resolveDockedMainWidth(layoutWidth: number, sidePanelWidth: number): number {
  return Math.max(1, normalizeWidth(layoutWidth) - sidePanelWidth - CHAT_WORKSPACE_LAYOUT.paneResizerWidth);
}

function getAppliedDockWidth(result: WindowRightDockResult | unknown): number {
  if (!result || typeof result !== 'object' || !('appliedWidth' in result)) {
    return 0;
  }
  const appliedWidth = (result as { appliedWidth: unknown }).appliedWidth;
  return typeof appliedWidth === 'number' && Number.isFinite(appliedWidth)
    ? normalizeWidth(appliedWidth)
    : 0;
}

function isDockWidthUsable(width: number): boolean {
  return width >= CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth + CHAT_WORKSPACE_LAYOUT.paneResizerWidth;
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const timeoutId = window.setTimeout(finish, 80);
    function finish() {
      if (resolved) {
        return;
      }
      resolved = true;
      window.clearTimeout(timeoutId);
      resolve();
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(finish);
    });
  });
}

function waitForWindowWidthAtLeast(width: number): Promise<boolean> {
  const targetWidth = normalizeWidth(width);
  return new Promise((resolve) => {
    let resolved = false;
    const timeoutId = window.setTimeout(() => finish(false), 800);
    const intervalId = window.setInterval(checkWidth, 16);
    function finish(reached: boolean) {
      if (resolved) {
        return;
      }
      resolved = true;
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
      window.removeEventListener('resize', checkWidth);
      resolve(reached);
    }
    function checkWidth() {
      if (resolved) {
        return;
      }
      const reached = normalizeWidth(window.innerWidth) >= targetWidth - 1;
      if (reached) {
        finish(true);
      }
    }
    window.addEventListener('resize', checkWidth);
    checkWidth();
  });
}

function waitForWindowWidthAtMost(width: number): Promise<boolean> {
  const targetWidth = normalizeWidth(width);
  return new Promise((resolve) => {
    let resolved = false;
    const timeoutId = window.setTimeout(() => finish(false), 800);
    const intervalId = window.setInterval(checkWidth, 16);
    function finish(reached: boolean) {
      if (resolved) {
        return;
      }
      resolved = true;
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
      window.removeEventListener('resize', checkWidth);
      resolve(reached);
    }
    function checkWidth() {
      if (resolved) {
        return;
      }
      const reached = normalizeWidth(window.innerWidth) <= targetWidth + 1;
      if (reached) {
        finish(true);
      }
    }
    window.addEventListener('resize', checkWidth);
    checkWidth();
  });
}

function publishRightDockLayout(phase: ChatWindowDockPhase, dockWidth: number, baseWidth: number): void {
  useLayoutStore.getState().setChatWindowRightDockLayout({
    phase,
    dockWidth: normalizeWidth(dockWidth),
    baseWidth: Math.max(1, normalizeWidth(baseWidth)),
  });
}

function clearRightDockLayout(): void {
  useLayoutStore.getState().setChatWindowRightDockLayout(null);
}

export function useChatWindowDockController({
  enabled,
  panelOpen,
  preferredWidth,
  renderWidth,
  widthPolicy,
  artifactWorkbenchFullscreen,
  chatLayoutRef,
  openPanel,
  closePanel,
  setPanelWidth,
}: UseChatWindowDockControllerOptions) {
  const [dockState, setDockState] = useState<ChatWindowDockState>(() => createClosedDockState(preferredWidth));
  const dockStateRef = useRef(dockState);
  const mountedRef = useRef(true);
  const transitionSeqRef = useRef(0);
  const enabledRef = useRef(enabled);
  const panelOpenRef = useRef(panelOpen);
  const preferredWidthRef = useRef(preferredWidth);
  const renderWidthRef = useRef(renderWidth);
  const widthPolicyRef = useRef(widthPolicy);
  const artifactWorkbenchFullscreenRef = useRef(artifactWorkbenchFullscreen);
  const openPanelRef = useRef(openPanel);
  const closePanelRef = useRef(closePanel);
  const setPanelWidthRef = useRef(setPanelWidth);

  enabledRef.current = enabled;
  panelOpenRef.current = panelOpen;
  preferredWidthRef.current = preferredWidth;
  renderWidthRef.current = renderWidth;
  widthPolicyRef.current = widthPolicy;
  artifactWorkbenchFullscreenRef.current = artifactWorkbenchFullscreen;
  openPanelRef.current = openPanel;
  closePanelRef.current = closePanel;
  setPanelWidthRef.current = setPanelWidth;

  const commitDockState = useCallback((nextState: ChatWindowDockState) => {
    dockStateRef.current = nextState;
    setDockState(nextState);
  }, []);

  const setWindowRightDockWidth = useCallback(async (width: number, options?: WindowRightDockOptions) => {
    try {
      return getAppliedDockWidth(await invokeIpc<WindowRightDockResult>('window:setRightDockWidth', normalizeWidth(width), options));
    } catch (error) {
      console.warn('[chat-side-panel] failed to sync window right dock width', error);
      return 0;
    }
  }, []);

  const openSidePanel = useCallback(async (options?: { flush?: boolean }) => {
    const flush = options?.flush !== false;
    const currentState = dockStateRef.current;
    if (currentState.phase === 'opening' || currentState.phase === 'open' || currentState.phase === 'closing') {
      openPanelRef.current();
      return;
    }

    const seq = transitionSeqRef.current + 1;
    transitionSeqRef.current = seq;
    const baseWindowWidth = normalizeWidth(window.innerWidth);
    const sidePanelWidth = normalizePanelWidth(preferredWidthRef.current, Number.POSITIVE_INFINITY, widthPolicyRef.current);
    const requestedDockWidth = sidePanelWidth + CHAT_WORKSPACE_LAYOUT.paneResizerWidth;
    const mainWidth = readMainWidth(chatLayoutRef, sidePanelWidth, 'overlay');
    const openingState: ChatWindowDockState = {
      phase: 'opening',
      mode: 'docked',
      sidePanelWidth,
      mainWidth,
      anchorMainWidth: mainWidth,
      baseWidth: baseWindowWidth,
      anchorBaseWidth: baseWindowWidth,
      appliedDockWidth: 0,
    };
    const beginOpening = () => {
      if (enabledRef.current && !artifactWorkbenchFullscreenRef.current) {
        publishRightDockLayout('opening', requestedDockWidth, baseWindowWidth);
      }
      commitDockState(openingState);
    };

    if (flush) {
      flushSync(beginOpening);
    } else {
      beginOpening();
    }

    if (!mountedRef.current || transitionSeqRef.current !== seq) {
      return;
    }

    const appliedDockWidth = enabledRef.current && !artifactWorkbenchFullscreenRef.current
      ? await setWindowRightDockWidth(requestedDockWidth, { currentDockWidth: 0 })
      : 0;
    const resetCancelledOpening = async () => {
      if (appliedDockWidth > 0) {
        await setWindowRightDockWidth(0, { currentDockWidth: appliedDockWidth });
      }
      clearRightDockLayout();
    };
    const openingCancelled = () => (
      !mountedRef.current
      || transitionSeqRef.current !== seq
      || !enabledRef.current
      || artifactWorkbenchFullscreenRef.current
    );

    if (openingCancelled()) {
      await resetCancelledOpening();
      return;
    }

    let docked = false;
    if (isDockWidthUsable(appliedDockWidth)) {
      const windowExpanded = await waitForWindowWidthAtLeast(baseWindowWidth + appliedDockWidth);
      if (openingCancelled()) {
        await resetCancelledOpening();
        return;
      }
      if (windowExpanded) {
        docked = normalizeWidth(window.innerWidth) >= baseWindowWidth + appliedDockWidth - 1;
      }
    }
    if (openingCancelled()) {
      await resetCancelledOpening();
      return;
    }
    if (!docked) {
      if (appliedDockWidth > 0) {
        await setWindowRightDockWidth(0, { currentDockWidth: appliedDockWidth });
        if (!mountedRef.current || transitionSeqRef.current !== seq) {
          return;
        }
      }
      clearRightDockLayout();
      const closedState = createClosedDockState(preferredWidthRef.current);
      if (flush) {
        flushSync(() => {
          commitDockState(closedState);
          closePanelRef.current();
        });
      } else {
        commitDockState(closedState);
        closePanelRef.current();
      }
      return;
    }

    const finalSidePanelWidth = appliedDockWidth - CHAT_WORKSPACE_LAYOUT.paneResizerWidth;

    const completeOpening = () => {
      setPanelWidthRef.current(finalSidePanelWidth);

      openPanelRef.current();
      publishRightDockLayout('open', appliedDockWidth, baseWindowWidth);

      commitDockState({
        phase: 'open',
        mode: 'docked',
        sidePanelWidth: finalSidePanelWidth,
        mainWidth,
        anchorMainWidth: mainWidth,
        baseWidth: baseWindowWidth,
        anchorBaseWidth: baseWindowWidth,
        appliedDockWidth,
      });
    };
    if (flush) {
      flushSync(completeOpening);
    } else {
      completeOpening();
    }
  }, [chatLayoutRef, commitDockState, setWindowRightDockWidth]);

  const closeSidePanel = useCallback(async (options?: { flush?: boolean }) => {
    const flush = options?.flush !== false;
    const currentState = dockStateRef.current;
    if (currentState.phase === 'closing') {
      return;
    }
    if (currentState.phase === 'closed') {
      closePanelRef.current();
      return;
    }
    if (currentState.phase === 'opening') {
      transitionSeqRef.current += 1;
      clearRightDockLayout();
      const closedState = createClosedDockState(preferredWidthRef.current);
      if (flush) {
        flushSync(() => {
          commitDockState(closedState);
          closePanelRef.current();
        });
      } else {
        commitDockState(closedState);
        closePanelRef.current();
      }
      return;
    }

    const seq = transitionSeqRef.current + 1;
    transitionSeqRef.current = seq;
    const sidePanelWidth = currentState.sidePanelWidth;
    const dockLayout = useLayoutStore.getState().chatWindowRightDockLayout;
    const windowWidth = normalizeWidth(window.innerWidth);
    const appliedDockWidth = currentState.mode === 'docked'
      ? currentState.appliedDockWidth || sidePanelWidth + CHAT_WORKSPACE_LAYOUT.paneResizerWidth
      : 0;
    const baseWindowWidth = currentState.mode === 'docked'
      ? currentState.baseWidth
      : windowWidth;
    const currentDockWidth = currentState.mode === 'docked'
      ? Math.max(appliedDockWidth, windowWidth - baseWindowWidth)
      : 0;
    const windowDockActive = currentState.mode === 'docked'
      && currentDockWidth > 0
      && (!dockLayout || windowWidth > dockLayout.baseWidth + 1);
    const closeDockOptions = windowDockActive
      ? { currentDockWidth }
      : undefined;
    const closingState: ChatWindowDockState = {
      phase: 'closing',
      mode: currentState.mode,
      sidePanelWidth,
      mainWidth: currentState.mode === 'docked'
        ? currentState.mainWidth
        : readMainWidth(chatLayoutRef, sidePanelWidth, currentState.mode),
      anchorMainWidth: currentState.mode === 'docked'
        ? currentState.anchorMainWidth
        : readMainWidth(chatLayoutRef, sidePanelWidth, currentState.mode),
      baseWidth: baseWindowWidth,
      anchorBaseWidth: currentState.mode === 'docked'
        ? currentState.anchorBaseWidth
        : baseWindowWidth,
      appliedDockWidth: currentDockWidth,
    };
    const beginClosing = () => {
      if (windowDockActive) {
        publishRightDockLayout('closing', currentDockWidth, baseWindowWidth);
      } else {
        clearRightDockLayout();
      }
      commitDockState(closingState);
    };

    if (flush) {
      flushSync(beginClosing);
    } else {
      beginClosing();
    }

    try {
      if (windowDockActive) {
        await waitForNextPaint();
        if (!mountedRef.current || transitionSeqRef.current !== seq || dockStateRef.current.phase !== 'closing') {
          return;
        }
        await setWindowRightDockWidth(0, closeDockOptions);
        await waitForWindowWidthAtMost(baseWindowWidth);
      }
    } finally {
      if (mountedRef.current && (transitionSeqRef.current === seq || dockStateRef.current.phase === 'closing')) {
        const closedState = createClosedDockState(preferredWidthRef.current);
        clearRightDockLayout();
        if (flush) {
          flushSync(() => {
            commitDockState(closedState);
            closePanelRef.current();
          });
        } else {
          commitDockState(closedState);
          closePanelRef.current();
        }
      }
    }
  }, [chatLayoutRef, commitDockState, setWindowRightDockWidth]);

  const toggleSidePanel = useCallback(() => {
    const currentState = dockStateRef.current;
    if (panelOpenRef.current || currentState.phase !== 'closed') {
      void closeSidePanel();
      return;
    }
    void openSidePanel();
  }, [closeSidePanel, openSidePanel]);

  const resizeSidePanelWidth = useCallback((nextWidth: number) => {
    const currentState = dockStateRef.current;
    const layoutWidth = readLayoutWidth(chatLayoutRef);
    const sidePanelWidth = normalizePanelWidth(nextWidth, layoutWidth, widthPolicyRef.current);
    setPanelWidthRef.current(sidePanelWidth);
    if (currentState.phase !== 'open' || currentState.mode !== 'docked') {
      return;
    }
    const mainWidth = resolveDockedMainWidth(layoutWidth, sidePanelWidth);
    const baseWidth = Math.max(1, normalizeWidth(window.innerWidth) - sidePanelWidth - CHAT_WORKSPACE_LAYOUT.paneResizerWidth);
    commitDockState({
      ...currentState,
      sidePanelWidth,
      mainWidth,
      anchorMainWidth: mainWidth,
      baseWidth,
      anchorBaseWidth: baseWidth,
      appliedDockWidth: sidePanelWidth + CHAT_WORKSPACE_LAYOUT.paneResizerWidth,
    });
  }, [chatLayoutRef, commitDockState]);

  const commitSidePanelWidth = useCallback((nextWidth?: number) => {
    const currentState = dockStateRef.current;
    if (currentState.phase !== 'open' || currentState.mode !== 'docked' || currentState.appliedDockWidth <= 0) {
      return;
    }
    const layoutWidth = readLayoutWidth(chatLayoutRef);
    const sidePanelWidth = normalizePanelWidth(nextWidth ?? currentState.sidePanelWidth, layoutWidth, widthPolicyRef.current);
    const dockWidth = sidePanelWidth + CHAT_WORKSPACE_LAYOUT.paneResizerWidth;
    const baseWidth = Math.max(1, normalizeWidth(window.innerWidth) - dockWidth);
    const mainWidth = resolveDockedMainWidth(layoutWidth, sidePanelWidth);
    setPanelWidthRef.current(sidePanelWidth);
    publishRightDockLayout('open', dockWidth, baseWidth);
    commitDockState({
      ...currentState,
      sidePanelWidth,
      mainWidth,
      anchorMainWidth: mainWidth,
      baseWidth,
      anchorBaseWidth: baseWidth,
      appliedDockWidth: dockWidth,
    });
    void setWindowRightDockWidth(dockWidth, { resizeWindow: false });
  }, [chatLayoutRef, commitDockState, setWindowRightDockWidth]);

  useEffect(() => {
    const syncDockedPanelWidth = () => {
      const currentState = dockStateRef.current;
      if (currentState.phase !== 'open' || currentState.mode !== 'docked') {
        return;
      }
      const windowWidth = normalizeWidth(window.innerWidth);
      const minimumDockWidth = CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth + CHAT_WORKSPACE_LAYOUT.paneResizerWidth;
      const anchorBaseWidth = currentState.anchorBaseWidth;
      const nextBaseWidth = Math.min(anchorBaseWidth, Math.max(1, windowWidth - minimumDockWidth));
      const nextDockWidth = Math.max(minimumDockWidth, windowWidth - nextBaseWidth);
      const baseWidthDelta = anchorBaseWidth - nextBaseWidth;
      const sidePanelWidth = nextDockWidth - CHAT_WORKSPACE_LAYOUT.paneResizerWidth;
      const mainWidth = Math.max(1, currentState.anchorMainWidth - baseWidthDelta);
      if (
        sidePanelWidth === currentState.sidePanelWidth
        && mainWidth === currentState.mainWidth
        && nextBaseWidth === currentState.baseWidth
        && nextDockWidth === currentState.appliedDockWidth
      ) {
        return;
      }
      setPanelWidthRef.current(sidePanelWidth);
      publishRightDockLayout('open', nextDockWidth, nextBaseWidth);
      commitDockState({
        ...currentState,
        sidePanelWidth,
        mainWidth,
        baseWidth: nextBaseWidth,
        appliedDockWidth: nextDockWidth,
      });
      void setWindowRightDockWidth(nextDockWidth, { resizeWindow: false });
    };

    window.addEventListener('resize', syncDockedPanelWidth);
    return () => {
      window.removeEventListener('resize', syncDockedPanelWidth);
    };
  }, [commitDockState, setWindowRightDockWidth]);

  useEffect(() => {
    if (!enabled || artifactWorkbenchFullscreen) {
      const currentState = dockStateRef.current;
      if (currentState.appliedDockWidth > 0) {
        void setWindowRightDockWidth(0);
      }
      clearRightDockLayout();
      if (currentState.phase !== 'closed') {
        transitionSeqRef.current += 1;
        commitDockState(createClosedDockState(preferredWidthRef.current));
      }
      return;
    }

    const currentState = dockStateRef.current;
    if (panelOpen && currentState.phase === 'closed') {
      void openSidePanel({ flush: false });
    } else if (!panelOpen && currentState.phase !== 'closed') {
      void closeSidePanel({ flush: false });
    }
  }, [artifactWorkbenchFullscreen, closeSidePanel, commitDockState, enabled, openSidePanel, panelOpen, setWindowRightDockWidth]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const currentState = dockStateRef.current;
      if (currentState.appliedDockWidth > 0) {
        void setWindowRightDockWidth(0);
      }
      clearRightDockLayout();
    };
  }, [setWindowRightDockWidth]);

  return useMemo(() => {
    const phase: ChatWindowDockPhase = artifactWorkbenchFullscreen ? 'closed' : dockState.phase;
    const sidePanelMounted = phase !== 'closed';
    const sidePanelWidth = phase === 'closed'
      ? renderWidth
      : dockState.sidePanelWidth;
    const sidePanelMainWidth = phase !== 'closed' && dockState.mode === 'docked'
      ? dockState.mainWidth
      : null;

    return {
      phase,
      sidePanelMounted,
      sidePanelExpanded: panelOpen || sidePanelMounted,
      sidePanelMode: phase === 'closed' ? 'docked' : dockState.mode,
      sidePanelWidth,
      sidePanelMainWidth,
      sidePanelVisible: phase === 'open',
      toggleSidePanel,
      openSidePanel,
      closeSidePanel,
      resizeSidePanelWidth,
      commitSidePanelWidth,
    };
  }, [artifactWorkbenchFullscreen, closeSidePanel, commitSidePanelWidth, dockState, openSidePanel, panelOpen, renderWidth, resizeSidePanelWidth, toggleSidePanel]);
}
