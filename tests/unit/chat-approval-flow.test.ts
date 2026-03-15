import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';

function resetChatStoreForApprovalTests() {
  useChatStore.setState({
    messages: [],
    loading: false,
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
});
