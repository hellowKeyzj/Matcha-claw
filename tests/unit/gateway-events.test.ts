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
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:connection', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:notification', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:chat-message', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:channel-status', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('runtime-host:status', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('runtime-host:error', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('runtime-host:restart', expect.any(Function));

    handlers.get('gateway:status')?.({ state: 'stopped', port: 18789 });
    expect(useGatewayStore.getState().status.state).toBe('stopped');
  });

  it('gateway:connection 事件会更新 runtimeHost 连接态并驱动 degraded/running 切换', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('runtime-host:status')?.({
      status: 'running',
      updatedAt: 2001,
    });
    handlers.get('gateway:connection')?.({
      state: 'disconnected',
      reason: 'socket closed',
      updatedAt: 2002,
    });

    let state = useGatewayStore.getState().runtimeHost;
    expect(state.lifecycle).toBe('degraded');
    expect(state.gatewayConnectionState).toBe('disconnected');
    expect(state.gatewayConnectionReason).toBe('socket closed');

    handlers.get('gateway:connection')?.({
      state: 'connected',
      updatedAt: 2003,
    });

    state = useGatewayStore.getState().runtimeHost;
    expect(state.lifecycle).toBe('running');
    expect(state.gatewayConnectionState).toBe('connected');
  });

  it('runtime-host 事件会更新 renderer 侧运行时状态', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('runtime-host:status')?.({
      status: 'degraded',
      pid: 4321,
      error: 'health check failed',
      updatedAt: 1001,
    });
    handlers.get('runtime-host:restart')?.({
      previousPid: 4321,
      pid: 6789,
      recoveredAt: 1002,
    });
    handlers.get('runtime-host:error')?.({
      status: 'error',
      message: 'runtime-host crashed',
      updatedAt: 1003,
    });

    const state = useGatewayStore.getState().runtimeHost;
    expect(state.lifecycle).toBe('error');
    expect(state.pid).toBe(6789);
    expect(state.error).toBe('runtime-host crashed');
    expect(state.restartCount).toBe(1);
    expect(state.lastRestartAt).toBe(1002);
    expect(state.updatedAt).toBe(1003);
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

  it('agent completed 通知应清理 chat.send 超时残留错误', async () => {
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
      sending: true,
      activeRunId: 'run-cleanup',
      pendingFinal: true,
      error: 'RPC timeout: chat.send',
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:notification')?.({
      method: 'agent',
      params: {
        runId: 'run-cleanup',
        sessionKey: 'agent:main:main',
        phase: 'completed',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = useChatStore.getState() as unknown as {
      sending: boolean;
      pendingFinal: boolean;
      activeRunId: string | null;
      error: string | null;
    };
    expect(state.sending).toBe(false);
    expect(state.pendingFinal).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.error).toBeNull();
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

  it('task_manager.* 通知会进入 task center，并按 taskId 合并批量更新', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    const handleGatewayNotificationMock = vi.fn();
    useTaskCenterStore.setState({
      handleGatewayNotification: handleGatewayNotificationMock,
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:notification')?.({
      method: 'task_manager.updated',
      params: { task: { id: 'task-1', status: 'pending' } },
    });
    handlers.get('gateway:notification')?.({
      method: 'task_manager.updated',
      params: { task: { id: 'task-1', status: 'in_progress' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(handleGatewayNotificationMock).toHaveBeenCalledTimes(1);
    expect(handleGatewayNotificationMock).toHaveBeenCalledWith({
      method: 'task_manager.updated',
      params: { task: { id: 'task-1', status: 'in_progress' } },
    });
  });
});
