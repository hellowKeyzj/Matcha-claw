import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

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

describe('chat store newSession agent targeting', () => {
  const loadHistory = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.restoreAllMocks();
    loadHistory.mockClear();
    useChatStore.setState({
      foregroundHistorySessionKey: null,
      mutating: false,
      error: null,
      sessionMetasResource: {
        status: 'ready',
        data: [
          { key: 'agent:main:main', displayName: 'agent:main:main' },
          { key: 'agent:test:main', displayName: 'agent:test:main' },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      currentSessionKey: 'agent:test:main',
      loadedSessions: {
        'agent:main:main': buildSessionRecord(),
        'agent:test:main': buildSessionRecord(),
      },
      showThinking: true,
      loadHistory,
    } as never);
  });

  it('新会话应继承当前选中 agent，而不是 sessions 首项 agent', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_711_111_111_111);

    useChatStore.getState().newSession();

    expect(useChatStore.getState().currentSessionKey).toBe('agent:test:session-1711111111111');
    expect(useChatStore.getState().loadedSessions['agent:test:session-1711111111111']?.meta.historyStatus).toBe('ready');
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
      loadedSessions: {
        ...useChatStore.getState().loadedSessions,
        'agent:test:main': buildSessionRecord({
          runtime: {
            sending: true,
            activeRunId: 'run-from-agent-test',
            pendingFinal: true,
          },
        }),
      },
    } as never);

    useChatStore.getState().switchSession('agent:another:main');

    const state = useChatStore.getState();
    const runtime = state.loadedSessions['agent:another:main']?.runtime;
    expect(state.currentSessionKey).toBe('agent:another:main');
    expect(runtime?.sending).toBe(false);
    expect(runtime?.activeRunId).toBeNull();
    expect(runtime?.pendingFinal).toBe(false);
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
      loadedSessions: {
        ...useChatStore.getState().loadedSessions,
        'agent:test:main': buildSessionRecord({
          window: createViewportWindowState({
            messages: [userMsg],
            totalMessageCount: 1,
            windowStartOffset: 0,
            windowEndOffset: 1,
            isAtLatest: true,
          }),
          runtime: {
            sending: true,
            activeRunId: 'run-agent-test',
            pendingFinal: true,
          },
        }),
      },
    } as never);

    useChatStore.getState().switchSession('agent:another:main');
    useChatStore.getState().switchSession('agent:test:main');

    const state = useChatStore.getState();
    const record = state.loadedSessions['agent:test:main'];
    expect(state.currentSessionKey).toBe('agent:test:main');
    expect(record?.window.messages).toHaveLength(1);
    expect(record?.window.messages[0]?.id).toBe('msg-local-1');
    expect(record?.runtime.sending).toBe(true);
    expect(record?.runtime.pendingFinal).toBe(true);
  });

  it('切换会话时，不应误删“messages 为空但已有历史痕迹”的会话', () => {
    useChatStore.setState({
      currentSessionKey: 'agent:test:session-a',
      sessionMetasResource: {
        status: 'ready',
        data: [
          { key: 'agent:test:session-a', displayName: 'agent:test:session-a' },
          { key: 'agent:test:main', displayName: 'agent:test:main' },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:test:session-a': buildSessionRecord({
          meta: {
            label: '历史会话A',
            lastActivityAt: 1_713_000_000_000,
          },
        }),
        'agent:test:main': buildSessionRecord(),
      },
    } as never);

    useChatStore.getState().switchSession('agent:test:main');

    const state = useChatStore.getState();
    expect(state.sessionMetasResource.data.some((session) => session.key === 'agent:test:session-a')).toBe(true);
    expect(state.loadedSessions['agent:test:session-a']?.meta.label).toBe('历史会话A');
    expect(state.loadedSessions['agent:test:session-a']?.meta.lastActivityAt).toBe(1_713_000_000_000);
  });

  it('cleanupEmptySession 仅清理真正空会话（无消息/无标签/无活动）', () => {
    useChatStore.setState({
      currentSessionKey: 'agent:test:session-b',
      sessionMetasResource: {
        status: 'ready',
        data: [
          { key: 'agent:test:session-b', displayName: 'agent:test:session-b' },
          { key: 'agent:test:main', displayName: 'agent:test:main' },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:test:session-b': buildSessionRecord({
          meta: { label: 'B' },
        }),
        'agent:test:main': buildSessionRecord(),
      },
    } as never);

    useChatStore.getState().cleanupEmptySession();
    expect(useChatStore.getState().sessionMetasResource.data.some((session) => session.key === 'agent:test:session-b')).toBe(true);

    useChatStore.setState({
      currentSessionKey: 'agent:test:session-c',
      sessionMetasResource: {
        status: 'ready',
        data: [
          { key: 'agent:test:session-c', displayName: 'agent:test:session-c' },
          { key: 'agent:test:main', displayName: 'agent:test:main' },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:test:session-c': buildSessionRecord(),
        'agent:test:main': buildSessionRecord(),
      },
    } as never);

    useChatStore.getState().cleanupEmptySession();
    expect(useChatStore.getState().sessionMetasResource.data.some((session) => session.key === 'agent:test:session-c')).toBe(false);
  });

  it('创建新会话时，应重置发送态，避免继承上一会话的等待状态', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_722_222_222_222);
    useChatStore.setState({
      loadedSessions: {
        ...useChatStore.getState().loadedSessions,
        'agent:test:main': buildSessionRecord({
          runtime: {
            sending: true,
            activeRunId: 'run-from-agent-test',
            pendingFinal: true,
          },
        }),
      },
    } as never);

    useChatStore.getState().newSession();

    const state = useChatStore.getState();
    const runtime = state.loadedSessions[state.currentSessionKey]?.runtime;
    expect(state.currentSessionKey).toBe('agent:test:session-1722222222222');
    expect(runtime?.sending).toBe(false);
    expect(runtime?.activeRunId).toBeNull();
    expect(runtime?.pendingFinal).toBe(false);
    nowSpy.mockRestore();
  });
});


