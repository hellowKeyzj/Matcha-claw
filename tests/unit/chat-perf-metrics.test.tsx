import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatRealtimePerfMetrics } from '@/pages/Chat/useChatPerf';

const trackUiEventMock = vi.fn();
const trackUiTimingMock = vi.fn();

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: (...args: unknown[]) => trackUiEventMock(...args),
  trackUiTiming: (...args: unknown[]) => trackUiTimingMock(...args),
}));

describe('chat realtime perf metrics', () => {
  beforeEach(() => {
    trackUiEventMock.mockReset();
    trackUiTimingMock.mockReset();
  });

  it('emits token_render_batch_cost when sending finishes', () => {
    const baseProps = {
      currentSessionKey: 'agent:main:main',
      sending: true,
      streamingMessage: null as unknown,
      streamingTools: [],
      runtimeRowsCostMs: 0,
      chatRowRenderSignal: 0,
    };

    const { rerender } = renderHook((props: typeof baseProps) => useChatRealtimePerfMetrics(props), {
      initialProps: baseProps,
    });

    rerender({
      ...baseProps,
      streamingMessage: { role: 'assistant', content: 'hello' },
      runtimeRowsCostMs: 3.5,
      chatRowRenderSignal: 1,
    });
    rerender({
      ...baseProps,
      streamingMessage: { role: 'assistant', content: 'hello world' },
      runtimeRowsCostMs: 6.25,
      chatRowRenderSignal: 2,
    });
    rerender({
      ...baseProps,
      sending: false,
      runtimeRowsCostMs: 0,
      chatRowRenderSignal: 3,
    });

    expect(trackUiTimingMock).toHaveBeenCalledTimes(1);
    const [eventName, durationMs, payload] = trackUiTimingMock.mock.calls[0] as [
      string,
      number,
      Record<string, unknown>,
    ];

    expect(eventName).toBe('chat.token_render_batch_cost');
    expect(durationMs).toBeCloseTo(9.75, 5);
    expect(payload.sessionKey).toBe('agent:main:main');
    expect(payload.reason).toBe('send-complete');
    expect(payload.batchCount).toBe(2);
    expect(payload.maxBatchCostMs).toBe(6.25);
    expect(payload.tokenUpdates).toBe(2);
    expect(Number(payload.renderPasses)).toBeGreaterThanOrEqual(2);
  });
});
