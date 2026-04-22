import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '@/App';
import { Sidebar } from '@/components/layout/Sidebar';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSettingsStore } from '@/stores/settings';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';

function enableMainAppRoutes() {
  useSettingsStore.setState({
    setupComplete: true,
    language: 'en',
    sidebarCollapsed: false,
    devModeUnlocked: false,
    init: vi.fn().mockResolvedValue(undefined),
  } as never);
  useSubagentsStore.setState({
    agents: [],
    availableModels: [],
    modelsLoading: false,
    agentsResource: {
      status: 'ready',
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: 1,
    },
    mutating: false,
    error: null,
    selectedAgentId: null,
    loadAgents: vi.fn().mockResolvedValue(undefined),
    loadAvailableModels: vi.fn().mockResolvedValue(undefined),
    selectAgent: vi.fn(),
  } as never);
  useChatStore.setState({
    sessions: [],
    currentSessionKey: 'agent:main:main',
    switchSession: vi.fn(),
    loadSessions: vi.fn().mockResolvedValue(undefined),
  } as never);
  useGatewayStore.setState({
    status: { state: 'running', port: 18789 },
    init: vi.fn().mockResolvedValue(undefined),
  } as never);
  i18n.changeLanguage('en');
}

describe('subagents navigation', () => {
  it('shows subagents entry in sidebar', () => {
    enableMainAppRoutes();

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    const subagentsLink = screen.getByRole('link', { name: 'Subagents' });
    expect(subagentsLink).toHaveAttribute('href', '/subagents');
  });

  it('renders subagents page at /subagents', async () => {
    enableMainAppRoutes();

    render(
      <MemoryRouter initialEntries={['/subagents']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Subagent Workspace')).toBeInTheDocument();
  });
});
