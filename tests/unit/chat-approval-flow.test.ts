import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';

function resetChatStoreForApprovalTests() {
  useChatStore.setState({
    messages: [],
    snapshotReady: false,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    sending: false,
    activeRunId: null,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: [],
    sessions: [{ key: 'agent:main:main', displayName: 'agent:main:main' }],
    currentSessionKey: 'agent:main:main',
    sessionLabels: {},
    sessionLastActivity: {},
    sessionRuntimeByKey: {},
    showThinking: true,
    thinkingLevel: null,
    approvalStatus: 'idle',
    pendingApprovalsBySession: {},
  } as never);
}

describe('chat 审批等待态流程', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChatStoreForApprovalTests();
  });

  it('chat.send 超时且已有审批证据时，应转为 awaiting_approval 而不是报错失败', async () => {
    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'chat.send') {
        throw new Error('TIMEOUT: gateway rpc timeout');
      }
      return {};
    });

    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: rpcMock,
    } as never);

    useChatStore.setState({
      pendingApprovalsBySession: {
        'agent:main:main': [
          {
            id: 'approval-1',
            sessionKey: 'agent:main:main',
            runId: 'run-1',
            toolName: 'shell.exec',
            createdAtMs: Date.now(),
          },
        ],
      },
    } as never);

    await useChatStore.getState().sendMessage('hello');

    const state = useChatStore.getState() as unknown as {
      approvalStatus?: string;
      error: string | null;
      sending: boolean;
      pendingFinal: boolean;
    };
    expect(state.approvalStatus).toBe('awaiting_approval');
    expect(state.error).toBeNull();
    expect(state.sending).toBe(true);
    expect(state.pendingFinal).toBe(true);
  });

  it('chat.send 超时且事件丢失时，应通过 exec.approvals.get 补拉进入 awaiting_approval', async () => {
    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'chat.send') {
        throw new Error('TIMEOUT: gateway rpc timeout');
      }
      if (method === 'exec.approvals.get') {
        return {
          approvals: [
            {
              id: 'approval-from-pull',
              runId: 'run-pull-1',
              toolName: 'web_search',
              request: {
                sessionKey: 'agent:main:main',
              },
              createdAt: Date.now(),
            },
          ],
        };
      }
      return {};
    });

    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: rpcMock,
    } as never);

    await useChatStore.getState().sendMessage('hello');

    const state = useChatStore.getState() as unknown as {
      approvalStatus?: string;
      error: string | null;
      sending: boolean;
      pendingFinal: boolean;
      pendingApprovalsBySession: Record<string, Array<{ id: string }>>;
    };
    expect(state.approvalStatus).toBe('awaiting_approval');
    expect(state.error).toBeNull();
    expect(state.sending).toBe(true);
    expect(state.pendingFinal).toBe(true);
    expect((state.pendingApprovalsBySession['agent:main:main'] ?? []).some((item) => item.id === 'approval-from-pull')).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith('exec.approvals.get', {});
  });

  it('chat.send 显式 RPC 超时且无审批证据时，仍保持发送态等待后续事件恢复', async () => {
    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'chat.send') {
        throw new Error('RPC timeout: chat.send');
      }
      if (method === 'exec.approvals.get') {
        return { approvals: [] };
      }
      return {};
    });

    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: rpcMock,
    } as never);

    await useChatStore.getState().sendMessage('hello');

    const state = useChatStore.getState() as unknown as {
      approvalStatus?: string;
      error: string | null;
      sending: boolean;
      pendingFinal: boolean;
    };
    expect(state.sending).toBe(true);
    expect(state.pendingFinal).toBe(false);
    expect(state.approvalStatus).toBe('idle');
    expect(state.error).toContain('RPC timeout: chat.send');
  });

  it('发生 chat.send 超时提示后，只要收到 delta 事件就应清理陈旧错误', () => {
    useChatStore.setState({
      sending: true,
      error: 'RPC timeout: chat.send',
      streamingMessage: null,
      streamingTools: [],
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

  it('delta 事件应按帧合并更新：当前 tick 不改 streamingMessage，下一帧再落地', () => {
    vi.useFakeTimers();
    try {
      useChatStore.setState({
        sending: true,
        activeRunId: 'run-delta-batched',
        error: null,
        streamingMessage: null,
        streamingTools: [],
      } as never);

      useChatStore.getState().handleChatEvent({
        state: 'delta',
        runId: 'run-delta-batched',
        message: {
          role: 'assistant',
          content: 'frame-batched',
        },
      });

      const stateBeforeFlush = useChatStore.getState() as unknown as {
        streamingMessage: unknown;
      };
      expect(stateBeforeFlush.streamingMessage).toBeNull();

      vi.advanceTimersByTime(40);

      const stateAfterFlush = useChatStore.getState() as unknown as {
        streamingMessage: unknown;
      };
      expect(stateAfterFlush.streamingMessage).toEqual({
        role: 'assistant',
        content: 'frame-batched',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('同一帧内连续 delta 应合并为最新快照落地', () => {
    vi.useFakeTimers();
    try {
      useChatStore.setState({
        sending: true,
        activeRunId: 'run-delta-merge',
        error: null,
        streamingMessage: null,
        streamingTools: [],
      } as never);

      useChatStore.getState().handleChatEvent({
        state: 'delta',
        runId: 'run-delta-merge',
        message: {
          role: 'assistant',
          content: 'hello',
        },
      });
      useChatStore.getState().handleChatEvent({
        state: 'delta',
        runId: 'run-delta-merge',
        message: {
          role: 'assistant',
          content: 'hello world',
        },
      });

      const stateBeforeFlush = useChatStore.getState() as unknown as {
        streamingMessage: unknown;
      };
      expect(stateBeforeFlush.streamingMessage).toBeNull();

      vi.advanceTimersByTime(40);

      const stateAfterFlush = useChatStore.getState() as unknown as {
        streamingMessage: unknown;
      };
      expect(stateAfterFlush.streamingMessage).toEqual({
        role: 'assistant',
        content: 'hello world',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('停止时应先 deny 当前会话 pending 审批，再 chat.abort', async () => {
    const rpcMock = vi.fn(async () => ({}));
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: rpcMock,
    } as never);

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sending: true,
      pendingFinal: true,
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
      sending: true,
      pendingFinal: true,
      approvalStatus: 'idle',
      streamingMessage: {
        role: 'assistant',
        content: '正在调用工具...',
      },
      streamingTools: [
        {
          id: 'tool-1',
          name: 'web_search',
          status: 'running',
        },
      ],
    } as never);

    useChatStore.getState().handleApprovalRequested({
      id: 'approval-visible',
      sessionKey: 'agent:main:main',
      runId: 'run-visible',
      toolName: 'web_search',
      createdAt: Date.now(),
    });

    const state = useChatStore.getState() as unknown as {
      approvalStatus: string;
      streamingMessage: unknown;
      streamingTools: Array<unknown>;
      pendingApprovalsBySession: Record<string, Array<{ id: string }>>;
    };
    expect(state.approvalStatus).toBe('awaiting_approval');
    expect(state.streamingMessage).toBeNull();
    expect(state.streamingTools).toEqual([]);
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
      approvalStatus: 'awaiting_approval',
      pendingApprovalsBySession: {
        'agent:main:main': [
          {
            id: 'stale-approval',
            sessionKey: 'agent:main:main',
            createdAtMs: Date.now() - 1000,
          },
        ],
      },
    } as never);

    await useChatStore.getState().syncPendingApprovals('agent:main:main');

    const state = useChatStore.getState() as unknown as {
      approvalStatus: string;
      pendingApprovalsBySession: Record<string, Array<{ id: string }>>;
    };
    expect(state.approvalStatus).toBe('idle');
    expect(state.pendingApprovalsBySession['agent:main:main']).toEqual([]);
  });
});
