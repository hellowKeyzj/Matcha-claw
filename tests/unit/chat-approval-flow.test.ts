import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { createAssistantOverlay, selectStreamingRenderMessage } from '@/stores/chat/stream-overlay-message';
import type { RawMessage } from '@/stores/chat';

function createSessionRecord(input?: {
  transcript?: RawMessage[];
  runtime?: Partial<ReturnType<typeof useChatStore.getState>['sessionsByKey'][string]['runtime']>;
}) {
  return {
    transcript: input?.transcript ?? [],
    meta: {
      label: null,
      lastActivityAt: null,
      ready: true,
      thinkingLevel: null,
    },
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'idle' as const,
      assistantOverlay: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle' as const,
      ...input?.runtime,
    },
  };
}

function resetChatStoreForApprovalTests() {
  useChatStore.setState({
    sessionsByKey: {
      'agent:main:main': createSessionRecord(),
    },
    snapshotReady: false,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    sessions: [{ key: 'agent:main:main', displayName: 'agent:main:main' }],
    currentSessionKey: 'agent:main:main',
    showThinking: true,
    pendingApprovalsBySession: {},
  } as never);
}

describe('chat 审批等待态流程', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChatStoreForApprovalTests();
  });

  it('发生 chat.send 超时提示后，只要收到 delta 事件就应清理陈旧错误', () => {
    useChatStore.setState({
      error: 'RPC timeout: chat.send',
      sessionsByKey: {
        'agent:main:main': createSessionRecord({
          runtime: {
            sending: true,
          },
        }),
      },
    } as never);

    useChatStore.getState().handleChatEvent({
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


  it('delta 事件应先进入 streamRuntime source，而不是直接改页面 streamView', () => {
    useChatStore.setState({
      error: null,
      sessionsByKey: {
        'agent:main:main': createSessionRecord({
          runtime: {
            sending: true,
            activeRunId: 'run-delta-batched',
            lastUserMessageAt: 1_700_000_000_000,
          },
        }),
      },
    } as never);

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-delta-batched',
      message: {
        role: 'assistant',
        content: 'hello world',
      },
    });

    const runtime = useChatStore.getState().sessionsByKey['agent:main:main']?.runtime;
    expect(selectStreamingRenderMessage(runtime!)).toBeNull();
    expect(runtime?.assistantOverlay).toMatchObject({
      runId: 'run-delta-batched',
      committedText: '',
      targetText: 'hello world',
      status: 'streaming',
    });
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
      sessionsByKey: {
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
      sessionsByKey: {
        'agent:main:main': createSessionRecord({
          runtime: {
            sending: true,
            pendingFinal: true,
            approvalStatus: 'idle',
            assistantOverlay: createAssistantOverlay({
              runId: 'run-visible',
              messageId: 'assistant-visible',
              sourceMessage: {
                id: 'assistant-visible',
                role: 'assistant',
                content: '正在调用工具...',
              },
              committedText: '正在调用工具...',
              targetText: '正在调用工具...',
              status: 'streaming',
            }),
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
    const runtime = state.sessionsByKey['agent:main:main']?.runtime;
    expect(runtime?.approvalStatus).toBe('awaiting_approval');
    expect(runtime?.assistantOverlay).toBeNull();
    expect(runtime?.streamingTools).toEqual([]);
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
      sessionsByKey: {
        'agent:main:main': createSessionRecord({
          runtime: {
            approvalStatus: 'awaiting_approval',
          },
        }),
      },
    } as never);

    await useChatStore.getState().syncPendingApprovals('agent:main:main');

    const state = useChatStore.getState();
    expect(state.sessionsByKey['agent:main:main']?.runtime.approvalStatus).toBe('idle');
    expect(state.pendingApprovalsBySession['agent:main:main']).toEqual([]);
  });
});
