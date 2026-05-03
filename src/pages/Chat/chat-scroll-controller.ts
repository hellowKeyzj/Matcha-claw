import type { RefObject, TouchEventHandler, WheelEventHandler } from 'react';
import { markChatScrollActivity } from './chat-scroll-drain';

type ScopeTransitionMode = 'restore-anchor' | 'force-bottom';

const INITIAL_ALIGN_RETRY_MS = 150;
const FOLLOW_RETRY_MS = 120;
const DETACHED_ANCHOR_CAPTURE_IDLE_MS = 90;

export interface ChatViewportMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  clientWidth: number;
}

interface ViewportAnchor {
  messageId?: string;
  timestamp?: number;
  offsetWithinViewport: number;
}

interface TailMessageMetrics {
  rowKey: string;
  height: number;
}

interface PendingScopeTransition {
  targetScopeKey: string;
  mode: ScopeTransitionMode;
  anchor?: ViewportAnchor;
}

interface FollowSnapshot {
  viewportHeight: number | null;
  viewportWidth: number | null;
  scrollHeight: number | null;
  tailMetrics: TailMessageMetrics | null;
}

interface ScrollScopeState {
  hasLoaded: boolean;
  isBottomLocked: boolean;
  anchor: ViewportAnchor | null;
  anchorDirty: boolean;
}

export interface ChatScrollControllerConfig {
  enabled: boolean;
  scrollScopeKey: string;
  tailActivityOpen: boolean;
  setScrollChromeBottomLocked: (isBottomLocked: boolean) => void;
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  stickyBottomThresholdPx: number;
}

export interface ChatScrollController {
  onScopeRenderSync: () => void;
  onTailActivityRenderSync: () => void;
  onAutoFollowRenderSync: () => void;
  onResizeObserved: () => void;
  syncChromeRender: () => void;
  handleViewportScroll: () => void;
  handleViewportPointerDown: () => void;
  handleViewportTouchMove: TouchEventHandler<HTMLDivElement>;
  handleViewportWheel: WheelEventHandler<HTMLDivElement>;
  prepareScopeAnchorRestore: (nextScopeKey: string) => void;
  prepareScopeBottomAlign: (nextScopeKey: string) => void;
  jumpToBottom: () => void;
  cleanup: () => void;
}

interface ScrollControllerState {
  isBottomLocked: boolean;
  lastScopeKey: string;
  scopeStateByScope: Map<string, ScrollScopeState>;
  pendingScopeTransition: PendingScopeTransition | null;
  followSnapshot: FollowSnapshot;
  scrollFrameId: number | null;
  scrollRetryTimerId: number | null;
  anchorRestoreFrameId: number | null;
  anchorCaptureTimerId: number | null;
  programmaticScroll: boolean;
}

const EMPTY_FOLLOW_SNAPSHOT: FollowSnapshot = {
  viewportHeight: null,
  viewportWidth: null,
  scrollHeight: null,
  tailMetrics: null,
};

export function isChatViewportNearBottom(
  metrics: ChatViewportMetrics,
  thresholdPx: number,
): boolean {
  const distanceToBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distanceToBottom <= thresholdPx;
}

export function computeBottomLockedScrollTopOnResize(
  _previousMetrics: ChatViewportMetrics,
  nextMetrics: ChatViewportMetrics,
): number {
  return Math.max(0, nextMetrics.scrollHeight - nextMetrics.clientHeight);
}

function readViewportMetrics(viewport: HTMLDivElement | null): ChatViewportMetrics | null {
  if (!viewport) {
    return null;
  }
  return {
    scrollHeight: viewport.scrollHeight,
    scrollTop: viewport.scrollTop,
    clientHeight: viewport.clientHeight,
    clientWidth: viewport.clientWidth,
  };
}

function hasRenderableChatRows(
  content: HTMLDivElement | null,
  viewport: HTMLDivElement | null,
): boolean {
  if (content?.querySelector('[data-chat-row-key]') != null) {
    return true;
  }
  return viewport?.querySelector('[data-chat-row-key]') != null;
}

