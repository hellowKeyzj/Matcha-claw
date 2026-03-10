import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSettingsStore } from '@/stores/settings';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location-echo">{location.pathname}</div>;
}

function mountSidebar(initialPath: string) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="*"
          element={(
            <>
              <Sidebar />
              <LocationEcho />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function setupSidebarState() {
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
    loading: false,
    error: null,
    selectedAgentId: null,
    loadAgents: vi.fn().mockResolvedValue(undefined),
    loadAvailableModels: vi.fn().mockResolvedValue(undefined),
    selectAgent: vi.fn(),
  } as never);
  useGatewayStore.setState({
    status: { state: 'running', port: 18789 },
    init: vi.fn().mockResolvedValue(undefined),
  } as never);
  i18n.changeLanguage('en');
}

describe('sidebar chat nav', () => {
  it('from non-chat routes, clicking chat only navigates and does not create new session', () => {
    setupSidebarState();
    const newSession = vi.fn();
    useChatStore.setState({
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      sessionLabels: {},
      sessionLastActivity: {},
      messages: [{ role: 'user', content: 'existing' }],
      newSession,
      switchSession: vi.fn(),
      deleteSession: vi.fn(),
    } as never);

    mountSidebar('/tasks');

    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));

    expect(newSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('location-echo')).toHaveTextContent('/');
  });

  it('on chat route, clicking chat creates new session when current session has messages', () => {
    setupSidebarState();
    const newSession = vi.fn();
    useChatStore.setState({
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      sessionLabels: {},
      sessionLastActivity: {},
      messages: [{ role: 'user', content: 'existing' }],
      newSession,
      switchSession: vi.fn(),
      deleteSession: vi.fn(),
    } as never);

    mountSidebar('/');

    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));

    expect(newSession).toHaveBeenCalledTimes(1);
  });
});
