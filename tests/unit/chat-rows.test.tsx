import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChatRows } from '@/pages/Chat/useRows';
import type { RawMessage } from '@/stores/chat';

describe('chat row pipeline hook', () => {
  it('builds rows from renderable messages and filters tool_result messages', () => {
    const rowSourceMessages: RawMessage[] = [
      { role: 'assistant', content: 'a1', timestamp: 1 },
      { role: 'tool_result', content: 'tool', timestamp: 2 },
      { role: 'user', content: 'u1', timestamp: 3 },
    ];

    const { result } = renderHook(() => useChatRows({
      currentSessionKey: 'agent:main:main',
      rowSourceMessages,
      executionGraphs: [],
      sending: false,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      streamingMessage: null,
      streamingTools: [],
      streamingTimestamp: 0,
    }));

    expect(result.current.chatRows).toHaveLength(2);
    expect(result.current.chatRows.every((row) => row.kind === 'message')).toBe(true);
    expect(result.current.staticRowsCostMs).toBeGreaterThanOrEqual(0);
    expect(result.current.runtimeRowsCostMs).toBeGreaterThanOrEqual(0);
  });

  it('appends runtime typing row when sending without stream/final', () => {
    const rowSourceMessages: RawMessage[] = [
      { role: 'assistant', content: 'a1', timestamp: 1 },
    ];

    const { result } = renderHook(() => useChatRows({
      currentSessionKey: 'agent:main:main',
      rowSourceMessages,
      executionGraphs: [],
      sending: true,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      streamingMessage: null,
      streamingTools: [],
      streamingTimestamp: 0,
    }));

    const lastRow = result.current.chatRows[result.current.chatRows.length - 1];
    expect(lastRow?.kind).toBe('typing');
  });
});

