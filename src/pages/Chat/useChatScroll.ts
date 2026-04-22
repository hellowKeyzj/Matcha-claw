import { useCallback, useLayoutEffect, useRef, useState, type TouchEventHandler } from 'react';
import { markChatScrollActivity } from './chat-scroll-drain';

interface UseChatScrollInput {
  scrollScopeKey: string;
  scrollResetKey: string;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  stickyBottomThresholdPx: number;
}

type ScrollDirection = -1 | 0 | 1;
type ScrollPhase = 'initial' | 'following' | 'detached';
type ScopeTransitionMode = 'restore-anchor' | 'force-bottom';

const SCROLL_IDLE_TIMEOUT_MS = 160;
const WHEEL_INTENT_WINDOW_MS = 220;
const INITIAL_ALIGN_RETRY_MS = 150;
const ANCHOR_RESTORE_RETRY_MS = 150;

interface ChatViewportMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

interface ViewportAnchor {
  messageId?: string;
  timestamp?: number;
  offsetWithinViewport: number;
}

interface PendingScopeTransition {
  targetScopeKey: string;
  mode: ScopeTransitionMode;
  anchor?: ViewportAnchor;
}

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
  };
}

function hasRenderableChatRows(content: HTMLDivElement | null): boolean {
  if (!content) {
    return false;
  }
  return content.querySelector('[data-chat-row-key]') != null;
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

export function useChatScroll({
  scrollScopeKey,
  scrollResetKey,
  viewportRef,
  contentRef,
  stickyBottomThresholdPx,
}: UseChatScrollInput) {
  const [isBottomLocked, setIsBottomLocked] = useState(true);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [scrollDirection, setScrollDirection] = useState<ScrollDirection>(0);
  const [scrollEventSeq, setScrollEventSeq] = useState(0);
  const isBottomLockedRef = useRef(true);
  const lastScrollScopeKeyRef = useRef(scrollScopeKey);
  const lastScrollResetKeyRef = useRef(scrollResetKey);
  const programmaticScrollRef = useRef(false);
  const lastUserScrollTopRef = useRef<number | null>(null);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const pointerScrollActiveRef = useRef(false);
  const touchScrollActiveRef = useRef(false);
  const wheelIntentUntilRef = useRef(0);
  const initialAlignFrameRef = useRef<number | null>(null);
  const initialAlignRetryTimerRef = useRef<number | null>(null);
  const anchorRestoreFrameRef = useRef<number | null>(null);
  const anchorRestoreRetryTimerRef = useRef<number | null>(null);
  const scrollPhaseBySessionRef = useRef<Map<string, ScrollPhase>>(
    new Map([[scrollScopeKey, 'initial']]),
  );
  const pendingScopeTransitionRef = useRef<PendingScopeTransition | null>(null);

  const setBottomLocked = useCallback((next: boolean) => {
    isBottomLockedRef.current = next;
    setIsBottomLocked(next);
  }, []);

  const nowMs = useCallback(() => {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }, []);

  const clearScrollIdleTimer = useCallback(() => {
    if (scrollIdleTimerRef.current == null || typeof window === 'undefined') {
      return;
    }
    window.clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = null;
  }, []);

  const clearInitialAlignSchedule = useCallback(() => {
    if (typeof window !== 'undefined') {
      if (initialAlignFrameRef.current != null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(initialAlignFrameRef.current);
      }
      if (initialAlignRetryTimerRef.current != null) {
        window.clearTimeout(initialAlignRetryTimerRef.current);
      }
    }
    initialAlignFrameRef.current = null;
    initialAlignRetryTimerRef.current = null;
  }, []);

  const clearAnchorRestoreSchedule = useCallback(() => {
    if (typeof window !== 'undefined') {
      if (anchorRestoreFrameRef.current != null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(anchorRestoreFrameRef.current);
      }
      if (anchorRestoreRetryTimerRef.current != null) {
        window.clearTimeout(anchorRestoreRetryTimerRef.current);
      }
    }
    anchorRestoreFrameRef.current = null;
    anchorRestoreRetryTimerRef.current = null;
  }, []);

  const readScrollPhase = useCallback((sessionKey: string): ScrollPhase => {
    return scrollPhaseBySessionRef.current.get(sessionKey) ?? 'initial';
  }, []);

  const writeScrollPhase = useCallback((sessionKey: string, nextPhase: ScrollPhase) => {
    scrollPhaseBySessionRef.current.set(sessionKey, nextPhase);
    if (sessionKey === scrollScopeKey) {
      setBottomLocked(nextPhase !== 'detached');
    }
  }, [scrollScopeKey, setBottomLocked]);

  const markUserScrollActivity = useCallback((directionHint: ScrollDirection = 0) => {
    markChatScrollActivity();
    setIsUserScrolling(true);
    setScrollEventSeq((value) => value + 1);
    if (directionHint !== 0) {
      setScrollDirection(directionHint);
    }
    clearScrollIdleTimer();
    if (typeof window === 'undefined') {
      return;
    }
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollIdleTimerRef.current = null;
      setIsUserScrolling(false);
    }, SCROLL_IDLE_TIMEOUT_MS);
  }, [clearScrollIdleTimer]);

  const markWheelIntent = useCallback(() => {
    wheelIntentUntilRef.current = nowMs() + WHEEL_INTENT_WINDOW_MS;
  }, [nowMs]);

  const hasActiveUserScrollIntent = useCallback(() => {
    if (pointerScrollActiveRef.current || touchScrollActiveRef.current) {
      return true;
    }
    return wheelIntentUntilRef.current > nowMs();
  }, [nowMs]);

  const scrollToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const metrics = readViewportMetrics(viewport);
    if (!metrics) {
      return;
    }
    const nextScrollTop = computeBottomLockedScrollTopOnResize(metrics, metrics);
    programmaticScrollRef.current = true;
    viewport.scrollTop = nextScrollTop;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    } else {
      setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 16);
    }
  }, [viewportRef]);

  const restoreViewportAnchor = useCallback((anchor: ViewportAnchor) => {
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
    const delta = (targetRect.top - viewportRect.top) - anchor.offsetWithinViewport;
    programmaticScrollRef.current = true;
    viewport.scrollTop += delta;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    } else {
      setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 16);
    }
    return true;
  }, [viewportRef]);

  const scheduleInitialAlignRetry = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (initialAlignRetryTimerRef.current != null) {
      window.clearTimeout(initialAlignRetryTimerRef.current);
    }
    initialAlignRetryTimerRef.current = window.setTimeout(() => {
      initialAlignRetryTimerRef.current = null;
      if (readScrollPhase(scrollScopeKey) !== 'following') {
        return;
      }
      const metrics = readViewportMetrics(viewportRef.current);
      if (!metrics) {
        return;
      }
      if (!isChatViewportNearBottom(metrics, stickyBottomThresholdPx)) {
        scrollToBottom();
      }
      setBottomLocked(true);
    }, INITIAL_ALIGN_RETRY_MS);
  }, [readScrollPhase, scrollScopeKey, scrollToBottom, setBottomLocked, stickyBottomThresholdPx, viewportRef]);

  const runInitialAlign = useCallback(() => {
    if (readScrollPhase(scrollScopeKey) !== 'initial') {
      return;
    }
    if (!hasRenderableChatRows(contentRef.current)) {
      return;
    }
    scrollToBottom();
    writeScrollPhase(scrollScopeKey, 'following');
    scheduleInitialAlignRetry();
  }, [contentRef, readScrollPhase, scheduleInitialAlignRetry, scrollScopeKey, scrollToBottom, writeScrollPhase]);

  const scheduleInitialAlign = useCallback(() => {
    clearInitialAlignSchedule();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      initialAlignFrameRef.current = window.requestAnimationFrame(() => {
        initialAlignFrameRef.current = null;
        runInitialAlign();
      });
      return;
    }
    runInitialAlign();
  }, [clearInitialAlignSchedule, runInitialAlign]);

  const runAnchorRestore = useCallback(() => {
    const pending = pendingScopeTransitionRef.current;
    if (
      !pending
      || pending.targetScopeKey !== scrollScopeKey
      || pending.mode !== 'restore-anchor'
      || !pending.anchor
    ) {
      return;
    }
    if (!hasRenderableChatRows(contentRef.current)) {
      return;
    }
    if (!restoreViewportAnchor(pending.anchor)) {
      return;
    }
    pendingScopeTransitionRef.current = null;
    if (typeof window !== 'undefined') {
      if (anchorRestoreRetryTimerRef.current != null) {
        window.clearTimeout(anchorRestoreRetryTimerRef.current);
      }
      anchorRestoreRetryTimerRef.current = window.setTimeout(() => {
        anchorRestoreRetryTimerRef.current = null;
        if (readScrollPhase(scrollScopeKey) !== 'detached') {
          return;
        }
        restoreViewportAnchor(pending.anchor!);
      }, ANCHOR_RESTORE_RETRY_MS);
    }
  }, [contentRef, readScrollPhase, restoreViewportAnchor, scrollScopeKey]);

  const scheduleAnchorRestore = useCallback(() => {
    clearAnchorRestoreSchedule();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      anchorRestoreFrameRef.current = window.requestAnimationFrame(() => {
        anchorRestoreFrameRef.current = null;
        runAnchorRestore();
      });
      return;
    }
    runAnchorRestore();
  }, [clearAnchorRestoreSchedule, runAnchorRestore]);

  useLayoutEffect(() => {
    const scopeChanged = lastScrollScopeKeyRef.current !== scrollScopeKey;
    const resetChanged = lastScrollResetKeyRef.current !== scrollResetKey;
    if (!scopeChanged && !resetChanged) {
      return;
    }
    lastScrollScopeKeyRef.current = scrollScopeKey;
    lastScrollResetKeyRef.current = scrollResetKey;
    clearScrollIdleTimer();
    clearInitialAlignSchedule();
    clearAnchorRestoreSchedule();
    lastUserScrollTopRef.current = null;
    pointerScrollActiveRef.current = false;
    touchScrollActiveRef.current = false;
    wheelIntentUntilRef.current = 0;
    setIsUserScrolling(false);
    setScrollDirection(0);
    setScrollEventSeq(0);
    const pendingTransition = pendingScopeTransitionRef.current;
    if (resetChanged) {
      pendingScopeTransitionRef.current = null;
      writeScrollPhase(scrollScopeKey, 'initial');
      scheduleInitialAlign();
      return;
    }
    if (
      scopeChanged
      && pendingTransition
      && pendingTransition.targetScopeKey === scrollScopeKey
      && pendingTransition.mode === 'restore-anchor'
      && pendingTransition.anchor
    ) {
      writeScrollPhase(scrollScopeKey, 'detached');
      setBottomLocked(false);
      scheduleAnchorRestore();
      return;
    }
    if (
      scopeChanged
      && pendingTransition
      && pendingTransition.targetScopeKey === scrollScopeKey
      && pendingTransition.mode === 'force-bottom'
    ) {
      pendingScopeTransitionRef.current = null;
      writeScrollPhase(scrollScopeKey, 'initial');
      scheduleInitialAlign();
      return;
    }
    const existingPhase = scrollPhaseBySessionRef.current.get(scrollScopeKey);
    if (existingPhase == null) {
      writeScrollPhase(scrollScopeKey, 'initial');
      scheduleInitialAlign();
      return;
    }
    setBottomLocked(existingPhase !== 'detached');
    if (existingPhase === 'initial') {
      scheduleInitialAlign();
    }
  }, [
    clearInitialAlignSchedule,
    clearScrollIdleTimer,
    clearAnchorRestoreSchedule,
    scheduleInitialAlign,
    scheduleAnchorRestore,
    scrollResetKey,
    scrollScopeKey,
    setBottomLocked,
    writeScrollPhase,
  ]);

  const viewportElement = viewportRef.current;
  const contentElement = contentRef.current;

  useLayoutEffect(() => {
    const pendingTransition = pendingScopeTransitionRef.current;
    if (
      pendingTransition
      && pendingTransition.targetScopeKey === scrollScopeKey
      && pendingTransition.mode === 'restore-anchor'
    ) {
      scheduleAnchorRestore();
      return;
    }
    if (readScrollPhase(scrollScopeKey) !== 'initial') {
      return;
    }
    scheduleInitialAlign();
  }, [contentElement, readScrollPhase, scheduleAnchorRestore, scheduleInitialAlign, scrollScopeKey, viewportElement]);

  useLayoutEffect(() => {
    const viewport = viewportElement;
    const content = contentElement;
    if (typeof ResizeObserver !== 'function' || (!viewport && !content)) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const pendingTransition = pendingScopeTransitionRef.current;
      if (
        pendingTransition
        && pendingTransition.targetScopeKey === scrollScopeKey
        && pendingTransition.mode === 'restore-anchor'
      ) {
        scheduleAnchorRestore();
        return;
      }
      const phase = readScrollPhase(scrollScopeKey);
      if (phase === 'initial') {
        scheduleInitialAlign();
        return;
      }
      if (phase === 'following') {
        scrollToBottom();
      }
    });
    if (viewport) {
      observer.observe(viewport);
    }
    if (content) {
      observer.observe(content);
    }
    return () => observer.disconnect();
  }, [
    contentElement,
    readScrollPhase,
    scheduleAnchorRestore,
    scheduleInitialAlign,
    scrollScopeKey,
    scrollToBottom,
    viewportElement,
    viewportRef,
  ]);

  const handleViewportScroll = useCallback(() => {
    const metrics = readViewportMetrics(viewportRef.current);
    if (!metrics) {
      return;
    }
    if (programmaticScrollRef.current) {
      return;
    }
    const previousScrollTop = lastUserScrollTopRef.current;
    let directionHint: ScrollDirection = 0;
    if (previousScrollTop != null) {
      const delta = metrics.scrollTop - previousScrollTop;
      if (delta > 0) {
        directionHint = 1;
      } else if (delta < 0) {
        directionHint = -1;
      }
    }
    lastUserScrollTopRef.current = metrics.scrollTop;

    if (!hasActiveUserScrollIntent()) {
      return;
    }

    markUserScrollActivity(directionHint);
    if (isChatViewportNearBottom(metrics, stickyBottomThresholdPx)) {
      writeScrollPhase(scrollScopeKey, 'following');
      return;
    }
    writeScrollPhase(scrollScopeKey, 'detached');
  }, [hasActiveUserScrollIntent, markUserScrollActivity, scrollScopeKey, stickyBottomThresholdPx, viewportRef, writeScrollPhase]);

  const handleViewportPointerDown = useCallback(() => {
    pointerScrollActiveRef.current = true;
    const metrics = readViewportMetrics(viewportRef.current);
    if (!metrics) {
      return;
    }
    if (!isChatViewportNearBottom(metrics, stickyBottomThresholdPx)) {
      writeScrollPhase(scrollScopeKey, 'detached');
    }
  }, [scrollScopeKey, stickyBottomThresholdPx, viewportRef, writeScrollPhase]);

  const handleViewportTouchMove = useCallback<TouchEventHandler<HTMLDivElement>>(() => {
    touchScrollActiveRef.current = true;
    markUserScrollActivity(scrollDirection === 0 ? -1 : scrollDirection);
    writeScrollPhase(scrollScopeKey, 'detached');
  }, [markUserScrollActivity, scrollDirection, scrollScopeKey, writeScrollPhase]);

  const handleViewportWheel = useCallback((event?: { deltaY?: number }) => {
    markWheelIntent();
    const deltaY = event?.deltaY ?? 0;
    let directionHint: ScrollDirection = 0;
    if (deltaY < 0) {
      directionHint = -1;
    } else if (deltaY > 0) {
      directionHint = 1;
    }
    markUserScrollActivity(directionHint);
    if (deltaY < 0) {
      writeScrollPhase(scrollScopeKey, 'detached');
      return;
    }
    const metrics = readViewportMetrics(viewportRef.current);
    if (metrics && isChatViewportNearBottom(metrics, stickyBottomThresholdPx)) {
      writeScrollPhase(scrollScopeKey, 'following');
    }
  }, [markUserScrollActivity, markWheelIntent, scrollScopeKey, stickyBottomThresholdPx, viewportRef, writeScrollPhase]);

  useLayoutEffect(() => {
    return () => {
      clearScrollIdleTimer();
      clearInitialAlignSchedule();
      clearAnchorRestoreSchedule();
    };
  }, [clearAnchorRestoreSchedule, clearInitialAlignSchedule, clearScrollIdleTimer]);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const clearPointerGesture = () => {
      pointerScrollActiveRef.current = false;
    };
    const clearTouchGesture = () => {
      touchScrollActiveRef.current = false;
    };
    window.addEventListener('pointerup', clearPointerGesture);
    window.addEventListener('pointercancel', clearPointerGesture);
    window.addEventListener('touchend', clearTouchGesture);
    window.addEventListener('touchcancel', clearTouchGesture);
    return () => {
      window.removeEventListener('pointerup', clearPointerGesture);
      window.removeEventListener('pointercancel', clearPointerGesture);
      window.removeEventListener('touchend', clearTouchGesture);
      window.removeEventListener('touchcancel', clearTouchGesture);
    };
  }, []);

  return {
    handleViewportScroll,
    handleViewportPointerDown,
    handleViewportTouchMove,
    handleViewportWheel,
    prepareScopeAnchorRestore: (nextScopeKey: string) => {
      if (!nextScopeKey || nextScopeKey === scrollScopeKey) {
        return;
      }
      const anchor = sampleViewportAnchor(viewportRef.current);
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
      if (!nextScopeKey || nextScopeKey === scrollScopeKey) {
        return;
      }
      pendingScopeTransitionRef.current = {
        targetScopeKey: nextScopeKey,
        mode: 'force-bottom',
      };
    },
    isBottomLocked,
    isUserScrolling,
    scrollIdle: !isUserScrolling,
    scrollDirection,
    scrollEventSeq,
  };
}
