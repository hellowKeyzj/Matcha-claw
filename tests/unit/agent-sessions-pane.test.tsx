import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentSessionsPane } from '@/components/layout/AgentSessionsPane';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import type { RawMessage } from './helpers/timeline-fixtures';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

const readyResource = {
  status: 'ready' as const,
  error: null,
  hasLoadedOnce: true,
  lastLoadedAt: 1,
};

function buildReadySessionCatalogStatus(_sessions: Array<{ key: string; displayName: string }>) {
  return {
    ...readyResource,
  };
}

function createSessionRecord(input?: {
  sessionKey?: string;
  messages?: RawMessage[];
  label?: string | null;
  lastActivityAt?: number | null;
  ready?: boolean;
}) {
  const sessionKey = input?.sessionKey ?? 'agent:test:session-1';
  const messages = input?.messages ?? [];
  const base = createEmptySessionRecord();
  return {
    meta: {
      ...base.meta,
      agentId: sessionKey.split(':')[1] ?? null,
      kind: sessionKey.endsWith(':main') ? 'main' : 'session',
      preferred: sessionKey.endsWith(':main'),
      label: input?.label ?? null,
      titleSource: input?.label ? 'user' : 'none',
      lastActivityAt: input?.lastActivityAt ?? null,
      historyStatus: input?.ready ? 'ready' : 'idle',
    },
    runtime: {
      ...base.runtime,
    },
    items: buildRenderItemsFromMessages(sessionKey, messages),
    window: createViewportWindowState({
      totalItemCount: messages.length,
      windowStartOffset: 0,
      windowEndOffset: messages.length,
      isAtLatest: true,
    }),
  };
}

function setupBaseState() {
  useGatewayStore.setState({
    status: { state: 'running', port: 18789 },
    init: vi.fn().mockResolvedValue(undefined),
  } as never);

  useSubagentsStore.setState({
    agents: [
      { id: 'main', name: 'main', isDefault: true, avatarSeed: 'agent:main', avatarStyle: 'pixelArt' },
      { id: 'test', name: 'test', isDefault: false, avatarSeed: 'agent:test', avatarStyle: 'bottts' },
    ],
    agentsResource: readyResource,
    loadAgents: vi.fn().mockResolvedValue(undefined),
  } as never);
  useChatStore.setState({
    sessionCatalogStatus: readyResource,
  } as never);
}

function renderPane() {
  render(
    <MemoryRouter>
      <AgentSessionsPane />
    </MemoryRouter>,
  );
}

