import { useCallback, useEffect, useRef } from 'react';
import { trackUiEvent, trackUiTiming } from '@/lib/telemetry';
import type { ToolStatus } from '@/stores/chat';

const CHAT_SCROLL_FPS_SAMPLE_WINDOW_MS = 1000;
const CHAT_SCROLL_FPS_IDLE_STOP_MS = 220;

interface ScrollFpsSampleState {
  active: boolean;
  frameCount: number;
  sampleStartAt: number;
  lastScrollAt: number;
  rafId: number | null;
}

interface TokenRenderSampleState {
  active: boolean;
  sessionKey: string;
  tokenUpdateCount: number;
  renderPassCount: number;
  batchCount: number;
  totalBatchCostMs: number;
  maxBatchCostMs: number;
  startedAt: number;
  lastStreamingMessageRef: unknown | null;
  lastStreamingToolsRef: unknown | null;
}

interface UseChatRealtimePerfMetricsInput {
  enabled: boolean;
  currentSessionKey: string;
  sending: boolean;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  runtimeRowsCostMs: number;
  chatRowRenderSignal: unknown;
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

export function useChatRealtimePerfMetrics(input: UseChatRealtimePerfMetricsInput): {
  markScrollActivity: () => void;
} {
  const {
    enabled,
    currentSessionKey,
    sending,
    streamingMessage,
    streamingTools,
    runtimeRowsCostMs,
    chatRowRenderSignal,
  } = input;

  const scrollFpsSampleRef = useRef<ScrollFpsSampleState>({
    active: false,
    frameCount: 0,
    sampleStartAt: 0,
    lastScrollAt: 0,
    rafId: null,
  });
  const tokenRenderSampleRef = useRef<TokenRenderSampleState>({
    active: false,
    sessionKey: currentSessionKey,
    tokenUpdateCount: 0,
    renderPassCount: 0,
    batchCount: 0,
    totalBatchCostMs: 0,
    maxBatchCostMs: 0,
    startedAt: 0,
    lastStreamingMessageRef: null,
    lastStreamingToolsRef: null,
  });

  const stopScrollFpsSampler = useCallback((reason: 'idle' | 'unmount' | 'session-change') => {
    const sample = scrollFpsSampleRef.current;
    if (!sample.active) {
      if (sample.rafId != null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(sample.rafId);
      }
      sample.rafId = null;
      return;
    }

    if (sample.rafId != null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(sample.rafId);
    }
    sample.rafId = null;

    const elapsedMs = Math.max(0, nowMs() - sample.sampleStartAt);
    if (sample.frameCount > 0 && elapsedMs > 0) {
      const fps = (sample.frameCount * 1000) / elapsedMs;
      trackUiEvent('chat.scroll_fps_sample', {
        sessionKey: currentSessionKey,
        fps: roundTiming(fps),
        frames: sample.frameCount,
        sampleMs: Math.round(elapsedMs),
        reason,
      });
    }

    sample.active = false;
    sample.frameCount = 0;
    sample.sampleStartAt = 0;
    sample.lastScrollAt = 0;
  }, [currentSessionKey]);

  const markScrollActivity = useCallback(() => {
    if (!enabled) {
      return;
    }
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      return;
    }
    const sample = scrollFpsSampleRef.current;
    const now = nowMs();
    sample.lastScrollAt = now;
    if (sample.active) {
      return;
    }

    sample.active = true;
    sample.frameCount = 0;
    sample.sampleStartAt = now;

    const tick = () => {
      const current = scrollFpsSampleRef.current;
      if (!current.active) {
        current.rafId = null;
        return;
      }
      const frameNow = nowMs();
      current.frameCount += 1;
      const windowElapsedMs = frameNow - current.sampleStartAt;
      if (windowElapsedMs >= CHAT_SCROLL_FPS_SAMPLE_WINDOW_MS) {
        const fps = (current.frameCount * 1000) / windowElapsedMs;
        trackUiEvent('chat.scroll_fps_sample', {
          sessionKey: currentSessionKey,
          fps: roundTiming(fps),
          frames: current.frameCount,
          sampleMs: Math.round(windowElapsedMs),
          reason: 'window',
        });
        current.frameCount = 0;
        current.sampleStartAt = frameNow;
      }

      if ((frameNow - current.lastScrollAt) > CHAT_SCROLL_FPS_IDLE_STOP_MS) {
        stopScrollFpsSampler('idle');
        return;
      }
      current.rafId = window.requestAnimationFrame(tick);
    };

    sample.rafId = window.requestAnimationFrame(tick);
  }, [currentSessionKey, enabled, stopScrollFpsSampler]);

