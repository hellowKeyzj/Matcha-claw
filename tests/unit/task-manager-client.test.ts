import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

describe('task manager client', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
  });

  it('listTaskSnapshot reads session scoped tasks and todos', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      tasks: [
        { id: '1', subject: '整理需求', status: 'in_progress', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 2 },
      ],
      todos: [
        { content: '同步方案', status: 'pending' },
      ],
    });
    const { listTaskSnapshot } = await import('@/services/openclaw/task-manager-client');

    const snapshot = await listTaskSnapshot('agent:main:main');

    expect(snapshot.tasks[0]).toMatchObject({
      id: '1',
      subject: '整理需求',
      status: 'in_progress',
    });
    expect(snapshot.todos).toEqual([{ content: '同步方案', status: 'pending' }]);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/tasks/list', {
      method: 'POST',
      body: JSON.stringify({ sessionKey: 'agent:main:main' }),
      timeoutMs: 60000,
    });
  });

  it('createTask posts WorkBuddy task fields and returns task with todos', async () => {
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

    const result = await createTask({
      sessionKey: 'agent:main:main',
      subject: '实现接口',
      description: '接 TaskCreate',
      activeForm: 'Implementing task API',
      metadata: { source: 'test' },
    });

    expect(result.task.id).toBe('2');
    expect(result.todos).toHaveLength(1);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/tasks/create', {
      method: 'POST',
      body: JSON.stringify({
        sessionKey: 'agent:main:main',
        subject: '实现接口',
        description: '接 TaskCreate',
        activeForm: 'Implementing task API',
        metadata: { source: 'test' },
      }),
      timeoutMs: 60000,
    });
  });

  it('updateTask supports deleted result', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      taskId: '3',
      deleted: true,
      todos: [],
    });
    const { updateTask } = await import('@/services/openclaw/task-manager-client');

    const result = await updateTask({
      sessionKey: 'agent:main:main',
      taskId: '3',
      status: 'deleted',
    });

    expect(result).toEqual({ taskId: '3', deleted: true, todos: [] });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/tasks/update', {
      method: 'POST',
      body: JSON.stringify({
        sessionKey: 'agent:main:main',
        taskId: '3',
        status: 'deleted',
      }),
      timeoutMs: 60000,
    });
  });

  it('writeTodos posts oldTodos and newTodos to TodoWrite route', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      todos: [{ content: 'done', status: 'completed' }],
      updatedAt: 12,
    });
    const { writeTodos } = await import('@/services/openclaw/task-manager-client');

    const result = await writeTodos({
      sessionKey: 'agent:main:main',
      oldTodos: [{ content: 'done', status: 'pending' }],
      newTodos: [{ content: 'done', status: 'completed' }],
    });

    expect(result.updatedAt).toBe(12);
    expect(result.todos[0]).toMatchObject({ content: 'done', status: 'completed' });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/tasks/todos/write', {
      method: 'POST',
      body: JSON.stringify({
        sessionKey: 'agent:main:main',
        oldTodos: [{ content: 'done', status: 'pending' }],
        newTodos: [{ content: 'done', status: 'completed' }],
      }),
      timeoutMs: 60000,
    });
  });
});