describe('agent sessions pane', () => {
  beforeEach(() => {
    window.localStorage.clear();
    i18n.changeLanguage('en');
    setupBaseState();
  });

  it('将 agent 列表放在上方，会话历史在下方统一展示', async () => {
    const now = Date.now();
    const sessions = [
      { key: 'agent:main:main', displayName: 'agent:main:main' },
      { key: 'agent:main:session-1', displayName: 'agent:main:session-1' },
      { key: 'agent:test:main', displayName: 'agent:test:main' },
      { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
    ];
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: buildReadySessionCatalogStatus(sessions),
      loadedSessions: {
        'agent:main:main': createSessionRecord({ sessionKey: 'agent:main:main', ready: true }),
        'agent:main:session-1': createSessionRecord({ sessionKey: 'agent:main:session-1', ready: true, label: '主Agent会话', lastActivityAt: now - 1 * 24 * 60 * 60 * 1000 }),
        'agent:test:main': createSessionRecord({ sessionKey: 'agent:test:main', ready: true }),
        'agent:test:session-2': createSessionRecord({ sessionKey: 'agent:test:session-2', ready: true, label: '测试Agent会话', lastActivityAt: now - 2 * 24 * 60 * 60 * 1000 }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    expect(screen.getByTestId('agent-item-main')).toBeInTheDocument();
    expect(screen.getByTestId('agent-item-test')).toBeInTheDocument();
    expect(screen.getByTestId('agent-session-avatar-main')).toBeInTheDocument();
    expect(screen.getByTestId('agent-session-avatar-test')).toBeInTheDocument();
    expect(screen.getByText('主Agent会话')).toBeInTheDocument();
    expect(screen.getByText('测试Agent会话')).toBeInTheDocument();
  });

  it('收缩态头像区应负责展开，下半部应给当前 agent 新建会话', () => {
    const onToggleCollapse = vi.fn();
    const newSession = vi.fn();
    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
      ]),
      loadedSessions: {
        'agent:main:main': createSessionRecord({ sessionKey: 'agent:main:main', ready: true }),
        'agent:test:main': createSessionRecord({ sessionKey: 'agent:test:main', ready: true }),
      },
      switchSession: vi.fn(),
      newSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    render(
      <MemoryRouter>
        <AgentSessionsPane collapsed onToggleCollapse={onToggleCollapse} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('agent-sessions-collapsed-note')).toBeInTheDocument();
    expect(screen.getByTestId('agent-sessions-collapsed-avatar')).toBeInTheDocument();
    expect(screen.getByTestId('agent-sessions-collapsed-new-session')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('agent-sessions-collapsed-expand'));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('agent-sessions-collapsed-new-session'));
    expect(newSession).toHaveBeenCalledWith('test');
  });

  it('点击某个 agent 的新会话按钮，应按对应 agent 创建', async () => {
    const newSession = vi.fn();
    const sessions = [
      { key: 'agent:main:main', displayName: 'agent:main:main' },
      { key: 'agent:test:main', displayName: 'agent:test:main' },
    ];
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: buildReadySessionCatalogStatus(sessions),
      loadedSessions: {
        'agent:main:main': createSessionRecord({ sessionKey: 'agent:main:main', ready: true }),
        'agent:test:main': createSessionRecord({ sessionKey: 'agent:test:main', ready: true }),
      },
      switchSession: vi.fn(),
      newSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    fireEvent.click(screen.getByTestId('agent-new-session-test'));
    expect(newSession).toHaveBeenCalledWith('test');
  });

  it('点击历史会话项时，应立即切换 current session，不走额外导航链路', () => {
    const switchSession = vi.fn();
    const now = Date.now();
    const sessions = [
      { key: 'agent:main:main', displayName: 'agent:main:main' },
      { key: 'agent:test:main', displayName: 'agent:test:main' },
      { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
    ];
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: buildReadySessionCatalogStatus(sessions),
      loadedSessions: {
        'agent:main:main': createSessionRecord({ sessionKey: 'agent:main:main', ready: true }),
        'agent:test:main': createSessionRecord({ sessionKey: 'agent:test:main', ready: true }),
        'agent:test:session-2': createSessionRecord({
          sessionKey: 'agent:test:session-2',
          ready: true,
          label: '测试Agent会话',
          lastActivityAt: now,
        }),
      },
      switchSession,
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    const sessionTitle = screen.getByText('测试Agent会话');
    const sessionButton = sessionTitle.closest('button');
    expect(sessionButton).toBeTruthy();
    if (!sessionButton) {
      return;
    }
    fireEvent.click(sessionButton);

    expect(switchSession).toHaveBeenCalledWith('agent:test:session-2');
  });

  it('点击无历史会话的 agent 行，应走 agent 打开动作而不是切到伪 main 会话', () => {
    const switchSession = vi.fn();
    const openAgentConversation = vi.fn();
    const sessions = [
      { key: 'agent:main:main', displayName: 'agent:main:main' },
    ];
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: buildReadySessionCatalogStatus(sessions),
      loadedSessions: {
        'agent:main:main': createSessionRecord({ sessionKey: 'agent:main:main', ready: true }),
      },
      switchSession,
      newSession: vi.fn(),
      openAgentConversation,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();
    fireEvent.click(screen.getByTestId('agent-item-test'));

    expect(openAgentConversation).toHaveBeenCalledWith('test');
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('可删除会话并触发 deleteSession', async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const now = Date.now();
    const sessions = [
      { key: 'agent:main:main', displayName: 'agent:main:main' },
      { key: 'agent:main:session-1', displayName: 'agent:main:session-1' },
    ];

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: buildReadySessionCatalogStatus(sessions),
      loadedSessions: {
        'agent:main:main': createSessionRecord({ sessionKey: 'agent:main:main', ready: true }),
        'agent:main:session-1': createSessionRecord({
          sessionKey: 'agent:main:session-1',
          ready: true,
          label: '需要删除的会话',
          lastActivityAt: now - 1 * 24 * 60 * 60 * 1000,
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession,
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    fireEvent.click(screen.getByRole('button', { name: /Delete session .*需要删除的会话/i }));
    expect(screen.getByRole('dialog', { name: /Delete .*需要删除的会话/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Confirm Delete/i }));

    await waitFor(() => {
      expect(deleteSession).toHaveBeenCalledWith('agent:main:session-1');
    });
  });

  it('agent 列表和会话列表使用两个独立滚动区', () => {
    const now = Date.now();
    useSubagentsStore.setState({
      agents: Array.from({ length: 12 }, (_, index) => ({
        id: `agent-${index + 1}`,
        name: `Agent ${index + 1}`,
        isDefault: false,
        avatarSeed: `agent:agent-${index + 1}`,
        avatarStyle: 'pixelArt',
      })),
      loadAgents: vi.fn().mockResolvedValue(undefined),
    } as never);

    useChatStore.setState({
      currentSessionKey: 'agent:agent-1:main',
      sessionCatalogStatus: buildReadySessionCatalogStatus(Array.from({ length: 14 }, (_, index) => ({
        key: index === 0 ? 'agent:agent-1:main' : `agent:agent-1:session-${index}`,
        displayName: `agent:agent-1:session-${index}`,
      }))),
      loadedSessions: Object.fromEntries(
        Array.from({ length: 14 }, (_, index) => {
          const key = index === 0 ? 'agent:agent-1:main' : `agent:agent-1:session-${index}`;
          return [
            key,
            createSessionRecord({
              sessionKey: key,
              ready: true,
              label: index === 0 ? null : `会话 ${index}`,
              lastActivityAt: index === 0 ? now : now - index * 60_000,
            }),
          ] as const;
        }),
      ),
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    const agentScrollArea = screen.getByTestId('agent-list-scroll-area');
    const sessionScrollArea = screen.getByTestId('session-list-scroll-area');

    expect(agentScrollArea).toBeInTheDocument();
    expect(sessionScrollArea).toBeInTheDocument();
    expect(agentScrollArea).not.toBe(sessionScrollArea);
    expect(agentScrollArea.className).toContain('overflow-y-auto');
    expect(sessionScrollArea.className).toContain('overflow-y-auto');
  });

  it('agents 数据未就绪时，不应先渲染占位 avatar 的 agent 行', () => {
    useSubagentsStore.setState({
      agents: [],
      agentsResource: {
        status: 'loading',
        error: null,
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
      loadAgents: vi.fn().mockResolvedValue(undefined),
    } as never);

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
      ]),
      loadedSessions: {
        'agent:main:main': createSessionRecord({ sessionKey: 'agent:main:main', ready: true }),
        'agent:test:main': createSessionRecord({ sessionKey: 'agent:test:main', ready: true }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    expect(screen.queryByTestId('agent-item-main')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-item-test')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-list-loading')).toBeInTheDocument();
  });

  it('agent 资源失败时，不应阻塞会话列表渲染', () => {
    useSubagentsStore.setState({
      agents: [],
      agentsResource: {
        status: 'error',
        error: 'agents failed',
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
    } as never);

    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
      ]),
      loadedSessions: {
        'agent:test:main': createSessionRecord({ sessionKey: 'agent:test:main', ready: true }),
        'agent:test:session-2': createSessionRecord({
          sessionKey: 'agent:test:session-2',
          ready: true,
          label: '测试Agent会话',
          lastActivityAt: Date.now(),
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    expect(screen.getByTestId('agent-list-error')).toHaveTextContent('agents failed');
    expect(screen.getByText('测试Agent会话')).toBeInTheDocument();
  });

  it('会话标题消费本地 authoritative label，而不是回退旧值', () => {
    const now = Date.now();
    useChatStore.setState({
      currentSessionKey: 'agent:test:session-2',
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
      ]),
      loadedSessions: {
        'agent:test:main': createSessionRecord({ sessionKey: 'agent:test:main', ready: true }),
        'agent:test:session-2': createSessionRecord({
          sessionKey: 'agent:test:session-2',
          ready: true,
          label: '最新输入标题',
          lastActivityAt: now,
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    useChatStore.setState({
      loadedSessions: {
        ...useChatStore.getState().loadedSessions,
        'agent:test:session-2': {
          ...useChatStore.getState().loadedSessions['agent:test:session-2'],
          meta: {
            ...useChatStore.getState().loadedSessions['agent:test:session-2']!.meta,
            label: '最新输入标题',
          },
          items: buildRenderItemsFromMessages('agent:test:session-2', [
            {
              role: 'user',
              content: '最新输入标题',
              id: 'optimistic-user-1',
              timestamp: now / 1000,
            },
          ]),
        },
      },
    } as never);

    renderPane();

    expect(screen.getByText('最新输入标题')).toBeInTheDocument();
    expect(screen.queryByText('旧标题')).not.toBeInTheDocument();
  });

  it('会话标题在窗口正文已加载后，应消费同步后的 authoritative label', () => {
    const now = Date.now();
    useChatStore.setState({
      currentSessionKey: 'agent:test:session-2',
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
      ]),
      loadedSessions: {
        'agent:test:main': createSessionRecord({ sessionKey: 'agent:test:main', ready: true }),
        'agent:test:session-2': createSessionRecord({
          sessionKey: 'agent:test:session-2',
          ready: true,
          label: '正文里的新标题',
          lastActivityAt: now,
          messages: [
            {
              role: 'user',
              content: '正文里的新标题',
              id: 'user-1',
              timestamp: now / 1000,
            },
          ],
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    expect(screen.getByText('正文里的新标题')).toBeInTheDocument();
    expect(screen.queryByText('旧标题')).not.toBeInTheDocument();
  });

  it('会话列表不应把 displayName 当成正式标题 fallback', () => {
    const now = Date.now();
    useChatStore.setState({
      currentSessionKey: 'agent:test:session-1710000000000',
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:test:session-1710000000000', displayName: 'MatchaClaw Runtime Host' },
      ]),
      loadedSessions: {
        'agent:test:main': createSessionRecord({ sessionKey: 'agent:test:main', ready: true }),
        'agent:test:session-1710000000000': createSessionRecord({
          sessionKey: 'agent:test:session-1710000000000',
          ready: true,
          label: null,
          lastActivityAt: now,
          messages: [],
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    expect(screen.queryByText('MatchaClaw Runtime Host')).not.toBeInTheDocument();
  });

  it('会话资源加载中时，不应阻塞 agent 列表渲染', () => {
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      loadedSessions: {},
      sessionCatalogStatus: {
        status: 'loading',
        error: null,
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    expect(screen.getByTestId('agent-item-main')).toBeInTheDocument();
    expect(screen.getByTestId('agent-item-test')).toBeInTheDocument();
    expect(screen.getByTestId('session-list-loading')).toBeInTheDocument();
  });

  it('session 资源失败时，不应阻塞 agent 列表渲染', () => {
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      loadedSessions: {},
      sessionCatalogStatus: {
        status: 'error',
        error: 'sessions failed',
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    expect(screen.getByTestId('agent-item-main')).toBeInTheDocument();
    expect(screen.getByTestId('agent-item-test')).toBeInTheDocument();
    expect(screen.getByTestId('session-list-error')).toHaveTextContent('sessions failed');
  });

  it('只要 loadedSessions 已经有会话集合，session resource loading/error 都不应覆盖正文来源的会话列表', () => {
    const now = Date.now();
    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessionCatalogStatus: {
        status: 'loading',
        error: 'sessions failed',
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
      loadedSessions: {
        'agent:test:main': createSessionRecord({ sessionKey: 'agent:test:main', ready: true }),
        'agent:test:session-2': createSessionRecord({
          sessionKey: 'agent:test:session-2',
          ready: true,
          label: '正文来源会话',
          lastActivityAt: now,
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    expect(screen.queryByTestId('session-list-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-list-error')).not.toBeInTheDocument();
    expect(screen.getByText('正文来源会话')).toBeInTheDocument();
  });
});

