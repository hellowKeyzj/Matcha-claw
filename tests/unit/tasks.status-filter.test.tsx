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
        id: 'task-in-progress',
        subject: 'Task In Progress',
        description: 'desc',
        status: 'in_progress',
        blockedBy: [],
        blocks: [],
        createdAt: 100,
        updatedAt: 200,
      },
      {
        id: 'task-pending',
        subject: 'Task Pending',
        description: 'desc',
        status: 'pending',
        blockedBy: [],
        blocks: [],
        createdAt: 100,
        updatedAt: 200,
      },
      {
        id: 'task-completed',
        subject: 'Task Completed',
        description: 'desc',
        status: 'completed',
        blockedBy: [],
        blocks: [],
        createdAt: 100,
        updatedAt: 200,
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
    init: vi.fn().mockResolvedValue(undefined),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
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

    expect(screen.getByRole('button', { name: /Task In Progress/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Task Pending/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Task Completed/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Completed$/i }));
    expect(screen.getByRole('button', { name: /Task Completed/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Task In Progress/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Task Pending/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Incomplete$/i }));
    expect(screen.queryByRole('button', { name: /Task Completed/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Task In Progress/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Task Pending/i })).toBeInTheDocument();
  });
});
