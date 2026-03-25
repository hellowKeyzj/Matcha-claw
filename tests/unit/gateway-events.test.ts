import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();
const subscribeHostEventMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (...args: unknown[]) => subscribeHostEventMock(...args),
}));

describe('gateway store event wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('subscribes to host events through subscribeHostEvent on init', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:status', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:error', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:notification', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:chat-message', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:channel-status', expect.any(Function));

    handlers.get('gateway:status')?.({ state: 'stopped', port: 18789 });
    expect(useGatewayStore.getState().status.state).toBe('stopped');
  });

  it('forwards exec.approval.requested/resolved notifications into chat approval state', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main', displayName: 'agent:main:main' }],
      approvalStatus: 'idle',
      pendingApprovalsBySession: {},
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:notification')?.({
      method: 'exec.approval.requested',
      params: {
        id: 'approval-evt-1',
        runId: 'run-evt-1',
        toolName: 'shell.exec',
        request: {
          sessionKey: 'agent:main:main',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    let chatState = useChatStore.getState() as unknown as {
      approvalStatus?: string;
      pendingApprovalsBySession?: Record<string, Array<{ id: string }>>;
    };
    expect(chatState.approvalStatus).toBe('awaiting_approval');
    expect(chatState.pendingApprovalsBySession?.['agent:main:main']?.map((item) => item.id)).toEqual([
      'approval-evt-1',
    ]);

    handlers.get('gateway:notification')?.({
      method: 'exec.approval.resolved',
      params: {
        id: 'approval-evt-1',
        sessionKey: 'agent:main:main',
        decision: 'deny',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    chatState = useChatStore.getState() as unknown as {
      approvalStatus?: string;
      pendingApprovalsBySession?: Record<string, Array<{ id: string }>>;
    };
    expect(chatState.approvalStatus).toBe('idle');
    expect(chatState.pendingApprovalsBySession?.['agent:main:main'] ?? []).toEqual([]);
  });

  it('agent 聊天事件同时出现在 notification 和 chat-message 时，不应重复转发到 chat store', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    const handleChatEventMock = vi.fn();
    useChatStore.setState({
      handleChatEvent: handleChatEventMock,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      sending: false,
      activeRunId: null,
      currentSessionKey: 'agent:main:main',
      sessions: [{ key: 'agent:main:main', displayName: 'agent:main:main' }],
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    const agentPayload = {
      method: 'agent',
      params: {
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        data: {
          state: 'final',
          message: {
            role: 'assistant',
            id: 'assistant-final-1',
            content: 'hello',
          },
        },
      },
    };

    handlers.get('gateway:notification')?.(agentPayload);
    handlers.get('gateway:chat-message')?.({
      message: {
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        state: 'final',
        message: {
          role: 'assistant',
          id: 'assistant-final-1',
          content: 'hello',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleChatEventMock).toHaveBeenCalledTimes(1);
    expect(handleChatEventMock).toHaveBeenCalledWith({
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      state: 'final',
      message: {
        role: 'assistant',
        id: 'assistant-final-1',
        content: 'hello',
      },
    });
  });
});
