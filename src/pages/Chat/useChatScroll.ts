import { useCallback, useLayoutEffect, useReducer, useRef } from 'react';
import type { ChatRow } from './chat-row-model';
import {
  createInitialChatScrollState,
  reduceChatScrollState,
  shouldExecuteChatScrollCommand,
  type ChatScrollState,
} from './chat-scroll-machine';

interface ChatVirtualizerLike {
  scrollToIndex: (index: number, options: { align: 'end' }) => void;
}

interface UseChatScrollInput {
  currentSessionKey: string;
  rows: ChatRow[];
  viewportRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  stickyBottomThresholdPx: number;
}

interface ChatViewportMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

interface ChatViewportSizeMetrics {
  scrollHeight: number;
  clientHeight: number;
}

export function isChatViewportNearBottom(
  metrics: ChatViewportMetrics,
  thresholdPx: number,
): boolean {
  const distanceToBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distanceToBottom <= thresholdPx;
}

export function computeBottomLockedScrollTopOnResize(
  previousMetrics: ChatViewportSizeMetrics,
  nextMetrics: ChatViewportSizeMetrics,
  currentScrollTop: number,
): number | null {
  const delta = (
    (nextMetrics.scrollHeight - previousMetrics.scrollHeight)
    - (nextMetrics.clientHeight - previousMetrics.clientHeight)
  );
  if (!Number.isFinite(delta) || Math.abs(delta) <= 0.5) {
    return null;
  }
  return Math.max(0, currentScrollTop + delta);
}

function buildRowSnapshot(rows: ChatRow[]): { lastRowKey: string | null; rowCount: number } {
  return {
    lastRowKey: rows.at(-1)?.key ?? null,
    rowCount: rows.length,
  };
}

function readViewportNearBottom(
  viewport: HTMLDivElement | null,
  stickyBottomThresholdPx: number,
): boolean {
  if (!viewport) {
    return false;
  }
  return isChatViewportNearBottom({
    scrollHeight: viewport.scrollHeight,
    scrollTop: viewport.scrollTop,
    clientHeight: viewport.clientHeight,
  }, stickyBottomThresholdPx);
}

function scheduleNextFrame(task: () => void): void {
  setTimeout(task, 16);
}

const CHAT_SCROLL_COMMAND_MAX_ATTEMPTS = 4;

