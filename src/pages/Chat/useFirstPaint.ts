import { useEffect, useRef, type MutableRefObject } from 'react';
import { trackUiTiming } from '@/lib/telemetry';

interface SessionPipelineCost {
  sessionKey: string;
  rowSliceMs: number;
  staticRowsMs: number;
  runtimeRowsMs: number;
}

interface UseChatFirstPaintInput {
  currentSessionKey: string;
  rowCount: number;
  isEmptyState: boolean;
  showBlockingLoading: boolean;
  rowSliceCostMs: number;
  sessionPipelineCostRef: MutableRefObject<SessionPipelineCost>;
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function roundTiming(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}

export function useChatFirstPaint(
  input: UseChatFirstPaintInput,
): void {
  const {
    currentSessionKey,
    rowCount,
    isEmptyState,
    showBlockingLoading,
    rowSliceCostMs,
    sessionPipelineCostRef,
  } = input;

  const sessionFirstPaintRef = useRef<{
    sessionKey: string;
    startedAt: number;
    reported: boolean;
  } | null>(null);
  useEffect(() => {
    const now = nowMs();
    sessionFirstPaintRef.current = {
      sessionKey: currentSessionKey,
      startedAt: now,
      reported: false,
    };
    sessionPipelineCostRef.current = {
      sessionKey: currentSessionKey,
      rowSliceMs: 0,
      staticRowsMs: 0,
      runtimeRowsMs: 0,
    };
  }, [currentSessionKey, sessionPipelineCostRef]);

  useEffect(() => {
    if (rowSliceCostMs <= 0) {
      return;
    }
    const cost = sessionPipelineCostRef.current;
    if (cost.sessionKey !== currentSessionKey) {
      return;
    }
    cost.rowSliceMs += rowSliceCostMs;
  }, [currentSessionKey, rowSliceCostMs, sessionPipelineCostRef]);

  useEffect(() => {
    const tracker = sessionFirstPaintRef.current;
    if (!tracker || tracker.reported || tracker.sessionKey !== currentSessionKey) {
      return;
    }
    const hasFirstPaint = !showBlockingLoading && (rowCount > 0 || isEmptyState);
    if (!hasFirstPaint) {
      return;
    }
    const now = nowMs();
    tracker.reported = true;
    const pipelineCost = sessionPipelineCostRef.current;
    trackUiTiming('chat.session_first_paint', Math.max(0, now - tracker.startedAt), {
      sessionKey: currentSessionKey,
      rowCount,
      emptyState: isEmptyState,
      rowSliceMs: pipelineCost.sessionKey === currentSessionKey ? roundTiming(pipelineCost.rowSliceMs) : 0,
      staticRowsMs: pipelineCost.sessionKey === currentSessionKey ? roundTiming(pipelineCost.staticRowsMs) : 0,
      runtimeRowsMs: pipelineCost.sessionKey === currentSessionKey ? roundTiming(pipelineCost.runtimeRowsMs) : 0,
      richRenderDeferred: false,
    });
  }, [currentSessionKey, isEmptyState, rowCount, sessionPipelineCostRef, showBlockingLoading]);
}
