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
    loading: false,
    error: null,
    selectedAgentId: null,
    loadAgents: vi.fn().mockResolvedValue(undefined),
    loadAvailableModels: vi.fn().mockResolvedValue(undefined),
    selectAgent: vi.fn(),
  } as never);
  useChatStore.setState({
    sessions: [],
    messages: [],
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

describe('tasks navigation', () => {
  it('sidebar 显示 tasks 导航入口', () => {
    enableMainAppRoutes();

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    const tasksLink = screen.getByRole('link', { name: 'Tasks' });
    expect(tasksLink).toHaveAttribute('href', '/tasks');
  });

  it('路由 /tasks 渲染任务页', () => {
    enableMainAppRoutes();

    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText('Task Center')).toBeInTheDocument();
  });
});
