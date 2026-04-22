import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';

describe('chat store newSession agent targeting', () => {
  const loadHistory = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.restoreAllMocks();
    loadHistory.mockClear();
    useChatStore.setState({
      messages: [],
      snapshotReady: false,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      error: null,
      sending: false,
      activeRunId: null,
      streamingMessage: null,
      streamRuntime: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      sessions: [
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
      ],
      currentSessionKey: 'agent:test:main',
      sessionLabels: {},
      sessionLastActivity: {},
      sessionRuntimeByKey: {},
      showThinking: true,
      thinkingLevel: null,
      loadHistory,
    } as never);
  });

  it('新会话应继承当前选中 agent，而不是 sessions 首项 agent', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_711_111_111_111);

    useChatStore.getState().newSession();

    expect(useChatStore.getState().currentSessionKey).toBe('agent:test:session-1711111111111');
    nowSpy.mockRestore();
  });

  it('显式传入 agentId 时，应强制创建到目标 agent 会话下', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_733_333_333_333);

    useChatStore.getState().newSession('main');

    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:session-1733333333333');
    nowSpy.mockRestore();
  });

  it('切换到其他 agent 会话时，应清理当前会话的发送态，避免跨会话锁死输入', () => {
    useChatStore.setState({
      sending: true,
      activeRunId: 'run-from-agent-test',
      pendingFinal: true,
      streamingMessage: { role: 'assistant', content: '...' },
    } as never);

    useChatStore.getState().switchSession('agent:another:main');

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:another:main');
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
  });

  it('切回发送中的会话时，应立即恢复本地消息与等待态，避免出现空白页错觉', () => {
    const userMsg = {
      role: 'user' as const,
      content: '你好，先帮我分析下',
      timestamp: Date.now() / 1000,
      id: 'msg-local-1',
    };
    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      messages: [userMsg],
      sending: true,
      activeRunId: 'run-agent-test',
      pendingFinal: true,
      streamingMessage: { role: 'assistant', content: [{ type: 'thinking', thinking: '处理中...' }] },
    } as never);

    useChatStore.getState().switchSession('agent:another:main');
    useChatStore.getState().switchSession('agent:test:main');

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:test:main');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].id).toBe('msg-local-1');
    expect(state.sending).toBe(true);
    expect(state.pendingFinal).toBe(true);
  });

  it('切换会话时，不应误删“messages 为空但已有历史痕迹”的会话', () => {
    useChatStore.setState({
      currentSessionKey: 'agent:test:session-a',
      sessions: [
        { key: 'agent:test:session-a', displayName: 'agent:test:session-a' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
      ],
      messages: [],
      sessionLabels: { 'agent:test:session-a': '历史会话A' },
      sessionLastActivity: { 'agent:test:session-a': 1_713_000_000_000 },
    } as never);

    useChatStore.getState().switchSession('agent:test:main');

    const state = useChatStore.getState();
    expect(state.sessions.some((session) => session.key === 'agent:test:session-a')).toBe(true);
    expect(state.sessionLabels['agent:test:session-a']).toBe('历史会话A');
    expect(state.sessionLastActivity['agent:test:session-a']).toBe(1_713_000_000_000);
  });

  it('cleanupEmptySession 仅清理真正空会话（无消息/无标签/无活动）', () => {
    useChatStore.setState({
      currentSessionKey: 'agent:test:session-b',
      sessions: [
        { key: 'agent:test:session-b', displayName: 'agent:test:session-b' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
      ],
      messages: [],
      sessionLabels: { 'agent:test:session-b': 'B' },
      sessionLastActivity: {},
    } as never);

    useChatStore.getState().cleanupEmptySession();
    expect(useChatStore.getState().sessions.some((session) => session.key === 'agent:test:session-b')).toBe(true);

    useChatStore.setState({
      currentSessionKey: 'agent:test:session-c',
      sessions: [
        { key: 'agent:test:session-c', displayName: 'agent:test:session-c' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
      ],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
    } as never);

    useChatStore.getState().cleanupEmptySession();
    expect(useChatStore.getState().sessions.some((session) => session.key === 'agent:test:session-c')).toBe(false);
  });

  it('创建新会话时，应重置发送态，避免继承上一会话的等待状态', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_722_222_222_222);
    useChatStore.setState({
      sending: true,
      activeRunId: 'run-from-agent-test',
      pendingFinal: true,
      streamingMessage: { role: 'assistant', content: '...' },
    } as never);

    useChatStore.getState().newSession();

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:test:session-1722222222222');
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    nowSpy.mockRestore();
  });
});
