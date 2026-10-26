import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import App from '@/App';
import { Sidebar } from '@/components/layout/Sidebar';
import { useChatStore } from '@/plugins/chat/store';
import { createPluginHost } from '@/plugin-host/core';
import { PluginHostProvider } from '@/plugin-host/react';
import { applicationPages, applicationShellPlugin } from '@/app/extensions';
import { teamsPlugin } from '@/plugins/teams/plugin';
import { chatPlugin } from '@/plugins/chat/plugin';
import { useRuntimeHostStore } from '@/plugins/runtime/store';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsStore } from '@/plugins/settings/store';
import { useAccountStore } from '@/plugins/account/stores/account';
import { useSubagentsStore } from '@/plugins/agents/stores/subagents';
import { preloadRoute } from '@/app/routes';
import i18n from '@/i18n';

const host = createPluginHost([applicationShellPlugin, chatPlugin, teamsPlugin]);

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location-echo">{location.pathname}</div>;
}

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
    runtimeHost: { lifecycle: 'running', hostLifecycle: 'ready' },
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

describe('teams navigation', () => {
  it('shows teams entry in sidebar when the feature flag is enabled by default', () => {
    enableMainAppRoutes();

    render(
      <MemoryRouter>
        <PluginHostProvider host={host}>
          <Sidebar />
        </PluginHostProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Teams' })).toHaveAttribute('href', '/teams');
  });

  it('redirects /teams while the feature flag is off', async () => {
    enableMainAppRoutes();
    vi.stubEnv('VITE_ENABLE_TEAMS_FEATURE', 'false');
    vi.resetModules();
    try {
      const [{ teamsPlugin: disabledTeamsPlugin }, { applicationShellPlugin: shellPlugin }, { chatPlugin: disabledChatPlugin }] = await Promise.all([
        import('@/plugins/teams/plugin'),
        import('@/app/extensions'),
        import('@/plugins/chat/plugin'),
      ]);
      const disabledHost = createPluginHost([shellPlugin, disabledChatPlugin, disabledTeamsPlugin]);
      render(
        <MemoryRouter initialEntries={['/teams']}>
          <PluginHostProvider host={disabledHost}>
            <App />
          </PluginHostProvider>
          <LocationEcho />
        </MemoryRouter>,
      );

      expect(await screen.findByTestId('location-echo')).toHaveTextContent('/');
      expect(screen.queryByText('Agents Workspace')).not.toBeInTheDocument();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('preloads teams routes when the feature flag is enabled by default', async () => {
    const pages = host.get(applicationPages);
    const listPreload = vi.spyOn(pages.find((page) => page.path === '/teams')!, 'preload');
    const detailPreload = vi.spyOn(pages.find((page) => page.path === '/teams/:teamId')!, 'preload');
    await preloadRoute(host, '/teams');
    await preloadRoute(host, '/teams/team-1');
    expect(listPreload).toHaveBeenCalledTimes(1);
    expect(detailPreload).toHaveBeenCalledTimes(1);
  });
});
