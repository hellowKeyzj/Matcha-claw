import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TasksPage } from '@/pages/Tasks';
import { useGatewayStore } from '@/stores/gateway';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { useTaskSnapshotStore } from '@/stores/chat/task-snapshot-store';
import { useChatStore } from '@/stores/chat';
import { createReadyResourceStatusState } from '@/lib/resource-state';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRuntimeScopeKey } from '@/stores/chat/session-identity';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';
import i18n from '@/i18n';

const listTaskSnapshotMock = vi.fn();

vi.mock('@/services/openclaw/task-manager-client', () => ({
  listTaskSnapshot: (...args: unknown[]) => listTaskSnapshotMock(...args),
}));

const tasks = [
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
];

beforeEach(() => {
  listTaskSnapshotMock.mockReset();
  listTaskSnapshotMock.mockResolvedValue({
    scope: { type: 'session', key: 'agent:main:main', label: 'main', sessionKey: 'agent:main:main', agentId: 'main' },
    tasks,
    todos: [],
  });
});

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

  useTaskSnapshotStore.getState().reportTaskCenterData('agent:main:main', tasks as never);

  const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main', 'main');
  const mainSession = useChatStore.getState().loadedSessions['agent:main:main'] ?? createEmptySessionRecord();
  useChatStore.setState({
    currentSessionKey: 'agent:main:main',
    sessionCatalogStatus: createReadyResourceStatusState(1),
    loadedSessions: {
      'agent:main:main': {
        ...mainSession,
        meta: {
          ...mainSession.meta,
          backendSessionKey: 'agent:main:main',
          runtimeScopeKey: buildRuntimeScopeKey(sessionIdentity.endpoint),
          agentId: 'main',
          sessionIdentity,
        },
      },
    },
  } as never);

  useTaskCenterStore.setState({
    initialized: true,
    error: null,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    sessionKey: 'agent:main:main',
    init: vi.fn().mockResolvedValue(undefined),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
  } as never);

  i18n.changeLanguage('en');
}

describe('tasks status filter', () => {
  it('点击统计卡片后按状态过滤任务列表', async () => {
    setupStores();

    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <TasksPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: /Task In Progress/i })).toBeInTheDocument();
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

  it('初始化前显示准备中，不显示未运行警告', async () => {
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
    await waitFor(() => expect(listTaskSnapshotMock).toHaveBeenCalled());
  });

  it('任务中心不展示 TodoWrite 派生的会话待办', async () => {
    setupStores();
    listTaskSnapshotMock.mockResolvedValue({ tasks: [], todos: [] });
    useTaskSnapshotStore.getState().cleanup('agent:main:main');
    useTaskSnapshotStore.getState().reportTodos('agent:main:main', [
      { content: 'Only chat todo', status: 'pending' },
    ]);

    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <TasksPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/No tasks available/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Only chat todo/i })).not.toBeInTheDocument();
  });
});
