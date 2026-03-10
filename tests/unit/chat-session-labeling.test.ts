import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';

type RpcMock = ReturnType<typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>>;

function resetChatStoreState() {
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

    resolveHistory({
      messages: [{ role: 'assistant', content: 'alpha session content' }],
    });
    await loadPromise;

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:beta:session-2');
    expect(state.messages).toEqual([{ role: 'assistant', content: 'beta session content' }]);
  });
});
