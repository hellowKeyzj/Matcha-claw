import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import type { RawMessage } from '@/stores/chat';
import { getSessionApprovalStatus } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { findCurrentStreamingMessage } from '@/stores/chat/streaming-message';

function createSessionRecord(input?: {
  messages?: RawMessage[];
  runtime?: Partial<ReturnType<typeof useChatStore.getState>['loadedSessions'][string]['runtime']>;
}) {
  const messages = input?.messages ?? [];
  return {
    meta: {
      label: null,
      lastActivityAt: null,
      historyStatus: 'ready' as const,
      thinkingLevel: null,
    },
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'idle' as const,
      streamingMessageId: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle' as const,
      ...input?.runtime,
    },
    messages,
    window: createViewportWindowState({
      totalMessageCount: messages.length,
      windowStartOffset: 0,
      windowEndOffset: messages.length,
      isAtLatest: true,
    }),
  };
}

function createStreamingAssistantMessage(id: string, content: RawMessage['content'], timestamp: number): RawMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp,
    streaming: true,
  };
}

function resetChatStoreForApprovalTests() {
  useChatStore.setState({
    loadedSessions: {
      'agent:main:main': createSessionRecord(),
    },
    snapshotReady: false,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    sessionCatalogStatus: {
      status: 'ready',
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: 1,
    },
    currentSessionKey: 'agent:main:main',
    showThinking: true,
    pendingApprovalsBySession: {},
  } as never);
}

function dispatchConversationMessageEvent(event: Record<string, unknown>): void {
  useChatStore.getState().handleConversationEvent({
    kind: 'chat.message',
    source: 'chat.message',
    phase: typeof event.state === 'string' && event.state.trim().toLowerCase() === 'delta' ? 'delta' : (
      typeof event.state === 'string' && ['final', 'completed', 'done', 'finished', 'end'].includes(event.state.trim().toLowerCase())
        ? 'final'
        : 'unknown'
    ),
    runId: typeof event.runId === 'string' ? event.runId : null,
    sessionKey: typeof event.sessionKey === 'string' ? event.sessionKey : null,
    event,
  });
}

