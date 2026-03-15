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
  it('sidebar 显示 task center 导航入口且不再显示 cron 入口', () => {
    enableMainAppRoutes();

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    const tasksLink = screen.getByRole('link', { name: 'Task Center' });
    expect(tasksLink).toHaveAttribute('href', '/tasks');
    expect(screen.queryByRole('link', { name: 'Cron Tasks' })).not.toBeInTheDocument();
  });

  it('路由 /tasks 渲染任务中心并包含两个页签', () => {
    enableMainAppRoutes();

    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Task Center' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Long Tasks' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Scheduled Tasks' })).toBeInTheDocument();
    expect(screen.getByText('Incomplete')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All Time' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 7 Days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 30 Days' })).toBeInTheDocument();
  });

  it('路由 /cron 会重定向到任务中心的定时任务页签', () => {
    enableMainAppRoutes();

    render(
      <MemoryRouter initialEntries={['/cron']}>
        <App />
      </MemoryRouter>,
    );

    const scheduledTab = screen.getByRole('tab', { name: 'Scheduled Tasks' });
    expect(scheduledTab).toHaveAttribute('data-state', 'active');
  });
});
