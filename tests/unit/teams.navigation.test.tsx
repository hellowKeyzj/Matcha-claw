import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import App from '@/App';
import { Sidebar } from '@/components/layout/Sidebar';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsStore } from '@/stores/settings';
import { useSubagentsStore } from '@/stores/subagents';
import { preloadLazyRouteForPath } from '@/lib/route-preload';
import i18n from '@/i18n';

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location-echo">{location.pathname}</div>;
}

function enableMainAppRoutes() {
  useSettingsStore.setState({
    setupComplete: true,
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
  useGatewayStore.setState({
    status: {
      processState: 'running',
      port: 18789,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1,
    },
    init: vi.fn().mockResolvedValue(undefined),
  } as never);
  i18n.changeLanguage('en');
}

describe('teams navigation', () => {
  it('hides teams entry in sidebar while the feature flag is off', () => {
    enableMainAppRoutes();

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('link', { name: 'Teams' })).not.toBeInTheDocument();
  });

  it('redirects /teams while the feature flag is off', async () => {
    enableMainAppRoutes();

    render(
      <MemoryRouter initialEntries={['/teams']}>
        <App />
        <LocationEcho />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('location-echo')).toHaveTextContent('/');
    expect(screen.queryByText('Agents Workspace')).not.toBeInTheDocument();
  });

  it('does not preload teams routes while the feature flag is off', () => {
    expect(preloadLazyRouteForPath('/teams')).toBeNull();
    expect(preloadLazyRouteForPath('/teams/team-1')).toBeNull();
  });
});