function sampleViewportAnchor(viewport: HTMLDivElement | null): ViewportAnchor | null {
  if (!viewport) {
    return null;
  }
  const viewportRect = viewport.getBoundingClientRect();
  const rows = viewport.querySelectorAll<HTMLElement>('[data-chat-row-key]');
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const intersectsViewport = rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
    if (!intersectsViewport) {
      continue;
    }
    const messageId = typeof row.dataset.chatMessageId === 'string' && row.dataset.chatMessageId.trim()
      ? row.dataset.chatMessageId
      : undefined;
    const timestampText = row.dataset.chatMessageTimestamp;
    const timestamp = typeof timestampText === 'string' && timestampText.trim()
      ? Number(timestampText)
      : undefined;
    return {
      messageId,
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
      offsetWithinViewport: rect.top - viewportRect.top,
    };
  }
  return null;
}

function sampleTailMessageMetrics(viewport: HTMLDivElement | null): TailMessageMetrics | null {
  if (!viewport) {
    return null;
  }
  const rows = viewport.querySelectorAll<HTMLElement>('[data-chat-row-key]');
  const tailRow = rows.length > 0 ? rows[rows.length - 1] : null;
  const rowKey = tailRow?.dataset.chatRowKey;
  if (!tailRow || !rowKey) {
    return null;
  }
  return {
    rowKey,
    height: tailRow.getBoundingClientRect().height,
  };
}

function hasTailResizeDelta(
  previous: TailMessageMetrics | null,
  next: TailMessageMetrics | null,
): boolean {
  if (!previous || !next) {
    return previous !== next;
  }
  return previous.rowKey !== next.rowKey || previous.height !== next.height;
}

function createInitialScopeState(): ScrollScopeState {
  return {
    hasLoaded: false,
    isBottomLocked: true,
    anchor: null,
    anchorDirty: false,
  };
}

