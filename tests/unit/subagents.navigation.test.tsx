import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '@/App';
import { Sidebar } from '@/components/layout/Sidebar';
import { AgentSessionsPane } from '@/components/layout/AgentSessionsPane';
import { useChatStore, type ChatSession } from '@/stores/chat';
import { useSettingsStore } from '@/stores/settings';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';

function enableMainAppRoutes() {
  useSettingsStore.setState({
    setupComplete: true,
    language: 'en',
    sidebarCollapsed: false,
    devModeUnlocked: false,
  });
  useSubagentsStore.setState({
    agents: [],
    availableModels: [],
    modelsLoading: false,
    loading: false,
    error: null,
    selectedAgentId: null,
    loadAgents: vi.fn().mockResolvedValue(undefined),
    loadAgentsForDisplay: vi.fn().mockResolvedValue(undefined),
    loadAvailableModels: vi.fn().mockResolvedValue(undefined),
    selectAgent: vi.fn(),
  });
  useChatStore.setState({
    sessions: [],
    currentSessionKey: 'agent:main:main',
    switchSession: vi.fn(),
    loadSessions: vi.fn().mockResolvedValue(undefined),
  } as never);
  i18n.changeLanguage('en');
}

describe('subagents navigation', () => {
  it('shows subagents entry in sidebar', () => {
    enableMainAppRoutes();

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    );

    const subagentsLink = screen.getByRole('link', { name: 'Subagents' });
    expect(subagentsLink).toHaveAttribute('href', '/subagents');
  });

  it('renders placeholder page at /subagents', () => {
    enableMainAppRoutes();

    render(
      <MemoryRouter initialEntries={['/subagents']}>
        <App />
      </MemoryRouter>
    );

    expect(screen.getByText('Subagent Workspace')).toBeInTheDocument();
  });

  it('在独立 Agent 会话栏显示全部 Agent，并支持点击切换会话', () => {
    enableMainAppRoutes();
    const switchSession = vi.fn();
    const sessions: ChatSession[] = [
      { key: 'agent:main:main', displayName: 'Main Session' },
      { key: 'agent:risk-expert:risk-expert', displayName: 'Risk Home' },
      { key: 'agent:risk-expert:loan-review', displayName: 'Loan Review' },
      { key: 'agent:risk-expert:session-123', displayName: 'MatchaClaw' },
    ];

    useSubagentsStore.setState({
      agents: [
        { id: 'main', name: 'Main Agent' },
        { id: 'risk-expert', name: 'Risk Expert', identityEmoji: '🧠' },
      ],
      loadAgents: vi.fn().mockResolvedValue(undefined),
      loadAgentsForDisplay: vi.fn().mockResolvedValue(undefined),
    });
    useChatStore.setState({
      sessions,
      currentSessionKey: 'agent:other:main',
      switchSession: switchSession as never,
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <AgentSessionsPane />
      </MemoryRouter>,
    );

    const mainButton = screen.getByText('Main Agent').closest('button');
    if (!mainButton) {
      throw new Error('main agent button not found');
    }
    const agentButton = screen.getByText('Risk Expert').closest('button');
    if (!agentButton) {
      throw new Error('risk expert button not found');
    }
    const sessionButton = screen.getByRole('button', { name: /Risk Home/i });
    const fallbackSessionButton = screen.getByRole('button', { name: /session-123/i });

    fireEvent.click(mainButton);
    expect(switchSession).toHaveBeenNthCalledWith(1, 'agent:main:main');

    fireEvent.click(agentButton);
    expect(switchSession).toHaveBeenNthCalledWith(2, 'agent:risk-expert:loan-review');

    fireEvent.click(sessionButton);
    expect(switchSession).toHaveBeenNthCalledWith(3, 'agent:risk-expert:risk-expert');
    expect(fallbackSessionButton).toBeInTheDocument();

    const emojiNodes = screen.getAllByText('🧠');
    expect(emojiNodes.length).toBeGreaterThanOrEqual(2);
  });

  it('每个 Agent 分组支持独立折叠/展开', () => {
    enableMainAppRoutes();
    useSubagentsStore.setState({
      agents: [
        { id: 'main', name: 'Main Agent' },
        { id: 'risk-expert', name: 'Risk Expert', identityEmoji: '🧠' },
      ],
      loadAgents: vi.fn().mockResolvedValue(undefined),
      loadAgentsForDisplay: vi.fn().mockResolvedValue(undefined),
    });
    useChatStore.setState({
      sessions: [
        { key: 'agent:main:main', displayName: 'Main Session' },
        { key: 'agent:risk-expert:risk-expert', displayName: 'Risk Home' },
        { key: 'agent:risk-expert:loan-review', displayName: 'Loan Review' },
      ],
      currentSessionKey: 'agent:risk-expert:loan-review',
      switchSession: vi.fn(),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <AgentSessionsPane />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: /Risk Home/i })).toBeInTheDocument();

    const riskAgentButton = screen.getByText('Risk Expert').closest('button');
    if (!riskAgentButton) {
      throw new Error('risk expert button not found');
    }
    const riskGroupHeader = riskAgentButton.parentElement;
    if (!riskGroupHeader) {
      throw new Error('risk group header not found');
    }
    fireEvent.click(within(riskGroupHeader).getByRole('button', { name: 'Collapse session group' }));
    expect(screen.queryByRole('button', { name: /Risk Home/i })).not.toBeInTheDocument();

    fireEvent.click(within(riskGroupHeader).getByRole('button', { name: 'Expand session group' }));
    expect(screen.getByRole('button', { name: /Risk Home/i })).toBeInTheDocument();
  });

  it('支持收缩/展开 Agent 会话栏', () => {
    enableMainAppRoutes();
    const onToggleCollapse = vi.fn();
    useSubagentsStore.setState({
      agents: [{ id: 'main', name: 'Main Agent' }],
      loadAgents: vi.fn().mockResolvedValue(undefined),
      loadAgentsForDisplay: vi.fn().mockResolvedValue(undefined),
    });
    useChatStore.setState({
      sessions: [{ key: 'agent:main:main', displayName: 'Main Session' }],
      currentSessionKey: 'agent:main:main',
      switchSession: vi.fn(),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <AgentSessionsPane collapsed onToggleCollapse={onToggleCollapse} />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Main Agent')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Expand agent sessions pane/i }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });
});
