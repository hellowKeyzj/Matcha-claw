import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

function expectCapabilityExecute(payload: unknown, options?: { timeoutMs?: number }) {
  expect(hostApiFetchMock).toHaveBeenCalledWith('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify(payload),
    ...(options ? { timeoutMs: options.timeoutMs } : {}),
  });
}

describe('task manager client', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
  });

  it('listTaskSnapshot reads session scoped tasks and todos through tool.invoke capability', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      tasks: [
        { id: '1', subject: '整理需求', status: 'in_progress', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 2 },
      ],
      todos: [
        { content: '同步方案', status: 'pending' },
      ],
    });
    const { listTaskSnapshot } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');

    const snapshot = await listTaskSnapshot({ sessionKey: 'agent:main:main', sessionIdentity });

    expect(snapshot.tasks[0]).toMatchObject({
      id: '1',
      subject: '整理需求',
      status: 'in_progress',
    });
    expect(snapshot.todos).toEqual([{ content: '同步方案', status: 'pending' }]);
    expectCapabilityExecute({
      id: 'tool.invoke',
      operationId: 'tools.invoke',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'tool', toolName: 'TaskList', identity: sessionIdentity },
      input: {
        sessionIdentity,
        method: 'TaskList',
        params: { sessionKey: 'agent:main:main' },
      },
    }, { timeoutMs: 60000 });
  });

  it('createTask posts task fields through tool.invoke capability', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      task: {
        id: '2',
        subject: '实现接口',
        description: '接 TaskCreate',
        status: 'pending',
        blockedBy: [],
        blocks: [],
        createdAt: 1,
        updatedAt: 2,
      },
      todos: [{ content: '更新测试', status: 'pending' }],
    });
    const { createTask } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');

    const result = await createTask({
      sessionKey: 'agent:main:main',
      sessionIdentity,
      subject: '实现接口',
      description: '接 TaskCreate',
      activeForm: 'Implementing task API',
      metadata: { source: 'test' },
    });

    expect(result.task.id).toBe('2');
    expect(result.todos).toHaveLength(1);
    expectCapabilityExecute({
      id: 'tool.invoke',
      operationId: 'tools.invoke',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'tool', toolName: 'TaskCreate', identity: sessionIdentity },
      input: {
        sessionIdentity,
        method: 'TaskCreate',
        params: {
          sessionKey: 'agent:main:main',
          subject: '实现接口',
          description: '接 TaskCreate',
          activeForm: 'Implementing task API',
          metadata: { source: 'test' },
        },
      },
    }, { timeoutMs: 60000 });
  });

  it('updateTask supports deleted result through tool.invoke capability', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      taskId: '3',
      deleted: true,
      todos: [],
    });
    const { updateTask } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');

    const result = await updateTask({
      sessionKey: 'agent:main:main',
      sessionIdentity,
      taskId: '3',
      status: 'deleted',
    });

    expect(result).toEqual({ taskId: '3', deleted: true, todos: [] });
    expectCapabilityExecute({
      id: 'tool.invoke',
      operationId: 'tools.invoke',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'tool', toolName: 'TaskUpdate', identity: sessionIdentity },
      input: {
        sessionIdentity,
        method: 'TaskUpdate',
        params: { sessionKey: 'agent:main:main', taskId: '3', status: 'deleted' },
      },
    }, { timeoutMs: 60000 });
  });

  it('updateTask forwards dependency fields through tool.invoke capability', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      task: {
        id: '3',
        subject: '接入接口',
        description: '验证依赖添加',
        status: 'pending',
        blockedBy: ['1'],
        blocks: ['4'],
        createdAt: 1,
        updatedAt: 2,
      },
      todos: [],
    });
    const { updateTask } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');

    const result = await updateTask({
      sessionKey: 'agent:main:main',
      sessionIdentity,
      taskId: '3',
      addBlockedBy: ['1'],
      addBlocks: ['4'],
    });

    expect(result.task).toMatchObject({ id: '3', blockedBy: ['1'], blocks: ['4'] });
    expectCapabilityExecute({
      id: 'tool.invoke',
      operationId: 'tools.invoke',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'tool', toolName: 'TaskUpdate', identity: sessionIdentity },
      input: {
        sessionIdentity,
        method: 'TaskUpdate',
        params: { sessionKey: 'agent:main:main', taskId: '3', addBlockedBy: ['1'], addBlocks: ['4'] },
      },
    }, { timeoutMs: 60000 });
  });

  it('writeTodos posts oldTodos and newTodos through tool.invoke capability', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      todos: [{ content: 'done', status: 'completed' }],
      updatedAt: 12,
    });
    const { writeTodos } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');

    const result = await writeTodos({
      sessionKey: 'agent:main:main',
      sessionIdentity,
      oldTodos: [],
      newTodos: [{ content: 'done', status: 'completed' }],
    });

    expect(result.updatedAt).toBe(12);
    expect(result.todos[0]).toMatchObject({ content: 'done', status: 'completed' });
    expectCapabilityExecute({
      id: 'tool.invoke',
      operationId: 'tools.invoke',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'tool', toolName: 'TodoWrite', identity: sessionIdentity },
      input: {
        sessionIdentity,
        method: 'TodoWrite',
        params: {
          sessionKey: 'agent:main:main',
          oldTodos: [],
          newTodos: [{ content: 'done', status: 'completed' }],
        },
      },
    }, { timeoutMs: 60000 });
  });

  it('getTaskOutput reads task output through runtime instance scope and task owner target', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ status: 200, data: { success: true, task: { id: 'job-1' } } });
    const { getTaskOutput } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');

    const result = await getTaskOutput({
      sessionIdentity,
      taskId: 'job-1',
      wait: true,
      timeoutMs: 5000,
    });

    expect(result).toEqual({ status: 200, data: { success: true, task: { id: 'job-1' } } });
    expectCapabilityExecute({
      id: 'task.control',
      operationId: 'tasks.output',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'task', taskId: 'job-1', owner: { kind: 'session', identity: sessionIdentity } },
      input: {
        sessionIdentity,
        taskId: 'job-1',
        wait: true,
        timeoutMs: 5000,
      },
    }, { timeoutMs: 5000 });
  });

  it('stopTask stops task through runtime instance scope and task owner target', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ status: 200, data: { success: true, task: { id: 'job-1', status: 'cancelled' } } });
    const { stopTask } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');

    const result = await stopTask({ sessionIdentity, taskId: 'job-1' });

    expect(result).toEqual({ status: 200, data: { success: true, task: { id: 'job-1', status: 'cancelled' } } });
    expectCapabilityExecute({
      id: 'task.control',
      operationId: 'tasks.stop',
      scope: { kind: 'session', identity: sessionIdentity },
      target: { kind: 'task', taskId: 'job-1', owner: { kind: 'session', identity: sessionIdentity } },
      input: {
        sessionIdentity,
        taskId: 'job-1',
      },
    }, { timeoutMs: 60000 });
  });
});
