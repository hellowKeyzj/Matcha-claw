import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';

const hostApiFetchMock = vi.fn();
const hostSessionWindowFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  hostSessionWindowFetch: (...args: unknown[]) => hostSessionWindowFetchMock(...args),
}));

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

type RpcMock = ReturnType<typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>>;

function resetChatStoreState() {
  useChatStore.setState({
    snapshotReady: false,
    initialLoading: false,
    refreshing: false,
    sessionMetasResource: {
      status: 'idle',
      data: [{ key: 'agent:alpha:session-1', displayName: 'agent:alpha:session-1' }],
      error: null,
      hasLoadedOnce: false,
      lastLoadedAt: null,
    },
    mutating: false,
    error: null,
    currentSessionKey: 'agent:alpha:session-1',
    loadedSessions: {
      'agent:alpha:session-1': buildSessionRecord(),
    },
    showThinking: true,
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

function loadCurrentHistory(mode: 'active' | 'quiet' = 'active') {
  const state = useChatStore.getState();
  return state.loadHistory({
    sessionKey: state.currentSessionKey,
    mode,
    scope: 'foreground',
  });
}

describe('chat session labeling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostApiFetchMock.mockReset();
    hostSessionWindowFetchMock.mockReset();
    hostSessionWindowFetchMock.mockRejectedValue(new Error('host window unavailable'));
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

    await loadCurrentHistory();

    const state = useChatStore.getState();
    expect(state.loadedSessions['agent:alpha:session-1']?.meta.label).toBe('本次讨论聚焦任务拆解与风险清单');
  });

  it('assistant 模板语句不应污染会话标题', async () => {
    setupGatewayRpc([
      {
        role: 'assistant',
        content: 'A new session was started via command',
        timestamp: 1_800_000_001,
      },
    ]);

    await loadCurrentHistory();

    const state = useChatStore.getState();
    expect(state.loadedSessions['agent:alpha:session-1']?.meta.label).toBeNull();
  });

  it('会话标题应跟随最新一条用户输入，而不是停留在最早一条', async () => {
    setupGatewayRpc([
      {
        role: 'user',
        content: '第一条输入',
        timestamp: 1_800_000_000,
      },
      {
        role: 'assistant',
        content: '收到',
        timestamp: 1_800_000_001,
      },
      {
        role: 'user',
        content: '最后一条输入',
        timestamp: 1_800_000_002,
      },
    ]);

    await loadCurrentHistory();

    const state = useChatStore.getState();
    expect(state.loadedSessions['agent:alpha:session-1']?.meta.label).toBe('最后一条输入');
  });

  it('gateway 注入的 Sender metadata 前缀不应污染会话标题', async () => {
    setupGatewayRpc([
      {
        role: 'user',
        content: [
          'Sender (untrusted metadata):',
          '```json',
          '{',
          '  "label": "MatchaClaw Runtime Host",',
          '  "id": "gateway-client"',
          '}',
          '```',
          '[Tue 2026-04-14 00:11 GMT+8]真正的用户问题',
        ].join('\n'),
        timestamp: 1_800_000_010,
      },
    ]);

    await loadCurrentHistory();

    const state = useChatStore.getState();
    expect(state.loadedSessions['agent:alpha:session-1']?.meta.label).toBe('真正的用户问题');
  });

  it('sending 期间 loadHistory 若已包含同语义用户消息，不应再追加 optimistic 用户消息', async () => {
    const sentAtMs = Date.now();
    resetChatStoreState();
    const optimisticUserMessage = {
      role: 'user' as const,
      id: 'optimistic-user-1',
      content: '你好',
      timestamp: sentAtMs / 1000,
    };
    useChatStore.setState({
      currentSessionKey: 'agent:alpha:session-1',
      loadedSessions: {
        'agent:alpha:session-1': buildSessionRecord({
          runtime: {
            sending: true,
            lastUserMessageAt: sentAtMs,
            pendingUserMessage: {
              clientMessageId: 'optimistic-user-1',
              createdAtMs: sentAtMs,
              message: optimisticUserMessage,
            },
          },
        }),
      },
    } as never);

    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'sessions.get') {
        return {
          messages: [
            {
              role: 'user',
              id: 'gateway-user-1',
              content: '[Tue 2026-04-14 20:11 GMT+8] 你好 [message_id: optimistic-user-1]',
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

    await loadCurrentHistory('active');

    const userMessages = useChatStore.getState().loadedSessions['agent:alpha:session-1']?.window.messages.filter((message) => message.role === 'user') ?? [];
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.id).toBe('optimistic-user-1');
  });

  it('loadSessions 直接信任 /api/sessions/list 的显式标题，不再补抓正文生成标题', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
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
    });

    await useChatStore.getState().loadSessions();

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/sessions/list');
    const state = useChatStore.getState();
    expect(state.sessionMetasResource.status).toBe('ready');
    expect(state.loadedSessions['agent:alpha:session-1']?.meta.label).toBe('Alpha 会话标题');
    expect(state.loadedSessions['agent:alpha:session-2']?.meta.label).toBeNull();
    expect(state.loadedSessions['agent:alpha:session-1']?.meta.lastActivityAt).toBe(1_800_000_111_000);
    expect(state.loadedSessions['agent:alpha:session-2']?.meta.lastActivityAt).toBe(Date.parse('2026-04-10T14:20:00.000Z'));
  });

  it('loadSessions 不应把 displayName 提升成正式会话标题', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      sessions: [
        {
          key: 'agent:alpha:session-2',
          displayName: 'MatchaClaw Runtime Host',
          updatedAt: '2026-04-10T14:20:00.000Z',
        },
      ],
    });

    await useChatStore.getState().loadSessions();

    const state = useChatStore.getState();
    expect(state.loadedSessions['agent:alpha:session-2']?.meta.label).toBeNull();
  });

  it('loadSessions 遇到无显式标题的会话时，应保留本地已加载标题而不是重抓正文', async () => {
    useChatStore.setState({
      loadedSessions: {
        ...useChatStore.getState().loadedSessions,
        'agent:alpha:session-2': buildSessionRecord({
          meta: {
            label: '本地已加载标题',
            lastActivityAt: 1_800_000_100_000,
          },
        }),
      },
    } as never);

    hostApiFetchMock.mockResolvedValueOnce({
      sessions: [
        {
          key: 'agent:alpha:session-2',
          displayName: 'MatchaClaw Runtime Host',
          updatedAt: '2026-04-10T14:20:00.000Z',
        },
      ],
    });

    await useChatStore.getState().loadSessions();

    const state = useChatStore.getState();
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/sessions/list');
    expect(state.loadedSessions['agent:alpha:session-2']?.meta.label).toBe('本地已加载标题');
    expect(state.loadedSessions['agent:alpha:session-2']?.meta.lastActivityAt).toBe(Date.parse('2026-04-10T14:20:00.000Z'));
  });

  it('loadSessions 即使改写 currentSessionKey，也只按 /api/sessions/list 收口当前会话', async () => {
    resetChatStoreState();
    useChatStore.setState({
      currentSessionKey: 'agent:missing:session-x',
    } as never);

    hostApiFetchMock.mockResolvedValueOnce({
      sessions: [
        {
          key: 'agent:alpha:session-1',
          label: 'Alpha 会话',
          updatedAt: 1_800_000_222_000,
        },
      ],
    });

    await useChatStore.getState().loadSessions();

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/sessions/list');
    const state = useChatStore.getState();
    expect(state.sessionMetasResource.status).toBe('ready');
    expect(state.currentSessionKey).toBe('agent:alpha:session-1');
    expect(state.loadedSessions['agent:alpha:session-1']?.meta.label).toBe('Alpha 会话');
  });

  it('loadSessions 首次失败后应明确进入 error 状态，便于侧栏独立收口', async () => {
    useChatStore.setState({
      sessionMetasResource: {
        status: 'idle',
        data: [],
        error: null,
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
    } as never);

    hostApiFetchMock.mockRejectedValueOnce(new Error('sessions list failed'));

    await useChatStore.getState().loadSessions();

    const state = useChatStore.getState();
    expect(state.sessionMetasResource.status).toBe('error');
    expect(state.sessionMetasResource.error).toBe('sessions list failed');
    expect(state.sessionMetasResource.hasLoadedOnce).toBe(false);
  });

  it('loadSessions 不应保留无本地痕迹且后端不存在的 canonical main 会话 key', async () => {
    resetChatStoreState();
    useChatStore.setState({
      currentSessionKey: 'agent:feedback:main',
      sessionMetasResource: {
        status: 'idle',
        data: [],
        error: null,
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
      loadedSessions: {},
    } as never);

    hostApiFetchMock.mockResolvedValueOnce({
      sessions: [
        {
          key: 'agent:main:main',
          label: 'Main 会话',
          updatedAt: 1_800_000_333_000,
        },
      ],
    });

    await useChatStore.getState().loadSessions();

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:main:main');
    expect(state.sessionMetasResource.data.some((session) => session.key === 'agent:feedback:main')).toBe(false);
  });

  it('loadHistory 进行中切换会话时，应在安全超时后自动清理 foregroundHistorySessionKey', async () => {
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

      const loadPromise = loadCurrentHistory('active');
      expect(useChatStore.getState().foregroundHistorySessionKey).toBe('agent:alpha:session-1');

      // 模拟加载中被其它入口改写当前会话（首屏并发常见路径）
      useChatStore.setState({ currentSessionKey: 'agent:beta:session-2' } as never);
      await vi.advanceTimersByTimeAsync(15_100);
      expect(useChatStore.getState().foregroundHistorySessionKey).toBeNull();

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
      sessionMetasResource: {
        status: 'ready',
        data: [
          {
            key: 'agent:alpha:session-1',
            thinkingLevel: 'high',
          },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      currentSessionKey: 'agent:alpha:session-1',
      loadedSessions: {
        'agent:alpha:session-1': buildSessionRecord({
          meta: {
            thinkingLevel: 'high',
          },
        }),
      },
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

    await loadCurrentHistory('active');

    expect(rpcMock).toHaveBeenCalledWith('sessions.get', {
      key: 'agent:alpha:session-1',
      limit: 200,
    });
    expect(rpcMock).not.toHaveBeenCalledWith('chat.history', expect.anything());
    const state = useChatStore.getState();
    expect(state.loadedSessions['agent:alpha:session-1']?.window.messages).toEqual([
      {
        role: 'assistant',
        content: 'history from sessions.get',
        timestamp: 1_800_000_333,
      },
    ]);
    expect(state.loadedSessions['agent:alpha:session-1']?.meta.thinkingLevel).toBe('high');
  });
});
