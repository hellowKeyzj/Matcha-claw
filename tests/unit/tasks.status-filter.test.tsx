import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TasksPage } from '@/pages/Tasks';
import { useGatewayStore } from '@/stores/gateway';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { useTaskSnapshotStore } from '@/stores/chat/task-snapshot-store';
import i18n from '@/i18n';

function setupStores() {
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
    isInitialized: true,
    init: vi.fn().mockResolvedValue(undefined),
  } as never);

  useTaskSnapshotStore.getState().reportTaskData('agent:main:main', [
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
  ]);

  useTaskCenterStore.setState({
    initialized: true,
    error: null,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    sessionKey: 'agent:main:main',
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

  it('初始化前显示准备中，不显示未运行警告', () => {
    setupStores();
    useGatewayStore.setState({
      isInitialized: false,
      status: {
        processState: 'stopped',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'unresponsive',
        transportState: 'disconnected',
        portReachable: false,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      },
    } as never);

    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <TasksPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Gateway is starting/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Gateway is not running$/i)).not.toBeInTheDocument();
  });
});