describe('chat 审批等待态流程', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChatStoreForApprovalTests();
  });

  it('发生 chat.send 超时提示后，只要收到 delta 事件就应清理陈旧错误', () => {
    useChatStore.setState({
      error: 'RPC timeout: chat.send',
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            sending: true,
          },
        }),
      },
    } as never);

    dispatchConversationMessageEvent({
      state: 'delta',
      runId: 'run-delta-recover',
      message: {
        role: 'assistant',
        content: 'working...',
      },
    });

    const state = useChatStore.getState() as unknown as {
      error: string | null;
    };
    expect(state.error).toBeNull();
  });


  it('delta 事件应先写入当前流式 assistant 消息，而不是额外造第二份显示态', () => {
    useChatStore.setState({
      error: null,
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            sending: true,
            activeRunId: 'run-delta-batched',
            lastUserMessageAt: 1_700_000_000_000,
          },
        }),
      },
    } as never);

    dispatchConversationMessageEvent({
      state: 'delta',
      runId: 'run-delta-batched',
      message: {
        role: 'assistant',
        content: 'hello world',
      },
    });

    const state = useChatStore.getState();
    const runtime = state.loadedSessions['agent:main:main']?.runtime;
    const streamingMessage = findCurrentStreamingMessage(
      state.loadedSessions['agent:main:main']?.messages ?? [],
      runtime?.streamingMessageId ?? null,
    );
    expect(runtime?.streamingMessageId).toBe('stream:run-delta-batched');
    expect(streamingMessage?.content).toBe('hello world');
  });

  it('增量 chunk 应按追加语义进入同一条流式消息，而不是把已有文本覆盖掉', () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          messages: [
            createStreamingAssistantMessage('assistant-1', 'hello', 1_700_000_000),
          ],
          runtime: {
            sending: true,
            activeRunId: 'run-delta-append',
            runPhase: 'streaming',
            lastUserMessageAt: 1_700_000_000_000,
            streamingMessageId: 'assistant-1',
          },
        }),
      },
    } as never);

    dispatchConversationMessageEvent({
      state: 'delta',
      runId: 'run-delta-append',
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: ' world',
      },
    });

    const state = useChatStore.getState();
    const runtime = state.loadedSessions['agent:main:main']?.runtime;
    const streamingMessage = findCurrentStreamingMessage(
      state.loadedSessions['agent:main:main']?.messages ?? [],
      runtime?.streamingMessageId ?? null,
    );
    expect(streamingMessage?.content).toBe('hello world');
  });

  it('tool-only delta 不能把当前可见 assistant 文本冲掉', () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          messages: [
            createStreamingAssistantMessage('assistant-1', 'hello', 1_700_000_000),
          ],
          runtime: {
            sending: true,
            activeRunId: 'run-delta-tool',
            runPhase: 'streaming',
            lastUserMessageAt: 1_700_000_000_000,
            streamingMessageId: 'assistant-1',
          },
        }),
      },
    } as never);

    dispatchConversationMessageEvent({
      state: 'delta',
      runId: 'run-delta-tool',
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'shell', input: { command: 'pwd' } },
        ],
      },
    });

    const state = useChatStore.getState();
    const runtime = state.loadedSessions['agent:main:main']?.runtime;
    const streamingMessage = findCurrentStreamingMessage(
      state.loadedSessions['agent:main:main']?.messages ?? [],
      runtime?.streamingMessageId ?? null,
    );
    expect(streamingMessage?.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'tool-1', name: 'shell', input: { command: 'pwd' } },
    ]);
  });

  it('停止时应先 deny 当前会话 pending 审批，再 chat.abort', async () => {
    const rpcMock = vi.fn(async () => ({}));
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: rpcMock,
    } as never);

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      pendingApprovalsBySession: {
        'agent:main:main': [
          {
            id: 'approval-a',
            sessionKey: 'agent:main:main',
            createdAtMs: Date.now(),
          },
          {
            id: 'approval-b',
            sessionKey: 'agent:main:main',
            createdAtMs: Date.now(),
          },
        ],
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            sending: true,
            pendingFinal: true,
          },
        }),
      },
    } as never);

    await useChatStore.getState().abortRun();

    const calls = rpcMock.mock.calls.map((call) => ({
      method: call[0],
      params: call[1],
    }));
    expect(calls[0]).toEqual({
      method: 'exec.approval.resolve',
      params: { id: 'approval-a', decision: 'deny' },
    });
    expect(calls[1]).toEqual({
      method: 'exec.approval.resolve',
      params: { id: 'approval-b', decision: 'deny' },
    });
    expect(calls[2]).toEqual({
      method: 'chat.abort',
      params: { sessionKey: 'agent:main:main' },
    });
  });

  it('收到当前会话审批请求时应清理流式占位，确保审批按钮可见', () => {
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          messages: [
            createStreamingAssistantMessage('assistant-visible', '正在调用工具...', Date.now() / 1000),
          ],
          runtime: {
            sending: true,
            pendingFinal: true,
            approvalStatus: 'idle',
            streamingMessageId: 'assistant-visible',
            streamingTools: [
              {
                id: 'tool-1',
                name: 'web_search',
                status: 'running',
                updatedAt: Date.now(),
              },
            ],
          },
        }),
      },
    } as never);

    useChatStore.getState().handleApprovalRequested({
      id: 'approval-visible',
      sessionKey: 'agent:main:main',
      runId: 'run-visible',
      toolName: 'web_search',
      createdAt: Date.now(),
    });

    const state = useChatStore.getState();
    const runtime = state.loadedSessions['agent:main:main']?.runtime;
    expect(getSessionApprovalStatus(state, 'agent:main:main')).toBe('awaiting_approval');
    expect(runtime?.streamingMessageId).toBeNull();
    expect((state.pendingApprovalsBySession['agent:main:main'] ?? []).some((item) => item.id === 'approval-visible')).toBe(true);
  });

  it('syncPendingApprovals 在补拉为空时应清理当前会话过期审批', async () => {
    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'exec.approvals.get') {
        return { approvals: [] };
      }
      return {};
    });
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: rpcMock,
    } as never);

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      pendingApprovalsBySession: {
        'agent:main:main': [
          {
            id: 'stale-approval',
            sessionKey: 'agent:main:main',
            createdAtMs: Date.now() - 1000,
          },
        ],
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            approvalStatus: 'awaiting_approval',
          },
        }),
      },
    } as never);

    await useChatStore.getState().syncPendingApprovals('agent:main:main');

    const state = useChatStore.getState();
    expect(getSessionApprovalStatus(state, 'agent:main:main')).toBe('idle');
    expect(state.pendingApprovalsBySession['agent:main:main']).toEqual([]);
  });
});
