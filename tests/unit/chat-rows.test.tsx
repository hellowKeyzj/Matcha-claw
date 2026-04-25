import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChatRows } from '@/pages/Chat/useRows';
import type { RawMessage } from '@/stores/chat';
import { appendRuntimeChatRows, buildStaticChatRows } from '@/pages/Chat/chat-row-model';

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

  it('keeps the same row key for one assistant entity from streaming to final commit', () => {
    const sessionKey = 'agent:main:main';
    const baseRows = buildStaticChatRows({
      sessionKey,
      messages: [
        { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
      ],
    });
    const streamingMessage: RawMessage = {
      role: 'assistant',
      content: 'hello',
      timestamp: 2,
      id: 'assistant-1',
    };

    const rowsDuringStreaming = appendRuntimeChatRows({
      sessionKey,
      baseRows,
      sending: true,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      streamingMessage,
      streamingTools: [],
      streamingTimestamp: 2,
    });
    const streamingRow = rowsDuringStreaming[rowsDuringStreaming.length - 1];
    const finalRows = buildStaticChatRows({
      sessionKey,
      messages: [
        { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
        { role: 'assistant', content: 'hello world', timestamp: 2, id: 'assistant-1' },
      ],
    });
    const finalRow = finalRows[finalRows.length - 1];

    expect(streamingRow).toMatchObject({
      kind: 'message',
      isStreaming: true,
      key: 'session:agent:main:main|id:assistant-1',
    });
    expect(finalRow).toMatchObject({
      kind: 'message',
      key: 'session:agent:main:main|id:assistant-1',
    });
  });

  it('patches the matching canonical assistant row instead of appending a second row during final handoff', () => {
    const sessionKey = 'agent:main:main';
    const baseRows = buildStaticChatRows({
      sessionKey,
      messages: [
        { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
        { role: 'assistant', content: 'hello world', timestamp: 2, id: 'assistant-1' },
      ],
    });
    const streamingMessage: RawMessage = {
      role: 'assistant',
      content: 'hello world',
      timestamp: 2,
      id: 'assistant-1',
    };

    const rows = appendRuntimeChatRows({
      sessionKey,
      baseRows,
      sending: false,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      streamingMessage,
      streamingTools: [],
      streamingTimestamp: 2,
    });

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      kind: 'message',
      key: 'session:agent:main:main|id:assistant-1',
      message: {
        id: 'assistant-1',
        content: 'hello world',
      },
    });
  });

  it('appends pending user overlay once and drops it after canonical user exists', () => {
    const sessionKey = 'agent:main:main';
    const pendingUserMessage: RawMessage = {
      role: 'user',
      content: 'draft user',
      timestamp: 1,
      id: 'user-local-1',
    };

    const rowsWithPendingUser = appendRuntimeChatRows({
      sessionKey,
      baseRows: buildStaticChatRows({
        sessionKey,
        messages: [],
      }),
      sending: true,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      pendingUserMessage,
      streamingMessage: null,
      streamingTools: [],
      streamingTimestamp: 0,
    });

    expect(rowsWithPendingUser).toHaveLength(2);
    expect(rowsWithPendingUser[0]).toMatchObject({
      kind: 'message',
      key: 'session:agent:main:main|id:user-local-1',
    });
    expect(rowsWithPendingUser[1]?.kind).toBe('typing');

    const rowsWithCanonicalUser = appendRuntimeChatRows({
      sessionKey,
      baseRows: buildStaticChatRows({
        sessionKey,
        messages: [{
          role: 'user',
          content: 'draft user',
          timestamp: 1,
          id: 'user-local-1',
        }],
      }),
      sending: true,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      pendingUserMessage,
      streamingMessage: null,
      streamingTools: [],
      streamingTimestamp: 0,
    });

    expect(rowsWithCanonicalUser.filter((row) => row.kind === 'message')).toHaveLength(1);
  });
});
