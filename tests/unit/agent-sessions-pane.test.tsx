import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentSessionsPane } from '@/components/layout/AgentSessionsPane';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';
import type { RawMessage } from '@/stores/chat';

const readyResource = {
  status: 'ready' as const,
  error: null,
  hasLoadedOnce: true,
  lastLoadedAt: 1,
};

function createSessionRecord(input?: {
  transcript?: RawMessage[];
  label?: string | null;
  lastActivityAt?: number | null;
  ready?: boolean;
}) {
  return {
    transcript: input?.transcript ?? [],
    meta: {
      label: input?.label ?? null,
      lastActivityAt: input?.lastActivityAt ?? null,
      ready: input?.ready ?? false,
      thinkingLevel: null,
    },
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'idle' as const,
      streamingMessage: null,
      streamRuntime: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle' as const,
    },
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
    sessionsResource: readyResource,
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
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:main:session-1', displayName: 'agent:main:session-1' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
      ],
      sessionsByKey: {
        'agent:main:main': createSessionRecord({ ready: true }),
        'agent:main:session-1': createSessionRecord({ ready: true, label: '主Agent会话', lastActivityAt: now - 1 * 24 * 60 * 60 * 1000 }),
        'agent:test:main': createSessionRecord({ ready: true }),
        'agent:test:session-2': createSessionRecord({ ready: true, label: '测试Agent会话', lastActivityAt: now - 2 * 24 * 60 * 60 * 1000 }),
      },
      sessionsResource: readyResource,
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

  it('点击某个 agent 的新会话按钮，应按对应 agent 创建', async () => {
    const newSession = vi.fn();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
      ],
      sessionsByKey: {
        'agent:main:main': createSessionRecord({ ready: true }),
        'agent:test:main': createSessionRecord({ ready: true }),
      },
      sessionsResource: readyResource,
      switchSession: vi.fn(),
      newSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    fireEvent.click(screen.getByTestId('agent-new-session-test'));
    expect(newSession).toHaveBeenCalledWith('test');
  });

  it('点击无历史会话的 agent 行，应走 agent 打开动作而不是切到伪 main 会话', () => {
    const switchSession = vi.fn();
    const openAgentConversation = vi.fn();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [
        { key: 'agent:main:main', displayName: 'agent:main:main' },
      ],
      sessionsByKey: {
        'agent:main:main': createSessionRecord({ ready: true }),
      },
      sessionsResource: readyResource,
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

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:main:session-1', displayName: 'agent:main:session-1' },
      ],
      sessionsByKey: {
        'agent:main:main': createSessionRecord({ ready: true }),
        'agent:main:session-1': createSessionRecord({
          ready: true,
          label: '需要删除的会话',
          lastActivityAt: now - 1 * 24 * 60 * 60 * 1000,
        }),
      },
      sessionsResource: readyResource,
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
      sessions: Array.from({ length: 14 }, (_, index) => ({
        key: index === 0 ? 'agent:agent-1:main' : `agent:agent-1:session-${index}`,
        displayName: `agent:agent-1:session-${index}`,
      })),
      sessionsByKey: Object.fromEntries(
        Array.from({ length: 14 }, (_, index) => {
          const key = index === 0 ? 'agent:agent-1:main' : `agent:agent-1:session-${index}`;
          return [
            key,
            createSessionRecord({
              ready: true,
              label: index === 0 ? null : `会话 ${index}`,
              lastActivityAt: index === 0 ? now : now - index * 60_000,
            }),
          ] as const;
        }),
      ),
      sessionsResource: readyResource,
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
      sessions: [
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
      ],
      sessionsByKey: {
        'agent:main:main': createSessionRecord({ ready: true }),
        'agent:test:main': createSessionRecord({ ready: true }),
      },
      sessionsResource: readyResource,
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
      sessions: [
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
      ],
      sessionsByKey: {
        'agent:test:main': createSessionRecord({ ready: true }),
        'agent:test:session-2': createSessionRecord({
          ready: true,
          label: '测试Agent会话',
          lastActivityAt: Date.now(),
        }),
      },
      sessionsResource: readyResource,
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    expect(screen.getByTestId('agent-list-error')).toHaveTextContent('agents failed');
    expect(screen.getByText('测试Agent会话')).toBeInTheDocument();
  });

  it('会话资源加载中时，不应阻塞 agent 列表渲染', () => {
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [],
      sessionsByKey: {},
      sessionsResource: {
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
      sessions: [],
      sessionsByKey: {},
      sessionsResource: {
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
});
