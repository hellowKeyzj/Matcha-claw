import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { resetToolSnapshotTxnState } from '@/stores/chat/tool-snapshot-txn';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

function buildSessionRecord(overrides?: Partial<ReturnType<typeof createEmptySessionRecord>>) {
  const base = createEmptySessionRecord();
  return {
    meta: {
      ...base.meta,
      ...overrides?.meta,
    },
    runtime: {
      ...base.runtime,
      ...overrides?.runtime,
    },
    window: overrides?.window ?? base.window,
  };
}

function extractAssistantText(message: RawMessage): string {
  if (typeof message.content === 'string') {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) {
    return '';
  }
  return message.content
    .filter((block): block is { type: string; text?: string } => typeof block === 'object' && block != null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!.trim())
    .filter(Boolean)
    .join('\n');
}

function getAssistantMessages(): RawMessage[] {
  return (useChatStore.getState().loadedSessions['agent:main:main']?.window.messages ?? []).filter((message) => message.role === 'assistant');
}

function getStreamingMessage(): RawMessage | null {
  const state = useChatStore.getState();
  const record = state.loadedSessions['agent:main:main'];
  const streamingMessageId = record?.runtime.streamingMessageId ?? null;
  const messages = record?.window.messages ?? [];
  if (streamingMessageId) {
    return messages.find((message) => message.id === streamingMessageId) ?? null;
  }
  return messages.find((message) => message.role === 'assistant' && message.streaming) ?? null;
}

async function drainStreamPacer(): Promise<void> {
  await vi.runAllTimersAsync();
}

function resetChatState(partial: Record<string, unknown> = {}): void {
  useChatStore.setState({
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    pendingApprovalsBySession: {},
    sessionMetasResource: {
      status: 'ready',
      data: [{ key: 'agent:main:main', displayName: 'agent:main:main' }],
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: 1,
    },
    currentSessionKey: 'agent:main:main',
    loadedSessions: {
      'agent:main:main': buildSessionRecord({
        meta: {
          ready: true,
        },
        runtime: {
          sending: true,
          activeRunId: 'run-1',
          runPhase: 'streaming',
          lastUserMessageAt: Date.now(),
        },
      }),
    },
    showThinking: true,
    loadHistory: vi.fn().mockResolvedValue(undefined),
    ...partial,
  } as never);
}

