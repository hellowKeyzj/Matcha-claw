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
  const userScrollIntentRef = useRef(false);

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
    const targetVirtualizer = instance ?? virtualizerRef.current;
    if (!targetVirtualizer) {
      return;
    }
    const current = scrollStateRef.current;
    if (!shouldExecuteChatScrollCommand(current)) {
      return;
    }
    targetVirtualizer.scrollToIndex(current.command.targetRowCount - 1, { align: 'end' });
    maybeCompleteBottomCommand();
  }, [maybeCompleteBottomCommand]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (typeof ResizeObserver !== 'function' || (!viewport && !content)) {
      return;
    }

    const observer = new ResizeObserver(() => {
      maybeExecutePendingCommand();
      maybeCompleteBottomCommand();
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
    currentSessionKey,
    maybeCompleteBottomCommand,
    maybeExecutePendingCommand,
    rows.length,
    viewportRef,
  ]);

  useLayoutEffect(() => {
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
    dispatch({
      type: 'VIEWPORT_READY_CHANGED',
      ready: viewportRef.current != null,
    });
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

  const handleViewportScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const isNearBottom = readViewportNearBottom(viewport, stickyBottomThresholdPx);
    dispatch({
      type: 'VIEWPORT_POSITION_CHANGED',
      isNearBottom,
    });
    if (isNearBottom) {
      maybeCompleteBottomCommand();
      userScrollIntentRef.current = false;
      return;
    }
    if (userScrollIntentRef.current) {
      dispatch({ type: 'USER_DETACHED' });
    }
    userScrollIntentRef.current = false;
  }, [maybeCompleteBottomCommand, stickyBottomThresholdPx, viewportRef]);

  const handleVirtualizerChange = useCallback((instance: ChatVirtualizerLike) => {
    virtualizerRef.current = instance;
    maybeExecutePendingCommand(instance);
  }, [maybeExecutePendingCommand]);

  return {
    handleViewportScroll,
    handleViewportPointerDown: () => {
      userScrollIntentRef.current = true;
    },
    handleViewportTouchMove: () => {
      userScrollIntentRef.current = true;
    },
    handleViewportWheel: () => {
      userScrollIntentRef.current = true;
    },
    handleVirtualizerChange,
    scrollState,
  };
}
