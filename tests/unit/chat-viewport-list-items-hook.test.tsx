import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useViewportListItems } from '@/pages/Chat/viewport-list-items';
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

describe('useViewportListItems live list timing', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('builds one stable viewport list immediately and updates it without staged tail replay', () => {
    const sessionPipelineCostRef = {
      current: {
        sessionKey: 'agent:main:main::latest',
        staticRowsMs: 0,
        runtimeRowsMs: 0,
      },
    };
    const initialMessages = buildMessages(40);
    const initialProps = {
      scopeKey: 'agent:main:main::latest',
      sessionKey: 'agent:main:main',
      messages: initialMessages,
      agents: [],
      isGatewayRunning: true,
      gatewayRpc: vi.fn(),
      sending: false,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      streamingMessage: null,
      streamingTools: [],
      sessionPipelineCostRef,
    };

    const { result, rerender } = renderHook((props: typeof initialProps) => useViewportListItems(props), {
      initialProps,
    });

    expect(result.current.items.filter((item) => item.kind === 'message')).toHaveLength(initialMessages.length);

    const nextMessages = [...initialMessages, {
      id: 'message-41',
      role: 'user' as const,
      content: 'message 41',
      timestamp: 41,
    }];

    rerender({
      ...initialProps,
      messages: nextMessages,
    });

    expect(result.current.items.filter((item) => item.kind === 'message')).toHaveLength(nextMessages.length);
  });
});
