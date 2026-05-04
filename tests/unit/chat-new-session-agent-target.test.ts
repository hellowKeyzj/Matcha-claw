import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { createEmptySessionRecord, getSessionRows } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRenderRowsFromMessages } from './helpers/timeline-fixtures';

const hostSessionNewMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostSessionNew: (...args: unknown[]) => hostSessionNewMock(...args),
  hostApiFetch: vi.fn(),
}));

function buildSessionRecord(overrides?: Partial<ReturnType<typeof createEmptySessionRecord>>) {
  const base = createEmptySessionRecord();
  const sessionKey = 'agent:test:main';
  return {
    meta: {
      ...base.meta,
      ...overrides?.meta,
    },
    runtime: {
      ...base.runtime,
      ...overrides?.runtime,
    },
    rows: overrides?.rows ?? base.rows,
    window: overrides?.window ?? base.window,
  };
}

function buildNewSessionSnapshot(sessionKey: string) {
  return {
    sessionKey,
    rows: [],
    replayComplete: true,
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'idle' as const,
      streamingMessageId: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      updatedAt: 1,
    },
    window: {
      totalRowCount: 0,
      windowStartOffset: 0,
      windowEndOffset: 0,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    },
  };
}

describe('chat store newSession agent targeting', () => {
  const loadHistory = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.restoreAllMocks();
    hostSessionNewMock.mockReset();
    hostSessionNewMock.mockImplementation(async (payload?: { canonicalPrefix?: string }) => {
      const sessionKey = `${payload?.canonicalPrefix ?? 'agent:main'}:session-${Date.now()}`;
      return {
        success: true,
        sessionKey,
        snapshot: buildNewSessionSnapshot(sessionKey),
      };
    });
    loadHistory.mockClear();
    useChatStore.setState({
      foregroundHistorySessionKey: null,
      mutating: false,
      error: null,
      sessionCatalogStatus: {
        status: 'ready',
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

  it('新会话应继承当前选中 agent，而不是 sessions 首项 agent', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_711_111_111_111);

    await useChatStore.getState().newSession();

    expect(useChatStore.getState().currentSessionKey).toBe('agent:test:session-1711111111111');
    expect(useChatStore.getState().loadedSessions['agent:test:session-1711111111111']?.meta.historyStatus).toBe('ready');
    nowSpy.mockRestore();
  });

  it('显式传入 agentId 时，应强制创建到目标 agent 会话下', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_733_333_333_333);

    await useChatStore.getState().newSession('main');

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
          rows: buildRenderRowsFromMessages('agent:test:main', [userMsg]),
          window: createViewportWindowState({
            totalRowCount: 1,
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
    expect(getSessionRows(state, 'agent:test:main')).toHaveLength(1);
    expect(record?.rows[0]?.rowId).toBe('msg-local-1');
    expect(record?.runtime.sending).toBe(true);
    expect(record?.runtime.pendingFinal).toBe(true);
  });

  it('切换会话时，不应误删“messages 为空但已有历史痕迹”的会话', () => {
    useChatStore.setState({
      currentSessionKey: 'agent:test:session-a',
      sessionCatalogStatus: {
        status: 'ready',
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
    expect(state.sessionCatalogStatus.status).toBe('ready');
    expect(state.loadedSessions['agent:test:session-a']?.meta.label).toBe('历史会话A');
    expect(state.loadedSessions['agent:test:session-a']?.meta.lastActivityAt).toBe(1_713_000_000_000);
  });

  it('cleanupEmptySession 仅清理真正空会话（无消息/无标签/无活动）', () => {
    useChatStore.setState({
      currentSessionKey: 'agent:test:session-b',
      sessionCatalogStatus: {
        status: 'ready',
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
    expect(useChatStore.getState().sessionCatalogStatus.status).toBe('ready');
    expect(useChatStore.getState().loadedSessions['agent:test:session-b']).toBeDefined();

    useChatStore.setState({
      currentSessionKey: 'agent:test:session-c',
      sessionCatalogStatus: {
        status: 'ready',
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
    expect(useChatStore.getState().sessionCatalogStatus.status).toBe('ready');
    expect(useChatStore.getState().loadedSessions['agent:test:session-c']).toBeUndefined();
  });

  it('创建新会话时，应重置发送态，避免继承上一会话的等待状态', async () => {
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

    await useChatStore.getState().newSession();

    const state = useChatStore.getState();
    const runtime = state.loadedSessions[state.currentSessionKey]?.runtime;
    expect(state.currentSessionKey).toBe('agent:test:session-1722222222222');
    expect(runtime?.sending).toBe(false);
    expect(runtime?.activeRunId).toBeNull();
    expect(runtime?.pendingFinal).toBe(false);
    nowSpy.mockRestore();
  });

  it('newSession 只写 loadedSessions 主链，不改写 session catalog status shell', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_744_444_444_444);

    await useChatStore.getState().newSession();

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:test:session-1744444444444');
    expect(state.sessionCatalogStatus.status).toBe('ready');
    expect(state.loadedSessions[state.currentSessionKey]).toBeDefined();
    nowSpy.mockRestore();
  });
});
