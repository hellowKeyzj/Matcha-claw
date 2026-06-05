import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenClawTestRuntimeAddress } from './helpers/runtime-address-fixtures';

const hostCapabilityExecuteMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
  hostCapabilityExecute: (...args: unknown[]) => hostCapabilityExecuteMock(...args),
}));

describe('task manager client', () => {
  beforeEach(() => {
    hostCapabilityExecuteMock.mockReset();
  });

  it('listTaskSnapshot reads session scoped tasks and todos through tool.invoke capability', async () => {
    hostCapabilityExecuteMock.mockResolvedValueOnce({
      tasks: [
        { id: '1', subject: '整理需求', status: 'in_progress', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 2 },
      ],
      todos: [
        { content: '同步方案', status: 'pending' },
      ],
    });
    const { listTaskSnapshot } = await import('@/services/openclaw/task-manager-client');
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');

    const snapshot = await listTaskSnapshot({ sessionKey: 'agent:main:main', runtimeAddress });

    expect(snapshot.tasks[0]).toMatchObject({
      id: '1',
      subject: '整理需求',
      status: 'in_progress',
    });
    expect(snapshot.todos).toEqual([{ content: '同步方案', status: 'pending' }]);
    expect(hostCapabilityExecuteMock).toHaveBeenCalledWith({
      id: 'tool.invoke',
      operationId: 'tools.invoke',
      runtimeAddress: { ...runtimeAddress, capabilityId: 'tool.invoke' },
      input: {
        runtimeAddress: { ...runtimeAddress, capabilityId: 'tool.invoke' },
        method: 'TaskList',
        params: { sessionKey: 'agent:main:main' },
      },
    }, { timeoutMs: 60000 });
  });

  it('createTask posts task fields through tool.invoke capability', async () => {
    hostCapabilityExecuteMock.mockResolvedValueOnce({
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
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');

    const result = await createTask({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      subject: '实现接口',
      description: '接 TaskCreate',
      activeForm: 'Implementing task API',
      metadata: { source: 'test' },
    });

    expect(result.task.id).toBe('2');
    expect(result.todos).toHaveLength(1);
    expect(hostCapabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'tool.invoke',
      operationId: 'tools.invoke',
      input: expect.objectContaining({
        method: 'TaskCreate',
        params: {
          sessionKey: 'agent:main:main',
          subject: '实现接口',
          description: '接 TaskCreate',
          activeForm: 'Implementing task API',
          metadata: { source: 'test' },
        },
      }),
    }), { timeoutMs: 60000 });
  });

  it('updateTask supports deleted result through tool.invoke capability', async () => {
    hostCapabilityExecuteMock.mockResolvedValueOnce({
      taskId: '3',
      deleted: true,
      todos: [],
    });
    const { updateTask } = await import('@/services/openclaw/task-manager-client');
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');

    const result = await updateTask({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      taskId: '3',
      status: 'deleted',
    });

    expect(result).toEqual({ taskId: '3', deleted: true, todos: [] });
    expect(hostCapabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        method: 'TaskUpdate',
        params: { sessionKey: 'agent:main:main', taskId: '3', status: 'deleted' },
      }),
    }), { timeoutMs: 60000 });
  });

  it('updateTask forwards dependency fields through tool.invoke capability', async () => {
    hostCapabilityExecuteMock.mockResolvedValueOnce({
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
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');

    const result = await updateTask({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      taskId: '3',
      addBlockedBy: ['1'],
      addBlocks: ['4'],
    });

    expect(result.task).toMatchObject({ id: '3', blockedBy: ['1'], blocks: ['4'] });
    expect(hostCapabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        method: 'TaskUpdate',
        params: { sessionKey: 'agent:main:main', taskId: '3', addBlockedBy: ['1'], addBlocks: ['4'] },
      }),
    }), { timeoutMs: 60000 });
  });

  it('writeTodos posts oldTodos and newTodos through tool.invoke capability', async () => {
    hostCapabilityExecuteMock.mockResolvedValueOnce({
      todos: [{ content: 'done', status: 'completed' }],
      updatedAt: 12,
    });
    const { writeTodos } = await import('@/services/openclaw/task-manager-client');
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');

    const result = await writeTodos({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      oldTodos: [],
      newTodos: [{ content: 'done', status: 'completed' }],
    });

    expect(result.updatedAt).toBe(12);
    expect(result.todos[0]).toMatchObject({ content: 'done', status: 'completed' });
    expect(hostCapabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        method: 'TodoWrite',
        params: {
          sessionKey: 'agent:main:main',
          oldTodos: [],
          newTodos: [{ content: 'done', status: 'completed' }],
        },
      }),
    }), { timeoutMs: 60000 });
  });
});
