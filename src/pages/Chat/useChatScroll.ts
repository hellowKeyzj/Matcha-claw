import { useCallback, useLayoutEffect, useRef, useState, type TouchEventHandler } from 'react';
import { markChatScrollActivity } from './chat-scroll-drain';

interface UseChatScrollInput {
  enabled: boolean;
  scrollScopeKey: string;
  autoFollowSignal: string;
  tailActivityOpen: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  stickyBottomThresholdPx: number;
}

type ScrollPhase = 'initial' | 'following' | 'restoring' | 'detached';
type ScopeTransitionMode = 'restore-anchor' | 'force-bottom';

const WHEEL_INTENT_WINDOW_MS = 220;
const INITIAL_ALIGN_RETRY_MS = 150;
const TAIL_SETTLE_IDLE_MS = 220;
const FOLLOW_PULSE_FRAMES_IDLE = 2;
const FOLLOW_PULSE_FRAMES_TAIL = 6;

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

interface FollowPulseController {
  frameId: number | null;
  framesRemaining: number;
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
  viewportRef,
  contentRef,
  stickyBottomThresholdPx,
}: UseChatScrollInput) {
  const [isBottomLocked, setIsBottomLocked] = useState(true);
  const lastScopeKeyRef = useRef(scrollScopeKey);
  const scrollPhaseByScopeRef = useRef<Map<string, ScrollPhase>>(
    new Map([[scrollScopeKey, 'initial']]),
  );
  const pendingScopeTransitionRef = useRef<PendingScopeTransition | null>(null);
  const detachedViewportAnchorRef = useRef<ViewportAnchor | null>(null);
  const followSnapshotRef = useRef<FollowSnapshot>({
    viewportHeight: null,
    viewportWidth: null,
    scrollHeight: null,
    tailMetrics: null,
  });
  const followPulseRef = useRef<FollowPulseController>({
    frameId: null,
    framesRemaining: 0,
  });
  const programmaticScrollRef = useRef(false);
  const pointerScrollActiveRef = useRef(false);
  const touchScrollActiveRef = useRef(false);
  const wheelIntentUntilRef = useRef(0);
  const tailFollowUntilRef = useRef(0);
  const tailFollowTimerRef = useRef<number | null>(null);
  const previousTailActivityOpenRef = useRef(tailActivityOpen);
  const initialAlignFrameRef = useRef<number | null>(null);
  const initialAlignRetryTimerRef = useRef<number | null>(null);
  const anchorRestoreFrameRef = useRef<number | null>(null);

  const nowMs = useCallback(() => {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }, []);

  const readScrollPhase = useCallback((scopeKey: string): ScrollPhase => {
    return scrollPhaseByScopeRef.current.get(scopeKey) ?? 'initial';
  }, []);

  const setScrollPhase = useCallback((scopeKey: string, nextPhase: ScrollPhase) => {
    scrollPhaseByScopeRef.current.set(scopeKey, nextPhase);
    if (scopeKey === scrollScopeKey) {
      setIsBottomLocked(isBottomLockedPhase(nextPhase));
      if (nextPhase !== 'detached') {
        detachedViewportAnchorRef.current = null;
      }
    }
  }, [scrollScopeKey]);

  const readPendingAnchorRestore = useCallback((scopeKey: string): ViewportAnchor | null => {
    const pending = pendingScopeTransitionRef.current;
    if (
      !pending
      || pending.targetScopeKey !== scopeKey
      || pending.mode !== 'restore-anchor'
      || !pending.anchor
    ) {
      return null;
    }
    return pending.anchor;
  }, []);

  const clearFollowPulse = useCallback(() => {
    const pulse = followPulseRef.current;
    if (pulse.frameId != null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(pulse.frameId);
    }
    pulse.frameId = null;
    pulse.framesRemaining = 0;
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

  const cancelAnchorRestoreForScope = useCallback((scopeKey: string) => {
    const anchor = readPendingAnchorRestore(scopeKey);
    if (!anchor) {
      return;
    }
    pendingScopeTransitionRef.current = null;
    clearAnchorRestoreSchedule();
  }, [clearAnchorRestoreSchedule, readPendingAnchorRestore]);

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

  const scrollToBottom = useCallback(() => {
    if (!enabled) {
      return;
    }
    const viewport = viewportRef.current;
    const metrics = readViewportMetrics(viewport);
    if (!viewport || !metrics) {
      return;
    }
    programmaticScrollRef.current = true;
    viewport.scrollTop = computeBottomLockedScrollTopOnResize(metrics, metrics);
    scheduleProgrammaticScrollCleanup();
  }, [enabled, scheduleProgrammaticScrollCleanup, viewportRef]);

  const syncFollowSnapshot = useCallback(() => {
    const viewport = viewportRef.current;
    followSnapshotRef.current = {
      viewportHeight: viewport?.clientHeight ?? null,
      viewportWidth: viewport?.clientWidth ?? null,
      scrollHeight: viewport?.scrollHeight ?? null,
      tailMetrics: sampleTailMessageMetrics(viewport),
    };
  }, [viewportRef]);

  const syncDetachedViewportAnchor = useCallback(() => {
    detachedViewportAnchorRef.current = sampleViewportAnchor(viewportRef.current);
    return detachedViewportAnchorRef.current;
  }, [viewportRef]);

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
    const phase = readScrollPhase(scrollScopeKey);
    const metrics = readViewportMetrics(viewport);
    syncContainer.dataset.chatScrollPhase = phase;
    syncContainer.dataset.chatScrollLocked = isBottomLockedPhase(phase) ? 'true' : 'false';
    syncContainer.dataset.chatScrollOverflow = (
      metrics != null && metrics.scrollHeight > metrics.clientHeight
    ) ? 'true' : 'false';
    syncContainer.dataset.chatScrollScope = scrollScopeKey;
  }, [readScrollPhase, scrollScopeKey, viewportRef]);

  const markWheelIntent = useCallback(() => {
    wheelIntentUntilRef.current = nowMs() + WHEEL_INTENT_WINDOW_MS;
  }, [nowMs]);

  const hasActiveUserScrollIntent = useCallback(() => {
    if (pointerScrollActiveRef.current || touchScrollActiveRef.current) {
      return true;
    }
    return wheelIntentUntilRef.current > nowMs();
  }, [nowMs]);

  const runInitialAlign = useCallback(() => {
    if (readScrollPhase(scrollScopeKey) !== 'initial') {
      return;
    }
    if (!hasRenderableChatRows(contentRef.current, viewportRef.current)) {
      return;
    }
    scrollToBottom();
    setScrollPhase(scrollScopeKey, 'following');
    syncFollowSnapshot();
    if (typeof window !== 'undefined') {
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
        setIsBottomLocked(true);
      }, INITIAL_ALIGN_RETRY_MS);
    }
  }, [
    contentRef,
    readScrollPhase,
    scrollScopeKey,
    scrollToBottom,
    setScrollPhase,
    stickyBottomThresholdPx,
    syncFollowSnapshot,
    viewportRef,
  ]);

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

  const finishAnchorRestore = useCallback(() => {
    pendingScopeTransitionRef.current = null;
    setScrollPhase(scrollScopeKey, 'detached');
    syncDetachedViewportAnchor();
  }, [scrollScopeKey, setScrollPhase, syncDetachedViewportAnchor]);

  const runAnchorRestore = useCallback(() => {
    const anchor = readPendingAnchorRestore(scrollScopeKey);
    if (!anchor || !hasRenderableChatRows(contentRef.current, viewportRef.current)) {
      return;
    }
    if (!restoreViewportAnchor(anchor)) {
      return;
    }
    finishAnchorRestore();
  }, [
    contentRef,
    finishAnchorRestore,
    readPendingAnchorRestore,
    restoreViewportAnchor,
    scrollScopeKey,
    viewportRef,
  ]);

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

  const activatePendingTransitionForCurrentScope = useCallback(() => {
    const pending = pendingScopeTransitionRef.current;
    if (!pending || pending.targetScopeKey !== scrollScopeKey) {
      return false;
    }
    if (pending.mode === 'restore-anchor' && pending.anchor) {
      setScrollPhase(scrollScopeKey, 'restoring');
      scheduleAnchorRestore();
      return true;
    }
    pendingScopeTransitionRef.current = null;
    setScrollPhase(scrollScopeKey, 'initial');
    scheduleInitialAlign();
    return true;
  }, [scheduleAnchorRestore, scheduleInitialAlign, scrollScopeKey, setScrollPhase]);

  const runFollowPulseStep = useCallback(() => {
    if (activatePendingTransitionForCurrentScope()) {
      return;
    }
    const phase = readScrollPhase(scrollScopeKey);
    if (phase === 'restoring') {
      scheduleAnchorRestore();
      return;
    }
    if (phase === 'initial') {
      scheduleInitialAlign();
      return;
    }
    if (phase !== 'following') {
      return;
    }
    scrollToBottom();
    syncFollowSnapshot();
  }, [
    activatePendingTransitionForCurrentScope,
    readScrollPhase,
    scheduleAnchorRestore,
    scheduleInitialAlign,
    scrollScopeKey,
    scrollToBottom,
    syncFollowSnapshot,
  ]);

  const scheduleFollowPulse = useCallback((requestedFrames: number) => {
    const pulse = followPulseRef.current;
    pulse.framesRemaining = Math.max(pulse.framesRemaining, requestedFrames);
    if (pulse.frameId != null) {
      return;
    }
    const runFrame = () => {
      pulse.frameId = null;
      runFollowPulseStep();
      if (
        pulse.framesRemaining > 0
        && typeof window !== 'undefined'
        && typeof window.requestAnimationFrame === 'function'
      ) {
        pulse.framesRemaining -= 1;
        pulse.frameId = window.requestAnimationFrame(runFrame);
      } else {
        pulse.framesRemaining = 0;
      }
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      pulse.frameId = window.requestAnimationFrame(runFrame);
      return;
    }
    runFrame();
  }, [runFollowPulseStep]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const scopeChanged = lastScopeKeyRef.current !== scrollScopeKey;
    lastScopeKeyRef.current = scrollScopeKey;
    if (!scopeChanged) {
      return;
    }
    clearInitialAlignSchedule();
    clearAnchorRestoreSchedule();
    clearFollowPulse();
    clearTailFollowWindow();
    pointerScrollActiveRef.current = false;
    touchScrollActiveRef.current = false;
    wheelIntentUntilRef.current = 0;
    followSnapshotRef.current = {
      viewportHeight: null,
      viewportWidth: null,
      scrollHeight: null,
      tailMetrics: null,
    };

    if (activatePendingTransitionForCurrentScope()) {
      return;
    }

    if (!scrollPhaseByScopeRef.current.has(scrollScopeKey)) {
      setScrollPhase(scrollScopeKey, 'initial');
      scheduleInitialAlign();
      return;
    }

    const existingPhase = readScrollPhase(scrollScopeKey);
    setIsBottomLocked(isBottomLockedPhase(existingPhase));
    if (existingPhase === 'initial') {
      runInitialAlign();
      if (readScrollPhase(scrollScopeKey) !== 'initial') {
        return;
      }
      scheduleInitialAlign();
    }
  }, [
    activatePendingTransitionForCurrentScope,
    clearAnchorRestoreSchedule,
    clearFollowPulse,
    clearInitialAlignSchedule,
    clearTailFollowWindow,
    enabled,
    readScrollPhase,
    runInitialAlign,
    scheduleInitialAlign,
    scrollScopeKey,
    setScrollPhase,
  ]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const previousTailActivityOpen = previousTailActivityOpenRef.current;
    previousTailActivityOpenRef.current = tailActivityOpen;

    if (readScrollPhase(scrollScopeKey) !== 'following') {
      if (tailActivityOpen) {
        clearTailFollowWindow();
      }
      return;
    }

    if (tailActivityOpen) {
      clearTailFollowWindow();
      scheduleFollowPulse(FOLLOW_PULSE_FRAMES_IDLE);
      return;
    }

    if (previousTailActivityOpen) {
      armTailFollowWindow();
      scheduleFollowPulse(FOLLOW_PULSE_FRAMES_TAIL);
    }
  }, [
    armTailFollowWindow,
    clearTailFollowWindow,
    enabled,
    readScrollPhase,
    scheduleFollowPulse,
    scrollScopeKey,
    tailActivityOpen,
  ]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    if (activatePendingTransitionForCurrentScope()) {
      return;
    }
    const phase = readScrollPhase(scrollScopeKey);
    if (phase === 'restoring') {
      scheduleAnchorRestore();
      return;
    }
    if (phase === 'initial') {
      runInitialAlign();
      if (readScrollPhase(scrollScopeKey) !== 'initial') {
        return;
      }
      scheduleInitialAlign();
      return;
    }
    if (phase === 'following') {
      scheduleFollowPulse(hasTailFollowWork() ? FOLLOW_PULSE_FRAMES_TAIL : FOLLOW_PULSE_FRAMES_IDLE);
    }
  }, [
    activatePendingTransitionForCurrentScope,
    autoFollowSignal,
    enabled,
    hasTailFollowWork,
    readScrollPhase,
    scheduleAnchorRestore,
    scheduleFollowPulse,
    scheduleInitialAlign,
    runInitialAlign,
    scrollScopeKey,
  ]);

  useLayoutEffect(() => {
    if (!enabled || !hasRenderableChatRows(contentRef.current, viewportRef.current)) {
      return;
    }
    const phase = readScrollPhase(scrollScopeKey);
    if (phase === 'initial') {
      runInitialAlign();
      return;
    }
    if (phase === 'restoring') {
      scheduleAnchorRestore();
    }
  });

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    syncScrollContainerState();
  }, [autoFollowSignal, enabled, isBottomLocked, scrollScopeKey, syncScrollContainerState, tailActivityOpen]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    syncFollowSnapshot();
  }, [contentRef.current, enabled, scrollScopeKey, syncFollowSnapshot, viewportRef.current]);

  useLayoutEffect(() => {
    if (!enabled || !isBottomLocked) {
      return;
    }
    const content = contentRef.current;
    if (!content || typeof MutationObserver !== 'function') {
      return;
    }
    const observer = new MutationObserver(() => {
      scheduleFollowPulse(hasTailFollowWork() ? FOLLOW_PULSE_FRAMES_TAIL : FOLLOW_PULSE_FRAMES_IDLE);
    });
    observer.observe(content, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
    };
  }, [contentRef, enabled, hasTailFollowWork, isBottomLocked, scheduleFollowPulse]);

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
      if (activatePendingTransitionForCurrentScope()) {
        return;
      }
      const phase = readScrollPhase(scrollScopeKey);
      if (phase === 'initial') {
        scheduleInitialAlign();
        syncFollowSnapshot();
        syncScrollContainerState();
        return;
      }
      if (phase === 'restoring') {
        scheduleAnchorRestore();
        syncScrollContainerState();
        return;
      }
      if (phase === 'detached') {
        const anchor = detachedViewportAnchorRef.current ?? syncDetachedViewportAnchor();
        if (anchor) {
          restoreViewportAnchor(anchor);
        }
        syncFollowSnapshot();
        syncScrollContainerState();
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
    activatePendingTransitionForCurrentScope,
    contentRef,
    enabled,
    readScrollPhase,
    restoreViewportAnchor,
    scheduleAnchorRestore,
    scheduleInitialAlign,
    scrollScopeKey,
    syncDetachedViewportAnchor,
    syncFollowSnapshot,
    syncScrollContainerState,
    viewportRef,
  ]);

  useLayoutEffect(() => {
    if (!enabled || !isBottomLocked) {
      return;
    }
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (typeof ResizeObserver !== 'function' || (!viewport && !content)) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (activatePendingTransitionForCurrentScope()) {
        return;
      }
      if (readScrollPhase(scrollScopeKey) !== 'following') {
        return;
      }

      const viewportMetrics = readViewportMetrics(viewportRef.current);
      const nextSnapshot: FollowSnapshot = {
        viewportHeight: viewportRef.current?.clientHeight ?? null,
        viewportWidth: viewportRef.current?.clientWidth ?? null,
        scrollHeight: viewportMetrics?.scrollHeight ?? null,
        tailMetrics: sampleTailMessageMetrics(viewportRef.current),
      };
      const previousSnapshot = followSnapshotRef.current;
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
      followSnapshotRef.current = nextSnapshot;

      const layoutChanged = viewportHeightChanged || viewportWidthChanged;
      const tailFollowChanged = hasTailFollowWork() && (scrollHeightChanged || tailMetricsChanged);
      if (layoutChanged || tailFollowChanged) {
        scheduleFollowPulse(tailFollowChanged ? FOLLOW_PULSE_FRAMES_TAIL : FOLLOW_PULSE_FRAMES_IDLE);
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
    activatePendingTransitionForCurrentScope,
    contentRef,
    enabled,
    hasTailFollowWork,
    isBottomLocked,
    readScrollPhase,
    scheduleFollowPulse,
    scrollScopeKey,
    syncScrollContainerState,
    viewportRef,
  ]);

  useLayoutEffect(() => {
    if (enabled && isBottomLocked) {
      return;
    }
    clearFollowPulse();
  }, [clearFollowPulse, enabled, isBottomLocked]);

  const handleViewportScroll = useCallback(() => {
    if (!enabled) {
      return;
    }
    const metrics = readViewportMetrics(viewportRef.current);
    if (!metrics || programmaticScrollRef.current) {
      return;
    }
    if (isChatViewportNearBottom(metrics, stickyBottomThresholdPx)) {
      setScrollPhase(scrollScopeKey, 'following');
      if (!hasActiveUserScrollIntent()) {
        return;
      }
      markChatScrollActivity();
      cancelAnchorRestoreForScope(scrollScopeKey);
      return;
    }
    if (!hasActiveUserScrollIntent()) {
      return;
    }
    markChatScrollActivity();
    cancelAnchorRestoreForScope(scrollScopeKey);
    setScrollPhase(scrollScopeKey, 'detached');
    syncDetachedViewportAnchor();
  }, [
    cancelAnchorRestoreForScope,
    enabled,
    hasActiveUserScrollIntent,
    scrollScopeKey,
    setScrollPhase,
    stickyBottomThresholdPx,
    syncDetachedViewportAnchor,
    viewportRef,
  ]);

  const handleViewportPointerDown = useCallback(() => {
    if (!enabled) {
      return;
    }
    programmaticScrollRef.current = false;
    pointerScrollActiveRef.current = true;
    const metrics = readViewportMetrics(viewportRef.current);
    if (!metrics || isChatViewportNearBottom(metrics, stickyBottomThresholdPx)) {
      return;
    }
    cancelAnchorRestoreForScope(scrollScopeKey);
    setScrollPhase(scrollScopeKey, 'detached');
  }, [
    cancelAnchorRestoreForScope,
    enabled,
    scrollScopeKey,
    setScrollPhase,
    stickyBottomThresholdPx,
    viewportRef,
  ]);

  const handleViewportTouchMove = useCallback<TouchEventHandler<HTMLDivElement>>(() => {
    if (!enabled) {
      return;
    }
    programmaticScrollRef.current = false;
    touchScrollActiveRef.current = true;
    markChatScrollActivity();
    cancelAnchorRestoreForScope(scrollScopeKey);
    setScrollPhase(scrollScopeKey, 'detached');
  }, [cancelAnchorRestoreForScope, enabled, scrollScopeKey, setScrollPhase]);

  const handleViewportWheel = useCallback((event?: { deltaY?: number }) => {
    if (!enabled) {
      return;
    }
    programmaticScrollRef.current = false;
    markWheelIntent();
    markChatScrollActivity();
    cancelAnchorRestoreForScope(scrollScopeKey);
    if ((event?.deltaY ?? 0) < 0) {
      setScrollPhase(scrollScopeKey, 'detached');
      return;
    }
    const metrics = readViewportMetrics(viewportRef.current);
    if (metrics && isChatViewportNearBottom(metrics, stickyBottomThresholdPx)) {
      setScrollPhase(scrollScopeKey, 'following');
    }
  }, [
    cancelAnchorRestoreForScope,
    enabled,
    markWheelIntent,
    scrollScopeKey,
    setScrollPhase,
    stickyBottomThresholdPx,
    viewportRef,
  ]);

  const jumpToBottom = useCallback(() => {
    if (!enabled) {
      return;
    }
    cancelAnchorRestoreForScope(scrollScopeKey);
    clearTailFollowWindow();
    setScrollPhase(scrollScopeKey, 'following');
    scrollToBottom();
    syncFollowSnapshot();
    if (!tailActivityOpen) {
      armTailFollowWindow();
    }
  }, [
    armTailFollowWindow,
    cancelAnchorRestoreForScope,
    clearTailFollowWindow,
    enabled,
    scrollScopeKey,
    scrollToBottom,
    setScrollPhase,
    syncFollowSnapshot,
    tailActivityOpen,
  ]);

  useLayoutEffect(() => {
    return () => {
      clearInitialAlignSchedule();
      clearAnchorRestoreSchedule();
      clearFollowPulse();
      clearTailFollowWindow();
    };
  }, [clearAnchorRestoreSchedule, clearFollowPulse, clearInitialAlignSchedule, clearTailFollowWindow]);

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
      if (!nextScopeKey) {
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
      if (!nextScopeKey) {
        return;
      }
      pendingScopeTransitionRef.current = {
        targetScopeKey: nextScopeKey,
        mode: 'force-bottom',
      };
      if (nextScopeKey === scrollScopeKey) {
        void activatePendingTransitionForCurrentScope();
      }
    },
    jumpToBottom,
    isBottomLocked,
  };
}