export function useChatScroll({
  currentSessionKey,
  rows,
  viewportRef,
  contentRef,
  stickyBottomThresholdPx,
}: UseChatScrollInput) {
  const rowSnapshot = buildRowSnapshot(rows);
  const [scrollState, dispatch] = useReducer(
    reduceChatScrollState,
    createInitialChatScrollState({
      sessionKey: currentSessionKey,
      lastRowKey: rowSnapshot.lastRowKey,
      rowCount: rowSnapshot.rowCount,
    }),
  );
  const scrollStateRef = useRef<ChatScrollState>(scrollState);
  const virtualizerRef = useRef<ChatVirtualizerLike | null>(null);
  const viewportReadyRef = useRef<boolean | null>(null);
  const lastResizeMetricsRef = useRef<ChatViewportSizeMetrics | null>(null);
  const lastSessionKeyRef = useRef(currentSessionKey);
  const maybeCompleteBottomCommandRef = useRef<() => void>(() => {});
  const maybeExecutePendingCommandRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    scrollStateRef.current = scrollState;
  }, [scrollState]);

  const maybeCompleteBottomCommand = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const current = scrollStateRef.current;
    if (current.command.type === 'none') {
      return;
    }
    if (!readViewportNearBottom(viewport, stickyBottomThresholdPx)) {
      return;
    }
    dispatch({ type: 'BOTTOM_REACHED' });
  }, [stickyBottomThresholdPx, viewportRef]);

  const maybeExecutePendingCommand = useCallback((instance?: ChatVirtualizerLike | null) => {
    const current = scrollStateRef.current;
    if (!shouldExecuteChatScrollCommand(current)) {
      return;
    }
    if (current.programmaticScrollInFlight) {
      return;
    }

    const targetVirtualizer = instance ?? virtualizerRef.current;
    if (!targetVirtualizer) {
      return;
    }
    dispatch({ type: 'COMMAND_EXECUTION_STARTED' });
    const targetRowCount = current.command.targetRowCount;
    const targetRowKey = current.command.targetRowKey;
    const targetIndex = Math.max(0, targetRowCount - 1);

    const runAttempt = (attempt: number) => {
      const latest = scrollStateRef.current;
      if (
        latest.command.type === 'none'
        || latest.command.targetRowCount !== targetRowCount
        || latest.command.targetRowKey !== targetRowKey
      ) {
        return;
      }
      targetVirtualizer.scrollToIndex(targetIndex, { align: 'end' });
      const viewport = viewportRef.current;
      if (viewport && current.command.type !== 'follow-resize') {
        // Keep jsdom and real browser behavior aligned for open/append bottom follow.
        viewport.scrollTop = viewport.scrollHeight;
      }
      if (viewport && readViewportNearBottom(viewport, stickyBottomThresholdPx)) {
        dispatch({ type: 'BOTTOM_REACHED' });
        return;
      }
      if (attempt >= CHAT_SCROLL_COMMAND_MAX_ATTEMPTS) {
        dispatch({ type: 'BOTTOM_REACHED' });
        return;
      }
      scheduleNextFrame(() => runAttempt(attempt + 1));
    };

    runAttempt(1);
  }, [stickyBottomThresholdPx, viewportRef]);

  useLayoutEffect(() => {
    maybeCompleteBottomCommandRef.current = maybeCompleteBottomCommand;
  }, [maybeCompleteBottomCommand]);

  useLayoutEffect(() => {
    maybeExecutePendingCommandRef.current = () => {
      maybeExecutePendingCommand();
    };
  }, [maybeExecutePendingCommand]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (typeof ResizeObserver !== 'function' || (!viewport && !content)) {
      return;
    }

    const observer = new ResizeObserver(() => {
      let didResize = false;
      const activeViewport = viewportRef.current;
      if (activeViewport) {
        const nextMetrics = {
          scrollHeight: activeViewport.scrollHeight,
          clientHeight: activeViewport.clientHeight,
        };
        const prevMetrics = lastResizeMetricsRef.current;
        const changed = !prevMetrics
          || prevMetrics.scrollHeight !== nextMetrics.scrollHeight
          || prevMetrics.clientHeight !== nextMetrics.clientHeight;
        if (changed) {
          const currentScrollState = scrollStateRef.current;
          let shouldEmitResizeEvent = true;
          if (currentScrollState.mode !== 'detached') {
            const wasNearBottomBeforeResize = prevMetrics
              ? isChatViewportNearBottom({
                scrollHeight: prevMetrics.scrollHeight,
                scrollTop: activeViewport.scrollTop,
                clientHeight: prevMetrics.clientHeight,
              }, stickyBottomThresholdPx)
              : readViewportNearBottom(activeViewport, stickyBottomThresholdPx);
            const shouldLockBottom = (
              wasNearBottomBeforeResize
              || currentScrollState.command.type !== 'none'
              || currentScrollState.mode === 'opening'
            );
            if (shouldLockBottom) {
              if (prevMetrics) {
                const compensatedScrollTop = computeBottomLockedScrollTopOnResize(
                  prevMetrics,
                  nextMetrics,
                  activeViewport.scrollTop,
                );
                if (compensatedScrollTop != null) {
                  activeViewport.scrollTop = compensatedScrollTop;
                }
              }
              // In real browsers this clamps to the true max scrollTop.
              // In jsdom tests this preserves explicit "bottom = scrollHeight".
              activeViewport.scrollTop = nextMetrics.scrollHeight;
              if (readViewportNearBottom(activeViewport, stickyBottomThresholdPx)) {
                shouldEmitResizeEvent = false;
              }
            }
          }
          lastResizeMetricsRef.current = nextMetrics;
          didResize = true;
          if (shouldEmitResizeEvent) {
            dispatch({ type: 'CONTENT_RESIZED' });
          }
        }
      }
      if (didResize) {
        maybeExecutePendingCommandRef.current();
      }
      maybeCompleteBottomCommandRef.current();
    });

    if (viewport) {
      observer.observe(viewport);
      if (lastResizeMetricsRef.current == null) {
        lastResizeMetricsRef.current = {
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight,
        };
      }
    }
    if (content) {
      observer.observe(content);
    }

    return () => observer.disconnect();
  }, [contentRef, stickyBottomThresholdPx, viewportRef]);

  useLayoutEffect(() => {
    if (lastSessionKeyRef.current === currentSessionKey) {
      return;
    }
    lastSessionKeyRef.current = currentSessionKey;
    lastResizeMetricsRef.current = null;
    dispatch({
      type: 'SESSION_SWITCHED',
      sessionKey: currentSessionKey,
      lastRowKey: rowSnapshot.lastRowKey,
      rowCount: rowSnapshot.rowCount,
    });
  }, [currentSessionKey, rowSnapshot.lastRowKey, rowSnapshot.rowCount]);

  useLayoutEffect(() => {
    dispatch({
      type: 'ROWS_CHANGED',
      lastRowKey: rowSnapshot.lastRowKey,
      rowCount: rowSnapshot.rowCount,
    });
  }, [rowSnapshot.lastRowKey, rowSnapshot.rowCount]);

  useLayoutEffect(() => {
    const ready = viewportRef.current != null;
    if (viewportReadyRef.current === ready) {
      return;
    }
    viewportReadyRef.current = ready;
    dispatch({ type: 'VIEWPORT_READY_CHANGED', ready });
  });

  useLayoutEffect(() => {
    maybeExecutePendingCommand();
  }, [
    maybeExecutePendingCommand,
    scrollState.command.type,
    scrollState.command.targetRowCount,
    scrollState.command.targetRowKey,
    scrollState.viewportReady,
  ]);

  const markUserScrollIntent = useCallback(() => {
    dispatch({
      type: 'USER_SCROLL_INTENT',
      atMs: Date.now(),
    });
  }, []);

  const handleViewportScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const isNearBottom = readViewportNearBottom(viewport, stickyBottomThresholdPx);
    dispatch({
      type: 'VIEWPORT_POSITION_CHANGED',
      isNearBottom,
      atMs: Date.now(),
    });
    if (isNearBottom) {
      maybeCompleteBottomCommand();
      return;
    }
  }, [maybeCompleteBottomCommand, stickyBottomThresholdPx, viewportRef]);

  const handleVirtualizerChange = useCallback((instance: ChatVirtualizerLike) => {
    virtualizerRef.current = instance;
    maybeExecutePendingCommand(instance);
  }, [maybeExecutePendingCommand]);

  return {
    handleViewportScroll,
    handleViewportPointerDown: markUserScrollIntent,
    handleViewportTouchMove: markUserScrollIntent,
    handleViewportWheel: markUserScrollIntent,
    handleVirtualizerChange,
    scrollState,
  };
}
