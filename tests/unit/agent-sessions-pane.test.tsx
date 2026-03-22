import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentSessionsPane } from '@/components/layout/AgentSessionsPane';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';

function setupBaseState() {
  useGatewayStore.setState({
    status: { state: 'running', port: 18789 },
    init: vi.fn().mockResolvedValue(undefined),
  } as never);

  useSubagentsStore.setState({
    agents: [
      { id: 'main', name: 'main', isDefault: true, identity: { emoji: '🐱' } },
      { id: 'test', name: 'test', isDefault: false, identity: { emoji: '🤖' } },
    ],
    loadAgents: vi.fn().mockResolvedValue(undefined),
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
      sessionLabels: {
        'agent:main:session-1': '主Agent会话',
        'agent:test:session-2': '测试Agent会话',
      },
      sessionLastActivity: {
        'agent:main:session-1': now - 1 * 24 * 60 * 60 * 1000,
        'agent:test:session-2': now - 2 * 24 * 60 * 60 * 1000,
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    expect(screen.getByTestId('agent-item-main')).toBeInTheDocument();
    expect(screen.getByTestId('agent-item-test')).toBeInTheDocument();
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
      sessionLabels: {},
      sessionLastActivity: {},
      switchSession: vi.fn(),
      newSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    fireEvent.click(screen.getByTestId('agent-new-session-test'));
    expect(newSession).toHaveBeenCalledWith('test');
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
      sessionLabels: {
        'agent:main:session-1': '需要删除的会话',
      },
      sessionLastActivity: {
        'agent:main:session-1': now - 1 * 24 * 60 * 60 * 1000,
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
});
