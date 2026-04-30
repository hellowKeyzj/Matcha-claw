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
      sending: false,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      streamingTools: [],
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
      sending: true,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      streamingTools: [],
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
        { role: 'assistant', content: 'hello', timestamp: 2, id: 'assistant-1', streaming: true },
      ],
    });

    const rowsDuringStreaming = appendRuntimeChatRows({
      sessionKey,
      baseRows,
      sending: true,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      streamingTools: [],
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

  it('does not append a duplicate runtime row once the assistant transcript message already exists', () => {
    const sessionKey = 'agent:main:main';
    const baseRows = buildStaticChatRows({
      sessionKey,
      messages: [
        { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
        { role: 'assistant', content: 'hello world', timestamp: 2, id: 'assistant-1' },
      ],
    });

    const rows = appendRuntimeChatRows({
      sessionKey,
      baseRows,
      sending: false,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      streamingTools: [],
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

  it('decorates the transcript assistant row while streaming is active', () => {
    const sessionKey = 'agent:main:main';
    const baseRows = buildStaticChatRows({
      sessionKey,
      messages: [
        { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
        { role: 'assistant', content: 'hello world', timestamp: 2, id: 'assistant-stream-1', streaming: true },
      ],
    });

    const rows = appendRuntimeChatRows({
      sessionKey,
      baseRows,
      sending: true,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      streamingTools: [],
    });

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      kind: 'message',
      key: 'session:agent:main:main|id:assistant-stream-1',
      isStreaming: true,
      message: {
        id: 'assistant-stream-1',
        content: 'hello world',
      },
    });
  });

  it('does not append optimistic user rows from runtime state anymore', () => {
    const rows = appendRuntimeChatRows({
      sessionKey: 'agent:main:main',
      baseRows: buildStaticChatRows({
        sessionKey: 'agent:main:main',
        messages: [],
      }),
      sending: true,
      pendingFinal: false,
      waitingApproval: false,
      showThinking: false,
      streamingTools: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('typing');
  });
});
