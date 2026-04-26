import { useEffect, useRef, type MutableRefObject } from 'react';
import { trackUiEvent, trackUiTiming } from '@/lib/telemetry';

interface SessionPipelineCost {
  sessionKey: string;
  rowSliceMs: number;
  staticRowsMs: number;
  runtimeRowsMs: number;
}

interface UseChatFirstPaintInput {
  enabled: boolean;
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

function emitBlockingLoadingDuration(payload: {
  sessionKey: string;
  startedAt: number;
  source: 'initial' | 'switch';
  fromSessionKey: string | null;
}): void {
  const durationMs = Math.max(0, nowMs() - payload.startedAt);
  trackUiEvent('chat.session_blocking_loading_duration', {
    sessionKey: payload.sessionKey,
    durationMs: Math.round(durationMs),
    source: payload.source,
    ...(payload.fromSessionKey ? { fromSessionKey: payload.fromSessionKey } : {}),
  });
}

export function useChatFirstPaint(
  input: UseChatFirstPaintInput,
): void {
  const {
    enabled,
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
    source: 'initial' | 'switch';
    fromSessionKey: string | null;
  } | null>(null);
  const blockingLoadingRef = useRef<{
    sessionKey: string;
    startedAt: number;
    source: 'initial' | 'switch';
    fromSessionKey: string | null;
  } | null>(null);
  const previousSessionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      sessionFirstPaintRef.current = null;
      blockingLoadingRef.current = null;
      return;
    }
    if (blockingLoadingRef.current) {
      emitBlockingLoadingDuration(blockingLoadingRef.current);
      blockingLoadingRef.current = null;
    }
    const now = nowMs();
    const previousSessionKey = previousSessionKeyRef.current;
    const source: 'initial' | 'switch' = previousSessionKey == null ? 'initial' : 'switch';
    sessionFirstPaintRef.current = {
      sessionKey: currentSessionKey,
      startedAt: now,
      reported: false,
      source,
      fromSessionKey: source === 'switch' ? previousSessionKey : null,
    };
    previousSessionKeyRef.current = currentSessionKey;
    sessionPipelineCostRef.current = {
      sessionKey: currentSessionKey,
      rowSliceMs: 0,
      staticRowsMs: 0,
      runtimeRowsMs: 0,
    };
  }, [currentSessionKey, enabled, sessionPipelineCostRef]);

  useEffect(() => {
    if (!enabled || rowSliceCostMs <= 0) {
      return;
    }
    const cost = sessionPipelineCostRef.current;
    if (cost.sessionKey !== currentSessionKey) {
      return;
    }
    cost.rowSliceMs += rowSliceCostMs;
  }, [currentSessionKey, enabled, rowSliceCostMs, sessionPipelineCostRef]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const activeBlockingTracker = blockingLoadingRef.current;
    if (showBlockingLoading) {
      if (activeBlockingTracker?.sessionKey === currentSessionKey) {
        return;
      }
      if (activeBlockingTracker && activeBlockingTracker.sessionKey !== currentSessionKey) {
        emitBlockingLoadingDuration(activeBlockingTracker);
      }
      const firstPaintTracker = sessionFirstPaintRef.current;
      const source = firstPaintTracker?.sessionKey === currentSessionKey
        ? firstPaintTracker.source
        : 'switch';
      const fromSessionKey = firstPaintTracker?.sessionKey === currentSessionKey
        ? firstPaintTracker.fromSessionKey
        : null;
      blockingLoadingRef.current = {
        sessionKey: currentSessionKey,
        startedAt: nowMs(),
        source,
        fromSessionKey,
      };
      trackUiEvent('chat.session_blocking_loading_shown', {
        sessionKey: currentSessionKey,
        source,
        ...(fromSessionKey ? { fromSessionKey } : {}),
      });
      return;
    }

    if (activeBlockingTracker?.sessionKey === currentSessionKey) {
      emitBlockingLoadingDuration(activeBlockingTracker);
      blockingLoadingRef.current = null;
    }
  }, [currentSessionKey, enabled, showBlockingLoading]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
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
      source: tracker.source,
      ...(tracker.fromSessionKey ? { fromSessionKey: tracker.fromSessionKey } : {}),
    });
  }, [currentSessionKey, enabled, isEmptyState, rowCount, sessionPipelineCostRef, showBlockingLoading]);

  useEffect(() => () => {
    if (blockingLoadingRef.current) {
      emitBlockingLoadingDuration(blockingLoadingRef.current);
      blockingLoadingRef.current = null;
    }
  }, []);
}