  useEffect(() => {
    if (!enabled) {
      stopScrollFpsSampler('session-change');
      return;
    }
    stopScrollFpsSampler('session-change');
  }, [currentSessionKey, enabled, stopScrollFpsSampler]);

  useEffect(() => {
    return () => {
      stopScrollFpsSampler('unmount');
    };
  }, [stopScrollFpsSampler]);

  const finalizeTokenRenderSample = useCallback((reason: 'send-complete' | 'session-change' | 'unmount') => {
    const sample = tokenRenderSampleRef.current;
    if (!sample.active) {
      return;
    }
    const durationMs = Math.max(0, nowMs() - sample.startedAt);
    trackUiTiming('chat.token_render_batch_cost', sample.totalBatchCostMs, {
      sessionKey: sample.sessionKey,
      batchCount: sample.batchCount,
      avgBatchCostMs: sample.batchCount > 0
        ? roundTiming(sample.totalBatchCostMs / sample.batchCount)
        : 0,
      maxBatchCostMs: roundTiming(sample.maxBatchCostMs),
      tokenUpdates: sample.tokenUpdateCount,
      renderPasses: sample.renderPassCount,
      rendersPerToken: sample.tokenUpdateCount > 0
        ? roundTiming(sample.renderPassCount / sample.tokenUpdateCount)
        : null,
      wallDurationMs: Math.round(durationMs),
      reason,
    });
    sample.active = false;
    sample.tokenUpdateCount = 0;
    sample.renderPassCount = 0;
    sample.batchCount = 0;
    sample.totalBatchCostMs = 0;
    sample.maxBatchCostMs = 0;
    sample.startedAt = 0;
    sample.lastStreamingMessageRef = null;
    sample.lastStreamingToolsRef = null;
  }, []);

  useEffect(() => {
    if (!enabled) {
      finalizeTokenRenderSample('session-change');
      return;
    }
    const sample = tokenRenderSampleRef.current;
    if (!sending) {
      finalizeTokenRenderSample('send-complete');
      return;
    }
    if (sample.active && sample.sessionKey !== currentSessionKey) {
      finalizeTokenRenderSample('session-change');
    }
    if (!sample.active) {
      sample.active = true;
      sample.sessionKey = currentSessionKey;
      sample.tokenUpdateCount = 0;
      sample.renderPassCount = 0;
      sample.batchCount = 0;
      sample.totalBatchCostMs = 0;
      sample.maxBatchCostMs = 0;
      sample.startedAt = nowMs();
      sample.lastStreamingMessageRef = streamingMessage;
      sample.lastStreamingToolsRef = streamingTools;
    }
  }, [currentSessionKey, enabled, finalizeTokenRenderSample, sending, streamingMessage, streamingTools]);

  useEffect(() => {
    return () => {
      finalizeTokenRenderSample('unmount');
    };
  }, [finalizeTokenRenderSample]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const sample = tokenRenderSampleRef.current;
    if (!sample.active || !sending || sample.sessionKey !== currentSessionKey || runtimeRowsCostMs <= 0) {
      return;
    }
    sample.batchCount += 1;
    sample.totalBatchCostMs += runtimeRowsCostMs;
    sample.maxBatchCostMs = Math.max(sample.maxBatchCostMs, runtimeRowsCostMs);
  }, [currentSessionKey, enabled, runtimeRowsCostMs, sending]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const sample = tokenRenderSampleRef.current;
    if (!sample.active || !sending || sample.sessionKey !== currentSessionKey) {
      return;
    }
    sample.renderPassCount += 1;
  }, [chatRowRenderSignal, currentSessionKey, enabled, sending]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const sample = tokenRenderSampleRef.current;
    if (!sample.active || !sending || sample.sessionKey !== currentSessionKey) {
      return;
    }
    const messageChanged = sample.lastStreamingMessageRef !== streamingMessage;
    const toolsChanged = sample.lastStreamingToolsRef !== streamingTools;
    if (messageChanged || toolsChanged) {
      sample.tokenUpdateCount += 1;
      sample.lastStreamingMessageRef = streamingMessage;
      sample.lastStreamingToolsRef = streamingTools;
    }
  }, [currentSessionKey, enabled, sending, streamingMessage, streamingTools]);

  return {
    markScrollActivity,
  };
}
