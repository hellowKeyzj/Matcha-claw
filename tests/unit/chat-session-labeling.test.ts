import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';

type RpcMock = ReturnType<typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>>;

function resetChatStoreState() {
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
    sessions: [],
    currentSessionKey: 'agent:alpha:session-1',
    sessionLabels: {},
    sessionLastActivity: {},
    showThinking: true,
    thinkingLevel: null,
  } as never);
}

function setupGatewayRpc(messages: RawMessage[]): RpcMock {
  const rpcMock = vi.fn(async (method: string) => {
    if (method === 'chat.history') {
      return { messages };
    }
    if (method === 'sessions.list') {
      return { sessions: [] };
    }
    return {};
  });
  useGatewayStore.setState({
    status: { state: 'running', port: 18789 },
    rpc: rpcMock,
  } as never);
  return rpcMock;
}

describe('chat session labeling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChatStoreState();
  });

  it('当会话没有用户消息时，允许使用 assistant 有效内容作为会话标题兜底', async () => {
    setupGatewayRpc([
      {
        role: 'assistant',
        content: '本次讨论聚焦任务拆解与风险清单',
        timestamp: 1_800_000_000,
      },
    ]);

    await useChatStore.getState().loadHistory();

    const state = useChatStore.getState();
    expect(state.sessionLabels['agent:alpha:session-1']).toBe('本次讨论聚焦任务拆解与风险清单');
  });

  it('assistant 模板语句不应污染会话标题', async () => {
    setupGatewayRpc([
      {
        role: 'assistant',
        content: 'A new session was started via command',
        timestamp: 1_800_000_001,
      },
    ]);

    await useChatStore.getState().loadHistory();

    const state = useChatStore.getState();
    expect(state.sessionLabels['agent:alpha:session-1']).toBeUndefined();
  });

  it('loadHistory 返回时若会话已切换，应丢弃过期结果', async () => {
    let resolveHistory!: (value: { messages: RawMessage[] }) => void;
    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'chat.history') {
        return await new Promise<{ messages: RawMessage[] }>((resolve) => {
          resolveHistory = resolve;
        });
      }
      return {};
    });

    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: rpcMock,
    } as never);

    const loadPromise = useChatStore.getState().loadHistory();
    useChatStore.setState({
      currentSessionKey: 'agent:beta:session-2',
      messages: [{ role: 'assistant', content: 'beta session content' }],
    } as never);

    await Promise.resolve();
    resolveHistory({
      messages: [{ role: 'assistant', content: 'alpha session content' }],
    });
    await loadPromise;

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:beta:session-2');
    expect(state.messages).toEqual([{ role: 'assistant', content: 'beta session content' }]);
  });

  it('sending 期间 loadHistory 若已包含同语义用户消息，不应再追加 optimistic 用户消息', async () => {
    const sentAtMs = Date.now();
    resetChatStoreState();
    useChatStore.setState({
      currentSessionKey: 'agent:alpha:session-1',
      sending: true,
      lastUserMessageAt: sentAtMs,
      messages: [
        {
          role: 'user',
          id: 'optimistic-user-1',
          content: '你好',
          timestamp: sentAtMs / 1000,
        },
      ],
    } as never);

    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'sessions.get') {
        return {
          messages: [
            {
              role: 'user',
              id: 'gateway-user-1',
              content: '[Tue 2026-04-14 20:11 GMT+8] 你好 [message_id: u-1]',
              timestamp: (sentAtMs + 8_000) / 1000,
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

    await useChatStore.getState().loadHistory(false);

    const userMessages = useChatStore.getState().messages.filter((message) => message.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.id).toBe('optimistic-user-1');
  });

  it('loadSessions 仅使用 sessions.list 元数据，不触发 chat.history 扇出请求', async () => {
    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:alpha:session-1',
              label: 'Alpha 会话标题',
              updatedAt: 1_800_000_111_000,
            },
            {
              key: 'agent:alpha:session-2',
              displayName: 'Alpha Session 2',
              updatedAt: '2026-04-10T14:20:00.000Z',
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

    await useChatStore.getState().loadSessions();

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('sessions.list', {});
    const state = useChatStore.getState();
    expect(state.sessionLabels['agent:alpha:session-1']).toBe('Alpha 会话标题');
    expect(state.sessionLabels['agent:alpha:session-2']).toBe('Alpha Session 2');
    expect(state.sessionLastActivity['agent:alpha:session-1']).toBe(1_800_000_111_000);
    expect(state.sessionLastActivity['agent:alpha:session-2']).toBe(Date.parse('2026-04-10T14:20:00.000Z'));
  });

  it('loadSessions 即使改写 currentSessionKey，也不应触发 chat.history', async () => {
    resetChatStoreState();
    useChatStore.setState({
      currentSessionKey: 'agent:missing:session-x',
      messages: [{ role: 'assistant', content: 'stale message' }],
    } as never);

    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:alpha:session-1',
              label: 'Alpha 会话',
              updatedAt: 1_800_000_222_000,
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

    await useChatStore.getState().loadSessions();

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('sessions.list', {});
    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:alpha:session-1');
    expect(state.sessionLabels['agent:alpha:session-1']).toBe('Alpha 会话');
  });

  it('loadSessions 不应保留无本地痕迹且后端不存在的 canonical main 会话 key', async () => {
    resetChatStoreState();
    useChatStore.setState({
      currentSessionKey: 'agent:feedback:main',
      messages: [],
      sessions: [],
      sessionLabels: {},
      sessionLastActivity: {},
    } as never);

    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            {
              key: 'agent:main:main',
              label: 'Main 会话',
              updatedAt: 1_800_000_333_000,
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

    await useChatStore.getState().loadSessions();

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:main:main');
    expect(state.sessions.some((session) => session.key === 'agent:feedback:main')).toBe(false);
  });

  it('loadHistory 进行中切换会话时，应在安全超时后自动清理 initialLoading/refreshing', async () => {
    vi.useFakeTimers();
    try {
      resetChatStoreState();
      let resolveHistory!: (value: { messages: RawMessage[] }) => void;
      const rpcMock = vi.fn(async (method: string) => {
        if (method === 'sessions.get') {
          return {};
        }
        if (method === 'chat.history') {
          return await new Promise<{ messages: RawMessage[] }>((resolve) => {
            resolveHistory = resolve;
          });
        }
        return {};
      });

      useGatewayStore.setState({
        status: { state: 'running', port: 18789 },
        rpc: rpcMock,
      } as never);

      const loadPromise = useChatStore.getState().loadHistory(false);
      expect(useChatStore.getState().initialLoading || useChatStore.getState().refreshing).toBe(true);

      // 模拟加载中被其它入口改写当前会话（首屏并发常见路径）
      useChatStore.setState({ currentSessionKey: 'agent:beta:session-2' } as never);
      await vi.advanceTimersByTimeAsync(15_100);
      expect(useChatStore.getState().initialLoading).toBe(false);
      expect(useChatStore.getState().refreshing).toBe(false);

      // 结束挂起请求，避免遗留异步
      await Promise.resolve();
      resolveHistory({ messages: [] });
      await loadPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('loadHistory 优先使用 sessions.get，避免触发 chat.history', async () => {
    resetChatStoreState();
    useChatStore.setState({
      sessions: [
        {
          key: 'agent:alpha:session-1',
          thinkingLevel: 'high',
        },
      ],
      currentSessionKey: 'agent:alpha:session-1',
    } as never);

    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'sessions.get') {
        return {
          messages: [
            {
              role: 'assistant',
              content: 'history from sessions.get',
              timestamp: 1_800_000_333,
            },
          ],
        };
      }
      if (method === 'chat.history') {
        return {
          messages: [
            {
              role: 'assistant',
              content: 'history from chat.history',
              timestamp: 1_800_000_334,
            },
          ],
          thinkingLevel: 'low',
        };
      }
      return {};
    });

    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: rpcMock,
    } as never);

    await useChatStore.getState().loadHistory(false);

    expect(rpcMock).toHaveBeenCalledWith('sessions.get', {
      key: 'agent:alpha:session-1',
      limit: 10,
    });
    expect(rpcMock).not.toHaveBeenCalledWith('chat.history', expect.anything());
    const state = useChatStore.getState();
    expect(state.messages).toEqual([
      {
        role: 'assistant',
        content: 'history from sessions.get',
        timestamp: 1_800_000_333,
      },
    ]);
    expect(state.thinkingLevel).toBe('high');
  });
});