export function createChatScrollController(
  getConfig: () => ChatScrollControllerConfig,
): ChatScrollController {
  const initialConfig = getConfig();
  const state: ScrollControllerState = {
    isBottomLocked: true,
    lastScopeKey: initialConfig.scrollScopeKey,
    scopeStateByScope: new Map([[initialConfig.scrollScopeKey, createInitialScopeState()]]),
    pendingScopeTransition: null,
    followSnapshot: EMPTY_FOLLOW_SNAPSHOT,
    scrollFrameId: null,
    scrollRetryTimerId: null,
    anchorRestoreFrameId: null,
    anchorCaptureTimerId: null,
    programmaticScroll: false,
  };

  const ensureScopeState = (scopeKey: string): ScrollScopeState => {
    const existing = state.scopeStateByScope.get(scopeKey);
    if (existing) {
      return existing;
    }
    const next = createInitialScopeState();
    state.scopeStateByScope.set(scopeKey, next);
    return next;
  };

  const clearScheduledDetachedAnchorCapture = () => {
    if (state.anchorCaptureTimerId == null || typeof window === 'undefined') {
      return;
    }
    window.clearTimeout(state.anchorCaptureTimerId);
    state.anchorCaptureTimerId = null;
  };

  const setBottomLockedForCurrentScope = (nextValue: boolean) => {
    const config = getConfig();
    const scopeState = ensureScopeState(config.scrollScopeKey);
    scopeState.isBottomLocked = nextValue;
    if (nextValue) {
      clearScheduledDetachedAnchorCapture();
      scopeState.anchor = null;
      scopeState.anchorDirty = false;
    }
    if (state.isBottomLocked === nextValue) {
      return;
    }
    state.isBottomLocked = nextValue;
    config.setScrollChromeBottomLocked(nextValue);
  };

  const markScopeLoaded = () => {
    const config = getConfig();
    ensureScopeState(config.scrollScopeKey).hasLoaded = true;
  };

  const syncDetachedViewportAnchor = () => {
    const config = getConfig();
    const anchor = sampleViewportAnchor(config.viewportRef.current);
    const scopeState = ensureScopeState(config.scrollScopeKey);
    scopeState.anchor = anchor;
    scopeState.anchorDirty = false;
    return anchor;
  };

  const syncFollowSnapshot = () => {
    const { viewportRef } = getConfig();
    const viewport = viewportRef.current;
    state.followSnapshot = {
      viewportHeight: viewport?.clientHeight ?? null,
      viewportWidth: viewport?.clientWidth ?? null,
      scrollHeight: viewport?.scrollHeight ?? null,
      tailMetrics: sampleTailMessageMetrics(viewport),
    };
  };

  const clearScheduledBottomAlign = () => {
    if (typeof window !== 'undefined') {
      if (state.scrollFrameId != null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(state.scrollFrameId);
      }
      if (state.scrollRetryTimerId != null) {
        window.clearTimeout(state.scrollRetryTimerId);
      }
    }
    state.scrollFrameId = null;
    state.scrollRetryTimerId = null;
  };

  const clearScheduledAnchorRestore = () => {
    if (typeof window !== 'undefined' && state.anchorRestoreFrameId != null && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(state.anchorRestoreFrameId);
    }
    state.anchorRestoreFrameId = null;
  };

  const scheduleProgrammaticScrollCleanup = (onComplete?: () => void) => {
    const complete = () => {
      state.programmaticScroll = false;
      onComplete?.();
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(complete);
      return;
    }
    setTimeout(complete, 16);
  };

  const scheduleDetachedAnchorCapture = () => {
    clearScheduledDetachedAnchorCapture();
    if (typeof window === 'undefined') {
      return;
    }
    state.anchorCaptureTimerId = window.setTimeout(() => {
      state.anchorCaptureTimerId = null;
      const config = getConfig();
      const scopeState = ensureScopeState(config.scrollScopeKey);
      if (scopeState.isBottomLocked || !scopeState.anchorDirty) {
        return;
      }
      syncDetachedViewportAnchor();
    }, DETACHED_ANCHOR_CAPTURE_IDLE_MS);
  };

  const restoreViewportAnchor = (anchor: ViewportAnchor) => {
    const config = getConfig();
    if (!config.enabled) {
      return false;
    }
    const viewport = config.viewportRef.current;
    if (!viewport) {
      return false;
    }
    const messageRows = Array.from(
      viewport.querySelectorAll<HTMLElement>('[data-chat-row-key]'),
    );
    let target: HTMLElement | undefined;
    if (anchor.messageId) {
      target = messageRows.find((element) => element.dataset.chatMessageId === anchor.messageId);
    }
    if (!target && typeof anchor.timestamp === 'number') {
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const element of messageRows) {
        const timestampText = element.dataset.chatMessageTimestamp;
        const timestamp = typeof timestampText === 'string' && timestampText.trim()
          ? Number(timestampText)
          : NaN;
        if (!Number.isFinite(timestamp)) {
          continue;
        }
        const distance = Math.abs(timestamp - anchor.timestamp);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          target = element;
        }
      }
    }
    if (!target) {
      return false;
    }
    const viewportRect = viewport.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    state.programmaticScroll = true;
    viewport.scrollTop += (targetRect.top - viewportRect.top) - anchor.offsetWithinViewport;
    scheduleProgrammaticScrollCleanup();
    return true;
  };

  const syncScrollContainerState = () => {
    const config = getConfig();
    const viewport = config.viewportRef.current;
    const syncContainer = viewport?.closest<HTMLElement>('.chat-scroll-sync');
    if (!syncContainer) {
      return;
    }
    const metrics = readViewportMetrics(viewport);
    syncContainer.dataset.chatScrollPhase = state.isBottomLocked ? 'following' : 'detached';
    syncContainer.dataset.chatScrollLocked = state.isBottomLocked ? 'true' : 'false';
    syncContainer.dataset.chatScrollOverflow = (
      metrics != null && metrics.scrollHeight > metrics.clientHeight
    ) ? 'true' : 'false';
    syncContainer.dataset.chatScrollScope = config.scrollScopeKey;
  };

  const applyBottomAlign = (force = false) => {
    const config = getConfig();
    const viewport = config.viewportRef.current;
    if (!config.enabled || !viewport || !hasRenderableChatRows(config.contentRef.current, viewport)) {
      return false;
    }
    const metrics = readViewportMetrics(viewport);
    if (!metrics) {
      return false;
    }
    const shouldStick = force || state.isBottomLocked || isChatViewportNearBottom(metrics, config.stickyBottomThresholdPx);
    if (!shouldStick) {
      return false;
    }
    markScopeLoaded();
    setBottomLockedForCurrentScope(true);
    state.programmaticScroll = true;
    viewport.scrollTop = computeBottomLockedScrollTopOnResize(metrics, metrics);
    scheduleProgrammaticScrollCleanup(() => {
      syncFollowSnapshot();
      syncScrollContainerState();
    });
    return true;
  };

  const scheduleBottomAlignRetry = (force: boolean) => {
    if (typeof window === 'undefined') {
      return;
    }
    state.scrollRetryTimerId = window.setTimeout(() => {
      state.scrollRetryTimerId = null;
      applyBottomAlign(force);
    }, force ? INITIAL_ALIGN_RETRY_MS : FOLLOW_RETRY_MS);
  };

  const scheduleBottomAlign = (options?: { force?: boolean; retry?: boolean; immediate?: boolean }) => {
    clearScheduledBottomAlign();
    const force = Boolean(options?.force);
    const retry = Boolean(options?.retry);
    const run = () => {
      if (!applyBottomAlign(force)) {
        return false;
      }
      if (retry) {
        scheduleBottomAlignRetry(force);
      }
      return true;
    };

    if (Boolean(options?.immediate) && run()) {
      return;
    }

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      state.scrollFrameId = window.requestAnimationFrame(() => {
        state.scrollFrameId = null;
        run();
      });
      return;
    }
    run();
  };

  const scheduleAnchorRestore = (anchor: ViewportAnchor) => {
    clearScheduledAnchorRestore();
    const run = () => {
      const config = getConfig();
      if (!config.enabled || !hasRenderableChatRows(config.contentRef.current, config.viewportRef.current)) {
        return;
      }
      if (!restoreViewportAnchor(anchor)) {
        return;
      }
      const scopeState = ensureScopeState(config.scrollScopeKey);
      scopeState.hasLoaded = true;
      scopeState.isBottomLocked = false;
      state.pendingScopeTransition = null;
      if (state.isBottomLocked !== false) {
        state.isBottomLocked = false;
        config.setScrollChromeBottomLocked(false);
      }
      syncDetachedViewportAnchor();
      syncFollowSnapshot();
      syncScrollContainerState();
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      state.anchorRestoreFrameId = window.requestAnimationFrame(() => {
        state.anchorRestoreFrameId = null;
        run();
      });
      return;
    }
    run();
  };

  const cancelPendingTransitionForScope = (scopeKey: string) => {
    const pending = state.pendingScopeTransition;
    if (!pending || pending.targetScopeKey !== scopeKey) {
      return;
    }
    state.pendingScopeTransition = null;
    clearScheduledAnchorRestore();
  };

  const markDetachedAnchorDirty = () => {
    const config = getConfig();
    const scopeState = ensureScopeState(config.scrollScopeKey);
    scopeState.anchorDirty = true;
    scheduleDetachedAnchorCapture();
  };

  const handlePendingTransitionForCurrentScope = () => {
    const config = getConfig();
    const pending = state.pendingScopeTransition;
    if (!pending || pending.targetScopeKey !== config.scrollScopeKey) {
      return false;
    }
    if (pending.mode === 'force-bottom') {
      state.pendingScopeTransition = null;
      scheduleBottomAlign({ force: true, retry: true, immediate: true });
      return true;
    }
    if (pending.anchor) {
      scheduleAnchorRestore(pending.anchor);
      return true;
    }
    return false;
  };

  const detachFromBottom = () => {
    const config = getConfig();
    cancelPendingTransitionForScope(config.scrollScopeKey);
    const scopeState = ensureScopeState(config.scrollScopeKey);
    const wasBottomLocked = scopeState.isBottomLocked;
    scopeState.isBottomLocked = false;
    scopeState.anchorDirty = true;
    if (state.isBottomLocked !== false) {
      state.isBottomLocked = false;
      config.setScrollChromeBottomLocked(false);
    }
    if (wasBottomLocked) {
      scheduleDetachedAnchorCapture();
    }
    syncScrollContainerState();
  };

  const onScopeRenderSync = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    const scopeChanged = state.lastScopeKey !== config.scrollScopeKey;
    state.lastScopeKey = config.scrollScopeKey;
    if (!scopeChanged) {
      return;
    }

    clearScheduledBottomAlign();
    clearScheduledAnchorRestore();
    clearScheduledDetachedAnchorCapture();
    state.followSnapshot = EMPTY_FOLLOW_SNAPSHOT;

    if (handlePendingTransitionForCurrentScope()) {
      return;
    }

    const scopeState = ensureScopeState(config.scrollScopeKey);
    state.isBottomLocked = scopeState.isBottomLocked;
    config.setScrollChromeBottomLocked(scopeState.isBottomLocked);

    if (!scopeState.hasLoaded || scopeState.isBottomLocked) {
      scheduleBottomAlign({ force: !scopeState.hasLoaded, retry: true });
      return;
    }

    if (scopeState.anchor) {
      scheduleAnchorRestore(scopeState.anchor);
    }
  };

  const onTailActivityRenderSync = () => {
    const config = getConfig();
    if (!config.enabled || !config.tailActivityOpen) {
      return;
    }
    if (state.isBottomLocked) {
      scheduleBottomAlign({ retry: true });
    }
  };

  const onAutoFollowRenderSync = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    if (handlePendingTransitionForCurrentScope()) {
      return;
    }
    const scopeState = ensureScopeState(config.scrollScopeKey);
    if (!hasRenderableChatRows(config.contentRef.current, config.viewportRef.current)) {
      return;
    }
    if (!scopeState.hasLoaded) {
      scheduleBottomAlign({ force: true, retry: true });
      return;
    }
    if (scopeState.isBottomLocked) {
      scheduleBottomAlign({ retry: config.tailActivityOpen });
    }
  };

  const onResizeObserved = () => {
    const config = getConfig();
    if (handlePendingTransitionForCurrentScope()) {
      return;
    }

    const viewportNode = config.viewportRef.current;
    const contentNode = config.contentRef.current;
    const scopeState = ensureScopeState(config.scrollScopeKey);
    const nextSnapshot: FollowSnapshot = {
      viewportHeight: viewportNode?.clientHeight ?? null,
      viewportWidth: viewportNode?.clientWidth ?? null,
      scrollHeight: viewportNode?.scrollHeight ?? null,
      tailMetrics: sampleTailMessageMetrics(viewportNode),
    };
    const previousSnapshot = state.followSnapshot;
    state.followSnapshot = nextSnapshot;

    const viewportHeightChanged = (
      nextSnapshot.viewportHeight != null
      && previousSnapshot.viewportHeight != null
      && nextSnapshot.viewportHeight !== previousSnapshot.viewportHeight
    );
    const viewportWidthChanged = (
      nextSnapshot.viewportWidth != null
      && previousSnapshot.viewportWidth != null
      && nextSnapshot.viewportWidth !== previousSnapshot.viewportWidth
    );
    const scrollHeightChanged = (
      nextSnapshot.scrollHeight != null
      && previousSnapshot.scrollHeight != null
      && nextSnapshot.scrollHeight !== previousSnapshot.scrollHeight
    );
    const tailMetricsChanged = hasTailResizeDelta(previousSnapshot.tailMetrics, nextSnapshot.tailMetrics);

    if (!scopeState.hasLoaded && hasRenderableChatRows(contentNode, viewportNode)) {
      scheduleBottomAlign({ force: true, retry: true });
      syncScrollContainerState();
      return;
    }

    if (scopeState.isBottomLocked) {
      if (viewportHeightChanged || viewportWidthChanged) {
        scheduleBottomAlign({ force: true });
        syncScrollContainerState();
        return;
      }
      if (config.tailActivityOpen && (scrollHeightChanged || tailMetricsChanged)) {
        scheduleBottomAlign();
      }
      syncScrollContainerState();
      return;
    }

    if (viewportHeightChanged || viewportWidthChanged || scrollHeightChanged) {
      const anchor = scopeState.anchorDirty ? syncDetachedViewportAnchor() : scopeState.anchor;
      if (anchor) {
        scheduleAnchorRestore(anchor);
        return;
      }
    }

    if (scopeState.anchorDirty) {
      scheduleDetachedAnchorCapture();
      return;
    }

    syncScrollContainerState();
  };

  const handleViewportScroll = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    const metrics = readViewportMetrics(config.viewportRef.current);
    if (!metrics || state.programmaticScroll) {
      return;
    }
    markChatScrollActivity();
    if (isChatViewportNearBottom(metrics, config.stickyBottomThresholdPx)) {
      cancelPendingTransitionForScope(config.scrollScopeKey);
      setBottomLockedForCurrentScope(true);
      syncFollowSnapshot();
      syncScrollContainerState();
      return;
    }
    const scopeState = ensureScopeState(config.scrollScopeKey);
    if (scopeState.isBottomLocked) {
      detachFromBottom();
      return;
    }
    if (scopeState.anchorDirty && !scopeState.anchor) {
      syncDetachedViewportAnchor();
      return;
    }
    markDetachedAnchorDirty();
  };

  const handleViewportPointerDown = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    state.programmaticScroll = false;
  };

  const handleViewportTouchMove: TouchEventHandler<HTMLDivElement> = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    state.programmaticScroll = false;
    markChatScrollActivity();
    const scopeState = ensureScopeState(config.scrollScopeKey);
    if (scopeState.isBottomLocked) {
      detachFromBottom();
      return;
    }
    markDetachedAnchorDirty();
  };

  const handleViewportWheel: WheelEventHandler<HTMLDivElement> = (event) => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    state.programmaticScroll = false;
    markChatScrollActivity();
    if ((event?.deltaY ?? 0) < 0) {
      const scopeState = ensureScopeState(config.scrollScopeKey);
      if (scopeState.isBottomLocked) {
        detachFromBottom();
        return;
      }
      markDetachedAnchorDirty();
    }
  };

  const jumpToBottom = () => {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }
    cancelPendingTransitionForScope(config.scrollScopeKey);
    clearScheduledDetachedAnchorCapture();
    scheduleBottomAlign({ force: true, retry: true, immediate: true });
  };

  const prepareScopeAnchorRestore = (nextScopeKey: string) => {
    if (!nextScopeKey) {
      return;
    }
    const anchor = syncDetachedViewportAnchor();
    if (!anchor) {
      return;
    }
    state.pendingScopeTransition = {
      targetScopeKey: nextScopeKey,
      mode: 'restore-anchor',
      anchor,
    };
  };

  const prepareScopeBottomAlign = (nextScopeKey: string) => {
    if (!nextScopeKey) {
      return;
    }
    state.pendingScopeTransition = {
      targetScopeKey: nextScopeKey,
      mode: 'force-bottom',
    };
  };

  const cleanup = () => {
    clearScheduledBottomAlign();
    clearScheduledAnchorRestore();
    clearScheduledDetachedAnchorCapture();
  };

  return {
    onScopeRenderSync,
    onTailActivityRenderSync,
    onAutoFollowRenderSync,
    onResizeObserved,
    syncChromeRender: syncScrollContainerState,
    handleViewportScroll,
    handleViewportPointerDown,
    handleViewportTouchMove,
    handleViewportWheel,
    prepareScopeAnchorRestore,
    prepareScopeBottomAlign,
    jumpToBottom,
    cleanup,
  };
}
