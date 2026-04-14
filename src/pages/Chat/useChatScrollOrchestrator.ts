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

interface UseChatScrollOrchestratorInput {
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

export function isChatViewportNearBottom(
  metrics: ChatViewportMetrics,
  thresholdPx: number,
): boolean {
  const distanceToBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distanceToBottom <= thresholdPx;
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

export function useChatScrollOrchestrator({
  currentSessionKey,
  rows,
  viewportRef,
  contentRef,
  stickyBottomThresholdPx,
}: UseChatScrollOrchestratorInput) {
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
  const lastResizeMetricsRef = useRef<{ scrollHeight: number; clientHeight: number } | null>(null);
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

  const forceCompleteBottomCommand = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
    dispatch({ type: 'BOTTOM_REACHED' });
  }, [viewportRef]);

  const maybeExecutePendingCommand = useCallback((instance?: ChatVirtualizerLike | null) => {
    const current = scrollStateRef.current;
    if (!shouldExecuteChatScrollCommand(current)) {
      return;
    }
    if (current.programmaticScrollInFlight) {
      return;
    }

    if (current.command.type === 'follow-resize') {
      dispatch({ type: 'COMMAND_EXECUTION_STARTED' });
      forceCompleteBottomCommand();
      return;
    }

    const targetVirtualizer = instance ?? virtualizerRef.current;
    if (!targetVirtualizer) {
      return;
    }
    dispatch({ type: 'COMMAND_EXECUTION_STARTED' });
    targetVirtualizer.scrollToIndex(current.command.targetRowCount - 1, { align: 'end' });
    scheduleNextFrame(() => {
      const latest = scrollStateRef.current;
      if (
        latest.command.type === 'none'
        || latest.command.targetRowCount !== current.command.targetRowCount
        || latest.command.targetRowKey !== current.command.targetRowKey
      ) {
        return;
      }
      forceCompleteBottomCommand();
    });
  }, [forceCompleteBottomCommand]);

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
          lastResizeMetricsRef.current = nextMetrics;
          didResize = true;
          dispatch({ type: 'CONTENT_RESIZED' });
        }
      }
      if (didResize) {
        maybeExecutePendingCommandRef.current();
      }
      maybeCompleteBottomCommandRef.current();
    });

    if (viewport) {
      observer.observe(viewport);
    }
    if (content) {
      observer.observe(content);
    }

    return () => observer.disconnect();
  }, [contentRef, viewportRef]);

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
