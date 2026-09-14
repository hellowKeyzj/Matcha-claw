import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '@/App';
import { Sidebar } from '@/components/layout/Sidebar';
import { useChatStore } from '@/stores/chat';
import { useRuntimeHostStore } from '@/stores/gateway';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsStore } from '@/stores/settings';
import { useAccountStore } from '@/stores/account';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';

function enableMainAppRoutes() {
  useSettingsStore.setState({
    language: 'en',
    devModeUnlocked: false,
    init: vi.fn().mockResolvedValue(undefined),
  } as never);
  useLayoutStore.setState({
    sidebarVisible: true,
    sidebarWidth: 256,
  });
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
    sessionCatalogStatus: {
      status: 'ready',
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: 1,
    },
    currentSessionKey: 'agent:main:main',
    switchSession: vi.fn(),
    loadSessions: vi.fn().mockResolvedValue(undefined),
  } as never);
  useRuntimeHostStore.setState({
    runtimeHost: { lifecycle: 'running' },
    init: vi.fn().mockResolvedValue(undefined),
  } as never);
  useAccountStore.setState({
    status: 'signedIn',
    user: {
      id: 1,
      username: 'matcha',
      email: 'matcha@example.com',
      role: 'user',
      balance: 0,
      concurrency: 1,
      status: 'active',
      allowedGroups: null,
      balanceNotifyEnabled: false,
      balanceNotifyThreshold: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    subscription: null,
    usage: null,
    platformQuotas: null,
    publicSettings: { registrationEnabled: true, emailVerifyEnabled: false },
    errorMessage: null,
    twoFactorChallengeId: null,
    twoFactorEmail: null,
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