describe('chat.handleChatEvent 工具回合快照去重', () => {
  beforeEach(() => {
    resetToolSnapshotTxnState();
    vi.useRealTimers();
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: vi.fn(),
    } as never);
    resetChatState();
  });

  afterEach(() => {
    resetToolSnapshotTxnState();
    vi.useRealTimers();
  });

  it('工具回合快照带有自然语言文本时，后续最终回复不应再出现同文案重复两条', async () => {
    vi.useFakeTimers();
    resetChatState({
      loadedSessions: {
        'agent:main:main': buildSessionRecord({
          window: createViewportWindowState({
            messages: [{
              role: 'assistant',
              id: 'stream-tool-turn',
              streaming: true,
              content: [
                { type: 'text', text: '在。' },
                {
                  type: 'tool_use',
                  id: 'tool-call-1',
                  name: 'task_decision',
                  input: { decision: 'direct' },
                },
              ],
            }],
            totalMessageCount: 1,
            windowStartOffset: 0,
            windowEndOffset: 1,
            isAtLatest: true,
          }),
          meta: {
            ready: true,
          },
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            lastUserMessageAt: Date.now(),
            streamingMessageId: 'stream-tool-turn',
          },
        }),
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'toolresult',
        toolCallId: 'tool-call-1',
        content: '',
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-final-1',
        content: '在。',
      },
    });

    await drainStreamPacer();

    const assistantMessages = getAssistantMessages();
    const assistantTexts = assistantMessages.map(extractAssistantText);

    expect(assistantMessages).toHaveLength(2);
    expect(assistantTexts.filter((text) => text === '在。')).toHaveLength(1);
    expect(assistantMessages[0]?.content).toEqual([
      {
        type: 'tool_use',
        id: 'tool-call-1',
        name: 'task_decision',
        input: { decision: 'direct' },
      },
    ]);
  });

  it('tool-only delta 写入单条 streaming assistant 后，toolresult final 也不能丢工具回合快照', () => {
    resetChatState({
      loadedSessions: {
        'agent:main:main': buildSessionRecord({
          meta: {
            ready: true,
          },
          runtime: {
            sending: true,
            activeRunId: 'run-frame-flush',
            runPhase: 'submitted',
          },
        }),
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-frame-flush',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'stream-tool-turn',
        content: [
          {
            type: 'tool_use',
            id: 'tool-call-flush',
            name: 'task_decision',
            input: { decision: 'direct' },
          },
        ],
      },
    });

    expect(getStreamingMessage()).toMatchObject({
      id: 'stream-tool-turn',
      streaming: true,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-frame-flush',
      sessionKey: 'agent:main:main',
      message: {
        role: 'toolresult',
        toolCallId: 'tool-call-flush',
        content: '',
      },
    });

    const assistantMessages = getAssistantMessages();
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toEqual([
      {
        type: 'tool_use',
        id: 'tool-call-flush',
        name: 'task_decision',
        input: { decision: 'direct' },
      },
    ]);
  });

  it('delta 流式期间直接更新 transcript 里的单条 assistant message', () => {
    resetChatState({
      loadedSessions: {
        'agent:main:main': buildSessionRecord({
          meta: {
            ready: true,
          },
          runtime: {
            sending: true,
            activeRunId: 'run-streaming-only',
            runPhase: 'submitted',
            lastUserMessageAt: Date.now(),
          },
        }),
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-streaming-only',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-stream-1',
        content: 'hello world',
      },
    });

    expect(useChatStore.getState().loadedSessions['agent:main:main']?.window.messages).toMatchObject([{
      role: 'assistant',
      id: 'assistant-stream-1',
      content: 'hello world',
      streaming: true,
    }]);
    expect(getStreamingMessage()).toMatchObject({
      id: 'assistant-stream-1',
      content: 'hello world',
    });
  });

  it('authoritative user final 到达时，应与 pending user overlay 合并而不是新增一条', () => {
    const sentAtMs = Date.now();
    resetChatState({
      loadedSessions: {
        'agent:main:main': buildSessionRecord({
          meta: {
            ready: true,
          },
          runtime: {
            sending: true,
            activeRunId: 'run-user-merge-1',
            runPhase: 'streaming',
            lastUserMessageAt: sentAtMs,
            pendingUserMessage: {
              clientMessageId: 'optimistic-user-1',
              createdAtMs: sentAtMs,
              message: {
                role: 'user',
                id: 'optimistic-user-1',
                content: '你能做什么',
                timestamp: sentAtMs / 1000,
              },
            },
          },
        }),
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-user-merge-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'user',
        id: 'gateway-user-1',
        content: '[Tue 2026-04-14 20:11 GMT+8]你能做什么 [message_id: optimistic-user-1]',
        timestamp: (sentAtMs + 1200) / 1000,
      },
    });

    const userMessages = (useChatStore.getState().loadedSessions['agent:main:main']?.window.messages ?? []).filter((message) => message.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.id).toBe('optimistic-user-1');
    expect(useChatStore.getState().loadedSessions['agent:main:main']?.runtime.pendingUserMessage).toBeNull();
  });

  it('toolresult final 不应把纯文本 streaming assistant 快照进 messages，避免后续 assistant final 重复', async () => {
    vi.useFakeTimers();
    resetChatState({
      loadedSessions: {
        'agent:main:main': buildSessionRecord({
          window: createViewportWindowState({
            messages: [{
              role: 'assistant',
              id: 'stream-plain-assistant',
              content: '好的，我来处理。',
              streaming: true,
            }],
            totalMessageCount: 1,
            windowStartOffset: 0,
            windowEndOffset: 1,
            isAtLatest: true,
          }),
          meta: {
            ready: true,
          },
          runtime: {
            sending: true,
            activeRunId: 'run-toolresult-no-toolcall',
            runPhase: 'streaming',
            lastUserMessageAt: Date.now(),
            streamingMessageId: 'stream-plain-assistant',
          },
        }),
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-toolresult-no-toolcall',
      sessionKey: 'agent:main:main',
      message: {
        role: 'toolresult',
        toolCallId: 'tool-call-noop',
        content: '',
      },
    });

    expect(getAssistantMessages()).toHaveLength(0);

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-toolresult-no-toolcall',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-final-no-dup',
        content: '好的，我来处理。',
      },
    });

    await drainStreamPacer();

    const assistantMessages = getAssistantMessages();
    const assistantTexts = assistantMessages.map(extractAssistantText);

    expect(assistantTexts.filter((text) => text === '好的，我来处理。')).toHaveLength(1);
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.id).toBe('assistant-final-no-dup');
  });

  it('同一轮 assistant final 文本一致但 id 不同，应按语义去重并保留本地 streaming message id', () => {
    resetChatState({
      loadedSessions: {
        'agent:main:main': buildSessionRecord({
          window: createViewportWindowState({
            messages: [
              {
                role: 'assistant',
                id: 'stream-assistant',
                content: '你好呀，我在。',
                streaming: true,
              },
            ],
            totalMessageCount: 1,
            windowStartOffset: 0,
            windowEndOffset: 1,
            isAtLatest: true,
          }),
          meta: {
            ready: true,
          },
          runtime: {
            sending: true,
            activeRunId: 'run-assistant-semantic-dedup',
            runPhase: 'streaming',
            pendingFinal: true,
            lastUserMessageAt: Date.now(),
            streamingMessageId: 'stream-assistant',
          },
        }),
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-assistant-semantic-dedup',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-final-b',
        content: '你好呀，我在。',
      },
    });

    const assistantMessages = getAssistantMessages();
    const assistantTexts = assistantMessages.map(extractAssistantText);

    expect(assistantTexts.filter((text) => text === '你好呀，我在。')).toHaveLength(1);
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.id).toBe('stream-assistant');
  });
});


