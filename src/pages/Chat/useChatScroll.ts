import { useCallback, useLayoutEffect, useRef, type TouchEventHandler } from 'react';
import { markChatScrollActivity } from './chat-scroll-drain';

interface UseChatScrollInput {
  enabled: boolean;
  scrollScopeKey: string;
  autoFollowSignal: string;
  tailActivityOpen: boolean;
  setScrollChromeBottomLocked: (isBottomLocked: boolean) => void;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  stickyBottomThresholdPx: number;
}

type ScopeTransitionMode = 'restore-anchor' | 'force-bottom';

const INITIAL_ALIGN_RETRY_MS = 150;
const FOLLOW_RETRY_MS = 120;
const TAIL_SETTLE_IDLE_MS = 220;
const DETACHED_ANCHOR_CAPTURE_IDLE_MS = 90;

interface ChatViewportMetrics {
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
  const rows = viewport.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]');
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
  const rows = viewport.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]');
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

export function useChatScroll({
  enabled,
  scrollScopeKey,
  autoFollowSignal,
  tailActivityOpen,
  setScrollChromeBottomLocked,
  viewportRef,
  contentRef,
  stickyBottomThresholdPx,
}: UseChatScrollInput) {
  const isBottomLockedRef = useRef(true);
  const lastScopeKeyRef = useRef(scrollScopeKey);
  const scopeStateByScopeRef = useRef<Map<string, ScrollScopeState>>(
    new Map([[scrollScopeKey, {
      hasLoaded: false,
      isBottomLocked: true,
      anchor: null,
      anchorDirty: false,
    }]]),
  );
  const pendingScopeTransitionRef = useRef<PendingScopeTransition | null>(null);
  const followSnapshotRef = useRef<FollowSnapshot>(EMPTY_FOLLOW_SNAPSHOT);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollRetryTimerRef = useRef<number | null>(null);
  const anchorRestoreFrameRef = useRef<number | null>(null);
  const anchorCaptureTimerRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef(false);
  const tailFollowUntilRef = useRef(0);
  const tailFollowTimerRef = useRef<number | null>(null);
  const previousTailActivityOpenRef = useRef(tailActivityOpen);

  const nowMs = useCallback(() => {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }, []);

  const ensureScopeState = useCallback((scopeKey: string): ScrollScopeState => {
    const existing = scopeStateByScopeRef.current.get(scopeKey);
    if (existing) {
      return existing;
    }
    const next: ScrollScopeState = {
      hasLoaded: false,
      isBottomLocked: true,
      anchor: null,
      anchorDirty: false,
    };
    scopeStateByScopeRef.current.set(scopeKey, next);
    return next;
  }, []);

  const clearScheduledDetachedAnchorCapture = useCallback(() => {
    if (anchorCaptureTimerRef.current == null || typeof window === 'undefined') {
      return;
    }
    window.clearTimeout(anchorCaptureTimerRef.current);
    anchorCaptureTimerRef.current = null;
  }, []);

  const setBottomLockedForCurrentScope = useCallback((nextValue: boolean) => {
    const scopeState = ensureScopeState(scrollScopeKey);
    scopeState.isBottomLocked = nextValue;
    if (nextValue) {
      clearScheduledDetachedAnchorCapture();
      scopeState.anchor = null;
      scopeState.anchorDirty = false;
    }
    if (isBottomLockedRef.current !== nextValue) {
      isBottomLockedRef.current = nextValue;
      setScrollChromeBottomLocked(nextValue);
      return;
    }
    isBottomLockedRef.current = nextValue;
  }, [clearScheduledDetachedAnchorCapture, ensureScopeState, scrollScopeKey, setScrollChromeBottomLocked]);

  const markScopeLoaded = useCallback(() => {
    ensureScopeState(scrollScopeKey).hasLoaded = true;
  }, [ensureScopeState, scrollScopeKey]);

  const syncDetachedViewportAnchor = useCallback(() => {
    const anchor = sampleViewportAnchor(viewportRef.current);
    const scopeState = ensureScopeState(scrollScopeKey);
    scopeState.anchor = anchor;
    scopeState.anchorDirty = false;
    return anchor;
  }, [ensureScopeState, scrollScopeKey, viewportRef]);

  const syncFollowSnapshot = useCallback(() => {
    const viewport = viewportRef.current;
    followSnapshotRef.current = {
      viewportHeight: viewport?.clientHeight ?? null,
      viewportWidth: viewport?.clientWidth ?? null,
      scrollHeight: viewport?.scrollHeight ?? null,
      tailMetrics: sampleTailMessageMetrics(viewport),
    };
  }, [viewportRef]);

  const clearScheduledBottomAlign = useCallback(() => {
    if (typeof window !== 'undefined') {
      if (scrollFrameRef.current != null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      if (scrollRetryTimerRef.current != null) {
        window.clearTimeout(scrollRetryTimerRef.current);
      }
    }
    scrollFrameRef.current = null;
    scrollRetryTimerRef.current = null;
  }, []);

  const clearScheduledAnchorRestore = useCallback(() => {
    if (typeof window !== 'undefined' && anchorRestoreFrameRef.current != null && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(anchorRestoreFrameRef.current);
    }
    anchorRestoreFrameRef.current = null;
  }, []);

  const clearTailFollowWindow = useCallback(() => {
    tailFollowUntilRef.current = 0;
    if (tailFollowTimerRef.current == null || typeof window === 'undefined') {
      return;
    }
    window.clearTimeout(tailFollowTimerRef.current);
    tailFollowTimerRef.current = null;
  }, []);

  const armTailFollowWindow = useCallback(() => {
    tailFollowUntilRef.current = nowMs() + TAIL_SETTLE_IDLE_MS;
    if (typeof window === 'undefined') {
      return;
    }
    if (tailFollowTimerRef.current != null) {
      window.clearTimeout(tailFollowTimerRef.current);
    }
    tailFollowTimerRef.current = window.setTimeout(() => {
      tailFollowUntilRef.current = 0;
      tailFollowTimerRef.current = null;
    }, TAIL_SETTLE_IDLE_MS);
  }, [nowMs]);

  const hasTailFollowWork = useCallback(() => {
    return tailActivityOpen || tailFollowUntilRef.current > nowMs();
  }, [nowMs, tailActivityOpen]);

  const scheduleProgrammaticScrollCleanup = useCallback((onComplete?: () => void) => {
    const complete = () => {
      programmaticScrollRef.current = false;
      onComplete?.();
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(complete);
      return;
    }
    setTimeout(complete, 16);
  }, []);

  const scheduleDetachedAnchorCapture = useCallback(() => {
    clearScheduledDetachedAnchorCapture();
    if (typeof window === 'undefined') {
      return;
    }
    anchorCaptureTimerRef.current = window.setTimeout(() => {
      anchorCaptureTimerRef.current = null;
      const scopeState = ensureScopeState(scrollScopeKey);
      if (scopeState.isBottomLocked || !scopeState.anchorDirty) {
        return;
      }
      syncDetachedViewportAnchor();
    }, DETACHED_ANCHOR_CAPTURE_IDLE_MS);
  }, [clearScheduledDetachedAnchorCapture, ensureScopeState, scrollScopeKey, syncDetachedViewportAnchor]);

  const restoreViewportAnchor = useCallback((anchor: ViewportAnchor) => {
    if (!enabled) {
      return false;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return false;
    }
    const messageRows = Array.from(
      viewport.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'),
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
    programmaticScrollRef.current = true;
    viewport.scrollTop += (targetRect.top - viewportRect.top) - anchor.offsetWithinViewport;
    scheduleProgrammaticScrollCleanup();
    return true;
  }, [enabled, scheduleProgrammaticScrollCleanup, viewportRef]);

  const syncScrollContainerState = useCallback(() => {
    const viewport = viewportRef.current;
    const syncContainer = viewport?.closest<HTMLElement>('.chat-scroll-sync');
    if (!syncContainer) {
      return;
    }
    const metrics = readViewportMetrics(viewport);
    syncContainer.dataset.chatScrollPhase = isBottomLockedRef.current ? 'following' : 'detached';
    syncContainer.dataset.chatScrollLocked = isBottomLockedRef.current ? 'true' : 'false';
    syncContainer.dataset.chatScrollOverflow = (
      metrics != null && metrics.scrollHeight > metrics.clientHeight
    ) ? 'true' : 'false';
    syncContainer.dataset.chatScrollScope = scrollScopeKey;
  }, [scrollScopeKey, viewportRef]);

  const scheduleBottomAlign = useCallback((options?: { force?: boolean; retry?: boolean }) => {
    clearScheduledBottomAlign();
    const force = Boolean(options?.force);
    const retry = Boolean(options?.retry);
    const run = () => {
      const viewport = viewportRef.current;
      if (!enabled || !viewport || !hasRenderableChatRows(contentRef.current, viewport)) {
        return;
      }
      const metrics = readViewportMetrics(viewport);
      if (!metrics) {
        return;
      }
      const shouldStick = force || isBottomLockedRef.current || isChatViewportNearBottom(metrics, stickyBottomThresholdPx);
      if (!shouldStick) {
        return;
      }
      markScopeLoaded();
      setBottomLockedForCurrentScope(true);
      programmaticScrollRef.current = true;
      viewport.scrollTop = computeBottomLockedScrollTopOnResize(metrics, metrics);
      scheduleProgrammaticScrollCleanup(() => {
        syncFollowSnapshot();
        syncScrollContainerState();
      });
      if (!retry || typeof window === 'undefined') {
        return;
      }
      scrollRetryTimerRef.current = window.setTimeout(() => {
        scrollRetryTimerRef.current = null;
        const latestViewport = viewportRef.current;
        const latestMetrics = readViewportMetrics(latestViewport);
        if (!latestViewport || !latestMetrics) {
          return;
        }
        const shouldRetryStick = force || isBottomLockedRef.current || isChatViewportNearBottom(latestMetrics, stickyBottomThresholdPx);
        if (!shouldRetryStick) {
          return;
        }
        programmaticScrollRef.current = true;
        latestViewport.scrollTop = computeBottomLockedScrollTopOnResize(latestMetrics, latestMetrics);
        scheduleProgrammaticScrollCleanup(() => {
          syncFollowSnapshot();
          syncScrollContainerState();
        });
      }, force ? INITIAL_ALIGN_RETRY_MS : FOLLOW_RETRY_MS);
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        run();
      });
      return;
    }
    run();
  }, [
    clearScheduledBottomAlign,
    contentRef,
    enabled,
    markScopeLoaded,
    scheduleProgrammaticScrollCleanup,
    setBottomLockedForCurrentScope,
    stickyBottomThresholdPx,
    syncFollowSnapshot,
    syncScrollContainerState,
    viewportRef,
  ]);

  const scheduleAnchorRestore = useCallback((anchor: ViewportAnchor) => {
    clearScheduledAnchorRestore();
    const run = () => {
      if (!enabled || !hasRenderableChatRows(contentRef.current, viewportRef.current)) {
        return;
      }
      if (!restoreViewportAnchor(anchor)) {
        return;
      }
      const scopeState = ensureScopeState(scrollScopeKey);
      scopeState.hasLoaded = true;
      scopeState.isBottomLocked = false;
      pendingScopeTransitionRef.current = null;
      if (isBottomLockedRef.current !== false) {
        isBottomLockedRef.current = false;
        setScrollChromeBottomLocked(false);
      }
      syncDetachedViewportAnchor();
      syncFollowSnapshot();
      syncScrollContainerState();
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      anchorRestoreFrameRef.current = window.requestAnimationFrame(() => {
        anchorRestoreFrameRef.current = null;
        run();
      });
      return;
    }
    run();
  }, [
    clearScheduledAnchorRestore,
    contentRef,
    enabled,
    ensureScopeState,
    restoreViewportAnchor,
    scrollScopeKey,
    syncDetachedViewportAnchor,
    syncFollowSnapshot,
    syncScrollContainerState,
    viewportRef,
  ]);

  const cancelPendingTransitionForScope = useCallback((scopeKey: string) => {
    const pending = pendingScopeTransitionRef.current;
    if (!pending || pending.targetScopeKey !== scopeKey) {
      return;
    }
    pendingScopeTransitionRef.current = null;
    clearScheduledAnchorRestore();
  }, [clearScheduledAnchorRestore]);

  const markDetachedAnchorDirty = useCallback(() => {
    const scopeState = ensureScopeState(scrollScopeKey);
    scopeState.anchorDirty = true;
    scheduleDetachedAnchorCapture();
  }, [ensureScopeState, scheduleDetachedAnchorCapture, scrollScopeKey]);

  const handlePendingTransitionForCurrentScope = useCallback(() => {
    const pending = pendingScopeTransitionRef.current;
    if (!pending || pending.targetScopeKey !== scrollScopeKey) {
      return false;
    }
    if (pending.mode === 'force-bottom') {
      pendingScopeTransitionRef.current = null;
      scheduleBottomAlign({ force: true, retry: true });
      return true;
    }
    if (pending.anchor) {
      scheduleAnchorRestore(pending.anchor);
      return true;
    }
    return false;
  }, [scheduleAnchorRestore, scheduleBottomAlign, scrollScopeKey]);

  const detachFromBottom = useCallback(() => {
    cancelPendingTransitionForScope(scrollScopeKey);
    const scopeState = ensureScopeState(scrollScopeKey);
    const wasBottomLocked = scopeState.isBottomLocked;
    scopeState.isBottomLocked = false;
    scopeState.anchorDirty = true;
    if (isBottomLockedRef.current !== false) {
      isBottomLockedRef.current = false;
      setScrollChromeBottomLocked(false);
    }
    if (wasBottomLocked) {
      scheduleDetachedAnchorCapture();
    }
    syncScrollContainerState();
  }, [
    cancelPendingTransitionForScope,
    ensureScopeState,
    scheduleDetachedAnchorCapture,
    scrollScopeKey,
    setScrollChromeBottomLocked,
    syncScrollContainerState,
  ]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const scopeChanged = lastScopeKeyRef.current !== scrollScopeKey;
    lastScopeKeyRef.current = scrollScopeKey;
    if (!scopeChanged) {
      return;
    }

    clearScheduledBottomAlign();
    clearScheduledAnchorRestore();
    clearScheduledDetachedAnchorCapture();
    clearTailFollowWindow();
    followSnapshotRef.current = EMPTY_FOLLOW_SNAPSHOT;

    if (handlePendingTransitionForCurrentScope()) {
      return;
    }

    const scopeState = ensureScopeState(scrollScopeKey);
    isBottomLockedRef.current = scopeState.isBottomLocked;
    setScrollChromeBottomLocked(scopeState.isBottomLocked);

    if (!scopeState.hasLoaded || scopeState.isBottomLocked) {
      scheduleBottomAlign({ force: !scopeState.hasLoaded, retry: true });
      return;
    }

    if (scopeState.anchor) {
      scheduleAnchorRestore(scopeState.anchor);
    }
  }, [
    clearScheduledAnchorRestore,
    clearScheduledBottomAlign,
    clearScheduledDetachedAnchorCapture,
    clearTailFollowWindow,
    enabled,
    ensureScopeState,
    handlePendingTransitionForCurrentScope,
    scheduleAnchorRestore,
    scheduleBottomAlign,
    scrollScopeKey,
    setScrollChromeBottomLocked,
  ]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const previousTailActivityOpen = previousTailActivityOpenRef.current;
    previousTailActivityOpenRef.current = tailActivityOpen;

    if (tailActivityOpen) {
      clearTailFollowWindow();
      if (isBottomLockedRef.current) {
        scheduleBottomAlign({ retry: true });
      }
      return;
    }

    if (previousTailActivityOpen) {
      armTailFollowWindow();
      if (isBottomLockedRef.current) {
        scheduleBottomAlign({ retry: true });
      }
    }
  }, [
    armTailFollowWindow,
    clearTailFollowWindow,
    enabled,
    scheduleBottomAlign,
    tailActivityOpen,
  ]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    if (handlePendingTransitionForCurrentScope()) {
      return;
    }
    const scopeState = ensureScopeState(scrollScopeKey);
    if (!hasRenderableChatRows(contentRef.current, viewportRef.current)) {
      return;
    }
    if (!scopeState.hasLoaded) {
      scheduleBottomAlign({ force: true, retry: true });
      return;
    }
    if (scopeState.isBottomLocked) {
      scheduleBottomAlign({ retry: hasTailFollowWork() });
    }
  }, [
    autoFollowSignal,
    contentRef,
    enabled,
    ensureScopeState,
    handlePendingTransitionForCurrentScope,
    hasTailFollowWork,
    scheduleBottomAlign,
    scrollScopeKey,
    viewportRef,
  ]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (typeof ResizeObserver !== 'function' || (!viewport && !content)) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (handlePendingTransitionForCurrentScope()) {
        return;
      }

      const viewportNode = viewportRef.current;
      const contentNode = contentRef.current;
      const scopeState = ensureScopeState(scrollScopeKey);
      const nextSnapshot: FollowSnapshot = {
        viewportHeight: viewportNode?.clientHeight ?? null,
        viewportWidth: viewportNode?.clientWidth ?? null,
        scrollHeight: viewportNode?.scrollHeight ?? null,
        tailMetrics: sampleTailMessageMetrics(viewportNode),
      };
      const previousSnapshot = followSnapshotRef.current;
      followSnapshotRef.current = nextSnapshot;

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
        if (hasTailFollowWork() && (scrollHeightChanged || tailMetricsChanged)) {
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
    });

    if (viewport) {
      observer.observe(viewport);
    }
    if (content) {
      observer.observe(content);
    }

    return () => observer.disconnect();
  }, [
    contentRef,
    enabled,
    ensureScopeState,
    handlePendingTransitionForCurrentScope,
    hasTailFollowWork,
    scheduleAnchorRestore,
    scheduleDetachedAnchorCapture,
    scheduleBottomAlign,
    scrollScopeKey,
    syncDetachedViewportAnchor,
    syncScrollContainerState,
    viewportRef,
  ]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    syncScrollContainerState();
  }, [autoFollowSignal, enabled, scrollScopeKey, syncScrollContainerState]);

  const handleViewportScroll = useCallback(() => {
    if (!enabled) {
      return;
    }
    const metrics = readViewportMetrics(viewportRef.current);
    if (!metrics || programmaticScrollRef.current) {
      return;
    }
    markChatScrollActivity();
    if (isChatViewportNearBottom(metrics, stickyBottomThresholdPx)) {
      cancelPendingTransitionForScope(scrollScopeKey);
      setBottomLockedForCurrentScope(true);
      syncFollowSnapshot();
      syncScrollContainerState();
      return;
    }
    const scopeState = ensureScopeState(scrollScopeKey);
    if (scopeState.isBottomLocked) {
      detachFromBottom();
      return;
    }
    if (scopeState.anchorDirty && !scopeState.anchor) {
      syncDetachedViewportAnchor();
      return;
    }
    markDetachedAnchorDirty();
  }, [
    cancelPendingTransitionForScope,
    detachFromBottom,
    enabled,
    ensureScopeState,
    markDetachedAnchorDirty,
    scrollScopeKey,
    setBottomLockedForCurrentScope,
    stickyBottomThresholdPx,
    syncDetachedViewportAnchor,
    syncFollowSnapshot,
    syncScrollContainerState,
    viewportRef,
  ]);

  const handleViewportPointerDown = useCallback(() => {
    if (!enabled) {
      return;
    }
    programmaticScrollRef.current = false;
  }, [enabled]);

  const handleViewportTouchMove = useCallback<TouchEventHandler<HTMLDivElement>>(() => {
    if (!enabled) {
      return;
    }
    programmaticScrollRef.current = false;
    markChatScrollActivity();
    const scopeState = ensureScopeState(scrollScopeKey);
    if (scopeState.isBottomLocked) {
      detachFromBottom();
      return;
    }
    markDetachedAnchorDirty();
  }, [detachFromBottom, enabled, ensureScopeState, markDetachedAnchorDirty, scrollScopeKey]);

  const handleViewportWheel = useCallback((event?: { deltaY?: number }) => {
    if (!enabled) {
      return;
    }
    programmaticScrollRef.current = false;
    markChatScrollActivity();
    if ((event?.deltaY ?? 0) < 0) {
      const scopeState = ensureScopeState(scrollScopeKey);
      if (scopeState.isBottomLocked) {
        detachFromBottom();
        return;
      }
      markDetachedAnchorDirty();
    }
  }, [detachFromBottom, enabled, ensureScopeState, markDetachedAnchorDirty, scrollScopeKey]);

  const jumpToBottom = useCallback(() => {
    if (!enabled) {
      return;
    }
    cancelPendingTransitionForScope(scrollScopeKey);
    clearTailFollowWindow();
    clearScheduledDetachedAnchorCapture();
    scheduleBottomAlign({ force: true, retry: true });
    if (!tailActivityOpen) {
      armTailFollowWindow();
    }
  }, [
    armTailFollowWindow,
    cancelPendingTransitionForScope,
    clearScheduledDetachedAnchorCapture,
    clearTailFollowWindow,
    enabled,
    scheduleBottomAlign,
    scrollScopeKey,
    tailActivityOpen,
  ]);

  useLayoutEffect(() => {
    return () => {
      clearScheduledBottomAlign();
      clearScheduledAnchorRestore();
      clearScheduledDetachedAnchorCapture();
      clearTailFollowWindow();
    };
  }, [clearScheduledAnchorRestore, clearScheduledBottomAlign, clearScheduledDetachedAnchorCapture, clearTailFollowWindow]);

  return {
    handleViewportScroll,
    handleViewportPointerDown,
    handleViewportTouchMove,
    handleViewportWheel,
    prepareScopeAnchorRestore: (nextScopeKey: string) => {
      if (!nextScopeKey) {
        return;
      }
      const anchor = syncDetachedViewportAnchor();
      if (!anchor) {
        return;
      }
      pendingScopeTransitionRef.current = {
        targetScopeKey: nextScopeKey,
        mode: 'restore-anchor',
        anchor,
      };
    },
    prepareScopeBottomAlign: (nextScopeKey: string) => {
      if (!nextScopeKey) {
        return;
      }
      pendingScopeTransitionRef.current = {
        targetScopeKey: nextScopeKey,
        mode: 'force-bottom',
      };
      if (nextScopeKey === scrollScopeKey) {
        scheduleBottomAlign({ force: true, retry: true });
      }
    },
    jumpToBottom,
  };
}
