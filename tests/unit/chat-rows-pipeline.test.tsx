import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRowsPipeline } from '@/pages/Chat/useRowsPipeline';
import { projectLiveThreadMessages } from '@/pages/Chat/live-thread-projection';
import type { RawMessage } from '@/stores/chat';

vi.mock('@/lib/idle-ready', () => ({
  scheduleIdleReady: () => () => {},
}));

vi.mock('@/pages/Chat/useExecutionGraphs', () => ({
  useExecutionGraphs: () => ({
    executionGraphs: [],
    suppressedToolCardRowKeys: new Set<string>(),
  }),
}));

function buildMessages(count: number): RawMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1}`,
    timestamp: index + 1,
  }));
}

describe('useRowsPipeline live projection timing', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses one stable live projection immediately and does not replay a staged first-paint tail', () => {
    const sessionPipelineCostRef = {
      current: {
        sessionKey: 'agent:main:main::live',
        rowSliceMs: 0,
        staticRowsMs: 0,
        runtimeRowsMs: 0,
      },
    };
    const initialMessages = buildMessages(40);
    const initialProps = {
      projectionScopeKey: 'agent:main:main::live',
      rowSessionKey: 'agent:main:main',
      canonicalMessages: initialMessages,
      projectionMessages: [] as RawMessage[],
      isHistoryProjection: false,
      agents: [],
      isGatewayRunning: true,
      gatewayRpc: vi.fn(),
      sending: false,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      streamingMessage: null,
      streamingTools: [],
      streamingTimestamp: 0,
      sessionPipelineCostRef,
    };

    const { result, rerender } = renderHook((props: typeof initialProps) => useRowsPipeline(props), {
      initialProps,
    });

    const initialLiveProjection = projectLiveThreadMessages(initialMessages);
    expect(result.current.hiddenHistoryCount).toBe(initialLiveProjection.hiddenRenderableCount);
    expect(result.current.chatRows.filter((row) => row.kind === 'message')).toHaveLength(initialLiveProjection.messages.length);

    const nextMessages = [...initialMessages, {
      id: 'message-41',
      role: 'user' as const,
      content: 'message 41',
      timestamp: 41,
    }];
    const nextLiveProjection = projectLiveThreadMessages(nextMessages);

    rerender({
      ...initialProps,
      canonicalMessages: nextMessages,
    });

    expect(result.current.hiddenHistoryCount).toBe(nextLiveProjection.hiddenRenderableCount);
    expect(result.current.chatRows.filter((row) => row.kind === 'message')).toHaveLength(nextLiveProjection.messages.length);
  });
});
