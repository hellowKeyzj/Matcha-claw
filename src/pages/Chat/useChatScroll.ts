import { useCallback, useLayoutEffect, useRef, useState, type TouchEventHandler } from 'react';
import { markChatScrollActivity } from './chat-scroll-drain';

interface UseChatScrollInput {
  enabled: boolean;
  scrollScopeKey: string;
  scrollActivationKey: string;
  scrollResetKey: string;
  autoFollowSignal: string;
  scopeRestorePending: boolean;
  tailActivityOpen: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  stickyBottomThresholdPx: number;
}

type ScrollDirection = -1 | 0 | 1;
type ScrollPhase = 'initial' | 'following' | 'restoring' | 'detached';
type ScopeTransitionMode = 'restore-anchor' | 'force-bottom';

const SCROLL_IDLE_TIMEOUT_MS = 160;
const WHEEL_INTENT_WINDOW_MS = 220;
const INITIAL_ALIGN_RETRY_MS = 150;
const TAIL_SETTLE_IDLE_MS = 220;

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

interface PendingAnchorRestore extends PendingScopeTransition {
  mode: 'restore-anchor';
  anchor: ViewportAnchor;
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

function isBottomLockedPhase(phase: ScrollPhase): boolean {
  return phase === 'initial' || phase === 'following';
}

function isLiveScrollScope(scopeKey: string): boolean {
  return scopeKey.endsWith('::live');
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
  scrollActivationKey,
  scrollResetKey,
  autoFollowSignal,
  scopeRestorePending,
  tailActivityOpen,
  viewportRef,
  contentRef,
  stickyBottomThresholdPx,
}: UseChatScrollInput) {
  const [isBottomLocked, setIsBottomLocked] = useState(true);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [scrollDirection, setScrollDirection] = useState<ScrollDirection>(0);
  const [scrollEventSeq, setScrollEventSeq] = useState(0);
  const isBottomLockedRef = useRef(true);
  const lastScrollActivationKeyRef = useRef(scrollActivationKey);
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
  const scrollPhaseBySessionRef = useRef<Map<string, ScrollPhase>>(
    new Map([[scrollScopeKey, 'initial']]),
  );
  const pendingScopeTransitionRef = useRef<PendingScopeTransition | null>(null);
  const detachedViewportAnchorRef = useRef<ViewportAnchor | null>(null);
  const lastFollowViewportHeightRef = useRef<number | null>(null);
  const lastFollowViewportWidthRef = useRef<number | null>(null);
  const lastFollowScrollHeightRef = useRef<number | null>(null);
  const lastFollowTailMetricsRef = useRef<TailMessageMetrics | null>(null);
  const tailSettleTimerRef = useRef<number | null>(null);
  const tailSettlePendingRef = useRef(false);
  const tailActivityOpenRef = useRef(tailActivityOpen);

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
    }
    anchorRestoreFrameRef.current = null;
  }, []);

  const clearTailSettleTask = useCallback(() => {
    tailSettlePendingRef.current = false;
    if (tailSettleTimerRef.current == null || typeof window === 'undefined') {
      return;
    }
    window.clearTimeout(tailSettleTimerRef.current);
    tailSettleTimerRef.current = null;
  }, []);

  const armTailSettleTask = useCallback(() => {
    tailSettlePendingRef.current = true;
    if (typeof window === 'undefined') {
      return;
    }
    if (tailSettleTimerRef.current != null) {
      window.clearTimeout(tailSettleTimerRef.current);
    }
    tailSettleTimerRef.current = window.setTimeout(() => {
      tailSettleTimerRef.current = null;
      tailSettlePendingRef.current = false;
    }, TAIL_SETTLE_IDLE_MS);
  }, []);

  const readScrollPhase = useCallback((sessionKey: string): ScrollPhase => {
    return scrollPhaseBySessionRef.current.get(sessionKey) ?? 'initial';
  }, []);

  const readPendingAnchorRestore = useCallback((scopeKey: string): PendingAnchorRestore | null => {
    const pending = pendingScopeTransitionRef.current;
    if (
      !pending
      || pending.targetScopeKey !== scopeKey
      || pending.mode !== 'restore-anchor'
      || !pending.anchor
    ) {
      return null;
    }
    return pending as PendingAnchorRestore;
  }, []);

  const cancelAnchorRestoreForScope = useCallback((scopeKey: string) => {
    const pending = readPendingAnchorRestore(scopeKey);
    if (!pending) {
      return;
    }
    pendingScopeTransitionRef.current = null;
    clearAnchorRestoreSchedule();
  }, [clearAnchorRestoreSchedule, readPendingAnchorRestore]);

  const clearDetachedViewportAnchor = useCallback(() => {
    detachedViewportAnchorRef.current = null;
  }, []);

  const syncDetachedViewportAnchor = useCallback(() => {
    detachedViewportAnchorRef.current = sampleViewportAnchor(viewportRef.current);
    return detachedViewportAnchorRef.current;
  }, [viewportRef]);

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

  const writeScrollPhase = useCallback((sessionKey: string, nextPhase: ScrollPhase) => {
    scrollPhaseBySessionRef.current.set(sessionKey, nextPhase);
    if (sessionKey === scrollScopeKey) {
      setBottomLocked(isBottomLockedPhase(nextPhase));
      if (nextPhase !== 'detached') {
        clearDetachedViewportAnchor();
      }
    }
  }, [clearDetachedViewportAnchor, scrollScopeKey, setBottomLocked]);

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
    if (!enabled) {
      return;
    }
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
    scheduleProgrammaticScrollCleanup();
  }, [enabled, scheduleProgrammaticScrollCleanup, viewportRef]);

  const syncFollowResizeSnapshot = useCallback(() => {
    const viewport = viewportRef.current;
    lastFollowViewportHeightRef.current = viewport?.clientHeight ?? null;
    lastFollowViewportWidthRef.current = viewport?.clientWidth ?? null;
    lastFollowScrollHeightRef.current = viewport?.scrollHeight ?? null;
    lastFollowTailMetricsRef.current = sampleTailMessageMetrics(viewport);
  }, [viewportRef]);

  const hasTailFollowWork = useCallback(() => (
    tailActivityOpenRef.current || tailSettlePendingRef.current
  ), []);

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
    const delta = (targetRect.top - viewportRect.top) - anchor.offsetWithinViewport;
    programmaticScrollRef.current = true;
    viewport.scrollTop += delta;
    scheduleProgrammaticScrollCleanup();
    return true;
  }, [enabled, scheduleProgrammaticScrollCleanup, viewportRef]);

  const finishAnchorRestore = useCallback(() => {
    const pending = readPendingAnchorRestore(scrollScopeKey);
    if (!pending) {
      return;
    }
    pendingScopeTransitionRef.current = null;
    writeScrollPhase(scrollScopeKey, 'detached');
    syncDetachedViewportAnchor();
  }, [readPendingAnchorRestore, scrollScopeKey, syncDetachedViewportAnchor, writeScrollPhase]);

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
    if (readScrollPhase(scrollScopeKey) !== 'restoring') {
      return;
    }
    const pending = readPendingAnchorRestore(scrollScopeKey);
    if (!pending) {
      return;
    }
    if (!hasRenderableChatRows(contentRef.current)) {
      return;
    }
    if (!restoreViewportAnchor(pending.anchor)) {
      return;
    }
    if (!scopeRestorePending) {
      finishAnchorRestore();
    }
  }, [contentRef, finishAnchorRestore, readPendingAnchorRestore, readScrollPhase, restoreViewportAnchor, scrollScopeKey, scopeRestorePending]);

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
    const activationChanged = lastScrollActivationKeyRef.current !== scrollActivationKey;
    lastScrollActivationKeyRef.current = scrollActivationKey;

    if (!enabled) {
      return;
    }
    const scopeChanged = lastScrollScopeKeyRef.current !== scrollScopeKey;
    const resetChanged = lastScrollResetKeyRef.current !== scrollResetKey;
    if (!activationChanged && !scopeChanged && !resetChanged) {
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
    tailActivityOpenRef.current = tailActivityOpen;
    clearTailSettleTask();
    clearDetachedViewportAnchor();
    setIsUserScrolling(false);
    setScrollDirection(0);
    setScrollEventSeq(0);
    lastFollowViewportHeightRef.current = null;
    lastFollowViewportWidthRef.current = null;
    lastFollowScrollHeightRef.current = null;
    lastFollowTailMetricsRef.current = null;
    const pendingTransition = pendingScopeTransitionRef.current;
    if (resetChanged) {
      pendingScopeTransitionRef.current = null;
      writeScrollPhase(scrollScopeKey, 'initial');
      scheduleInitialAlign();
      return;
    }
    if (
      (scopeChanged || activationChanged)
      && pendingTransition
      && pendingTransition.targetScopeKey === scrollScopeKey
      && pendingTransition.mode === 'restore-anchor'
      && pendingTransition.anchor
    ) {
      writeScrollPhase(scrollScopeKey, 'restoring');
      scheduleAnchorRestore();
      return;
    }
    if (
      (scopeChanged || activationChanged)
      && pendingTransition
      && pendingTransition.targetScopeKey === scrollScopeKey
      && pendingTransition.mode === 'force-bottom'
    ) {
      pendingScopeTransitionRef.current = null;
      writeScrollPhase(scrollScopeKey, 'initial');
      scheduleInitialAlign();
      return;
    }
    if (activationChanged && isLiveScrollScope(scrollScopeKey)) {
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
    setBottomLocked(isBottomLockedPhase(existingPhase));
    if (existingPhase === 'initial') {
      scheduleInitialAlign();
    }
  }, [
    clearInitialAlignSchedule,
    clearScrollIdleTimer,
    clearAnchorRestoreSchedule,
    scheduleInitialAlign,
    scheduleAnchorRestore,
    clearTailSettleTask,
    clearDetachedViewportAnchor,
    enabled,
    scrollActivationKey,
    scrollResetKey,
    scrollScopeKey,
    setBottomLocked,
    tailActivityOpen,
    writeScrollPhase,
  ]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const previousTailActivityOpen = tailActivityOpenRef.current;
    tailActivityOpenRef.current = tailActivityOpen;

    if (readScrollPhase(scrollScopeKey) !== 'following') {
      if (tailActivityOpen) {
        clearTailSettleTask();
      }
      return;
    }

    if (tailActivityOpen) {
      clearTailSettleTask();
      scrollToBottom();
      syncFollowResizeSnapshot();
      return;
    }

    if (previousTailActivityOpen) {
      armTailSettleTask();
    }
  }, [
    armTailSettleTask,
    clearTailSettleTask,
    readScrollPhase,
    scrollScopeKey,
    scrollToBottom,
    syncFollowResizeSnapshot,
    enabled,
    tailActivityOpen,
  ]);

  const viewportElement = viewportRef.current;
  const contentElement = contentRef.current;

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
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
  }, [contentElement, enabled, readScrollPhase, scheduleAnchorRestore, scheduleInitialAlign, scrollScopeKey, viewportElement]);

  useLayoutEffect(() => {
    if (!enabled || scopeRestorePending) {
      return;
    }
    if (readScrollPhase(scrollScopeKey) !== 'restoring') {
      return;
    }
    if (!readPendingAnchorRestore(scrollScopeKey)) {
      return;
    }
    scheduleAnchorRestore();
  }, [enabled, readPendingAnchorRestore, readScrollPhase, scheduleAnchorRestore, scrollScopeKey, scopeRestorePending]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    if (readScrollPhase(scrollScopeKey) !== 'following') {
      return;
    }
    scrollToBottom();
    syncFollowResizeSnapshot();
    if (!tailActivityOpenRef.current) {
      armTailSettleTask();
    }
  }, [armTailSettleTask, autoFollowSignal, enabled, readScrollPhase, scrollScopeKey, scrollToBottom, syncFollowResizeSnapshot]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    syncFollowResizeSnapshot();
  }, [contentElement, enabled, scrollScopeKey, syncFollowResizeSnapshot, viewportElement]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const viewport = viewportElement;
    const content = contentElement;
    if (typeof ResizeObserver !== 'function' || (!viewport && !content)) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const pendingTransition = readPendingAnchorRestore(scrollScopeKey);
      if (pendingTransition) {
        scheduleAnchorRestore();
        return;
      }
      const phase = readScrollPhase(scrollScopeKey);
      if (phase === 'initial') {
        scheduleInitialAlign();
        syncFollowResizeSnapshot();
        return;
      }
      if (phase === 'restoring') {
        scheduleAnchorRestore();
        return;
      }
      if (phase === 'detached') {
        const anchor = detachedViewportAnchorRef.current ?? syncDetachedViewportAnchor();
        if (anchor) {
          restoreViewportAnchor(anchor);
        }
        return;
      }
      const viewportMetrics = readViewportMetrics(viewportRef.current);
      const scrollHeight = viewportMetrics?.scrollHeight ?? null;
      const scrollHeightChanged = (
        scrollHeight != null
        && lastFollowScrollHeightRef.current != null
        && scrollHeight !== lastFollowScrollHeightRef.current
      );
      const viewportHeight = viewportRef.current?.clientHeight ?? null;
      const viewportHeightChanged = (
        viewportHeight != null
        && lastFollowViewportHeightRef.current != null
        && viewportHeight !== lastFollowViewportHeightRef.current
      );
      const viewportWidth = viewportRef.current?.clientWidth ?? null;
      const viewportWidthChanged = (
        viewportWidth != null
        && lastFollowViewportWidthRef.current != null
        && viewportWidth !== lastFollowViewportWidthRef.current
      );
      const nextTailMetrics = sampleTailMessageMetrics(viewportRef.current);
      const tailMetricsChanged = hasTailResizeDelta(lastFollowTailMetricsRef.current, nextTailMetrics);
      lastFollowViewportHeightRef.current = viewportHeight;
      lastFollowViewportWidthRef.current = viewportWidth;
      lastFollowScrollHeightRef.current = scrollHeight;
      lastFollowTailMetricsRef.current = nextTailMetrics;
      const layoutChanged = viewportHeightChanged || viewportWidthChanged;
      const tailFollowChanged = hasTailFollowWork() && (scrollHeightChanged || tailMetricsChanged);
      if (phase === 'following' && (layoutChanged || tailFollowChanged)) {
        scrollToBottom();
        syncFollowResizeSnapshot();
        if (tailFollowChanged && !tailActivityOpenRef.current) {
          armTailSettleTask();
        }
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
    armTailSettleTask,
    hasTailFollowWork,
    syncDetachedViewportAnchor,
    scheduleInitialAlign,
    scrollScopeKey,
    scrollToBottom,
    syncFollowResizeSnapshot,
    enabled,
    viewportElement,
    viewportRef,
  ]);

  const handleViewportScroll = useCallback(() => {
    if (!enabled) {
      return;
    }
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
    cancelAnchorRestoreForScope(scrollScopeKey);
    if (isChatViewportNearBottom(metrics, stickyBottomThresholdPx)) {
      writeScrollPhase(scrollScopeKey, 'following');
      return;
    }
    writeScrollPhase(scrollScopeKey, 'detached');
    syncDetachedViewportAnchor();
  }, [enabled, hasActiveUserScrollIntent, markUserScrollActivity, scrollScopeKey, stickyBottomThresholdPx, syncDetachedViewportAnchor, viewportRef, writeScrollPhase]);

  const handleViewportPointerDown = useCallback(() => {
    if (!enabled) {
      return;
    }
    pointerScrollActiveRef.current = true;
    const metrics = readViewportMetrics(viewportRef.current);
    if (!metrics) {
      return;
    }
    if (!isChatViewportNearBottom(metrics, stickyBottomThresholdPx)) {
      cancelAnchorRestoreForScope(scrollScopeKey);
      writeScrollPhase(scrollScopeKey, 'detached');
    }
  }, [cancelAnchorRestoreForScope, enabled, scrollScopeKey, stickyBottomThresholdPx, viewportRef, writeScrollPhase]);

  const handleViewportTouchMove = useCallback<TouchEventHandler<HTMLDivElement>>(() => {
    if (!enabled) {
      return;
    }
    touchScrollActiveRef.current = true;
    markUserScrollActivity(scrollDirection === 0 ? -1 : scrollDirection);
    cancelAnchorRestoreForScope(scrollScopeKey);
    writeScrollPhase(scrollScopeKey, 'detached');
  }, [cancelAnchorRestoreForScope, enabled, markUserScrollActivity, scrollDirection, scrollScopeKey, writeScrollPhase]);

  const handleViewportWheel = useCallback((event?: { deltaY?: number }) => {
    if (!enabled) {
      return;
    }
    markWheelIntent();
    const deltaY = event?.deltaY ?? 0;
    let directionHint: ScrollDirection = 0;
    if (deltaY < 0) {
      directionHint = -1;
    } else if (deltaY > 0) {
      directionHint = 1;
    }
    markUserScrollActivity(directionHint);
    cancelAnchorRestoreForScope(scrollScopeKey);
    if (deltaY < 0) {
      writeScrollPhase(scrollScopeKey, 'detached');
      return;
    }
    const metrics = readViewportMetrics(viewportRef.current);
    if (metrics && isChatViewportNearBottom(metrics, stickyBottomThresholdPx)) {
      writeScrollPhase(scrollScopeKey, 'following');
    }
  }, [cancelAnchorRestoreForScope, enabled, markUserScrollActivity, markWheelIntent, scrollScopeKey, stickyBottomThresholdPx, viewportRef, writeScrollPhase]);

  useLayoutEffect(() => {
    return () => {
      clearScrollIdleTimer();
      clearInitialAlignSchedule();
      clearAnchorRestoreSchedule();
      clearTailSettleTask();
    };
  }, [clearAnchorRestoreSchedule, clearInitialAlignSchedule, clearScrollIdleTimer, clearTailSettleTask]);

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
