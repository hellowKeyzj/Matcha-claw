import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TasksPage } from '@/pages/Tasks';
import { useGatewayStore } from '@/stores/gateway';
import { useTaskCenterStore } from '@/stores/task-center-store';
import i18n from '@/i18n';

function setupStores() {
  useGatewayStore.setState({
    status: { state: 'running', port: 18789 },
    init: vi.fn().mockResolvedValue(undefined),
  } as never);

  useTaskCenterStore.setState({
    tasks: [
      {
        id: 'task-running',
        goal: 'Task Running',
        status: 'running',
        progress: 0.4,
        plan_markdown: '',
        created_at: 100,
        updated_at: 200,
      },
      {
        id: 'task-waiting',
        goal: 'Task Waiting',
        status: 'waiting_for_input',
        progress: 0.2,
        plan_markdown: '',
        created_at: 100,
        updated_at: 200,
      },
      {
        id: 'task-completed',
        goal: 'Task Completed',
        status: 'completed',
        progress: 1,
        plan_markdown: '',
        created_at: 100,
        updated_at: 200,
      },
      {
        id: 'task-failed',
        goal: 'Task Failed',
        status: 'failed',
        progress: 0.6,
        plan_markdown: '',
        created_at: 100,
        updated_at: 200,
      },
    ],
    loading: false,
    initialized: true,
    error: null,
    workspaceDir: null,
    workspaceDirs: [],
    pluginInstalled: true,
    pluginEnabled: true,
    pluginVersion: undefined,
    blockedQueue: [],
    init: vi.fn().mockResolvedValue(undefined),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
    resumeBlockedTask: vi.fn().mockResolvedValue(undefined),
    closeBlockedDialog: vi.fn(),
    handleGatewayNotification: vi.fn(),
  } as never);

  i18n.changeLanguage('en');
}

describe('tasks status filter', () => {
  it('点击统计卡片后按状态过滤任务列表', () => {
    setupStores();

    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <TasksPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: /Task Running/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Task Waiting/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Task Completed/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Task Failed/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Completed$/i }));
    expect(screen.getByRole('button', { name: /Task Completed/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Task Running/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Task Waiting/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Task Failed/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Incomplete$/i }));
    expect(screen.queryByRole('button', { name: /Task Completed/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Task Running/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Task Waiting/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Task Failed/i })).toBeInTheDocument();
  });
});
