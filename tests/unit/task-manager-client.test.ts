import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();
vi.mock('@/lib/host-api', () => ({ hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args) }));

function expectTaskRequest(payload: unknown, timeoutMs = 60_000) {
  expect(hostApiFetchMock).toHaveBeenCalledWith('/api/capabilities/execute', { method: 'POST', body: JSON.stringify(payload), timeoutMs });
}

describe('task manager client', () => {
  beforeEach(() => hostApiFetchMock.mockReset());

  it('lists through task.management without legacy tool invocation', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ tasks: [{ id: '1', subject: 'task', status: 'pending', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 1 }], todos: [] });
    const { listTaskSnapshot } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = { endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'main', sessionKey: 'agent:main:main' };
    await expect(listTaskSnapshot({ sessionKey: 'agent:main:main', sessionIdentity })).resolves.toMatchObject({ tasks: [{ id: '1' }], todos: [] });
    expectTaskRequest({ id: 'task.management', operationId: 'tasks.list', scope: { kind: 'session', identity: sessionIdentity }, target: { kind: 'task-manager', identity: sessionIdentity }, input: { sessionIdentity } });
  });

  it('creates through task.management with an authoritative snapshot', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      outcome: 'applied',
      task: { id: '2', subject: 'implement', description: 'deliver the change', status: 'pending', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 1 },
      snapshot: { tasks: [{ id: '2', subject: 'implement', description: 'deliver the change', status: 'pending', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 1 }], todos: [] },
    });
    const { createTask } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = { endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'main', sessionKey: 'agent:main:main' };
    await expect(createTask({ sessionKey: 'agent:main:main', sessionIdentity, subject: 'implement', description: 'deliver the change' })).resolves.toMatchObject({
      outcome: 'applied',
      snapshot: { tasks: [{ id: '2' }], todos: [] },
    });
    expectTaskRequest({ id: 'task.management', operationId: 'tasks.create', scope: { kind: 'session', identity: sessionIdentity }, target: { kind: 'task-manager', identity: sessionIdentity }, input: { sessionIdentity, subject: 'implement', description: 'deliver the change' } });
  });

  it.each(['rejected', 'unknown'] as const)('preserves a %s native create outcome without a fabricated snapshot', async (outcome) => {
    hostApiFetchMock.mockResolvedValueOnce({ outcome });
    const { createTask } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = { endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'main', sessionKey: 'agent:main:main' };
    await expect(createTask({ sessionKey: 'agent:main:main', sessionIdentity, subject: 'implement', description: 'deliver the change' })).resolves.toEqual({ outcome });
  });

  it('preserves an applied update snapshot without metadata', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ outcome: 'applied', snapshot: { tasks: [{ id: '2', subject: 'implement', description: '', status: 'completed', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 2 }], todos: [] } });
    const { updateTask } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = { endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'main', sessionKey: 'agent:main:main' };
    await expect(updateTask({ sessionKey: 'agent:main:main', sessionIdentity, taskId: '2', status: 'completed' })).resolves.toEqual({ outcome: 'applied', snapshot: { tasks: [{ id: '2', subject: 'implement', description: '', status: 'completed', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 2 }], todos: [] } });
    expectTaskRequest({ id: 'task.management', operationId: 'tasks.update', scope: { kind: 'session', identity: sessionIdentity }, target: { kind: 'task-manager', identity: sessionIdentity }, input: { sessionIdentity, taskId: '2', status: 'completed' } });
  });

  it.each(['rejected', 'unknown'] as const)('preserves a %s native update outcome without a fabricated snapshot', async (outcome) => {
    hostApiFetchMock.mockResolvedValueOnce({ outcome });
    const { updateTask } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = { endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'main', sessionKey: 'agent:main:main' };
    await expect(updateTask({ sessionKey: 'agent:main:main', sessionIdentity, taskId: '2', status: 'completed' })).resolves.toEqual({ outcome });
  });

  it('rejects a session key that disagrees with the complete identity before network dispatch', async () => {
    const { updateTask } = await import('@/services/openclaw/task-manager-client');
    const sessionIdentity = { endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'main', sessionKey: 'agent:main:main' };
    await expect(updateTask({ sessionKey: 'other', sessionIdentity, taskId: '2', status: 'completed' })).rejects.toThrow('Task manager session identity is invalid');
    expect(hostApiFetchMock).not.toHaveBeenCalled();
  });

  it('keeps historical task helpers out of the renderer client without a current caller', async () => {
    const client = await import('@/services/openclaw/task-manager-client') as Record<string, unknown>;
    expect(client).toEqual(expect.objectContaining({
      listTaskSnapshot: expect.any(Function),
      createTask: expect.any(Function),
      updateTask: expect.any(Function),
    }));
    expect(client.getTask).toBeUndefined();
    expect(client.writeTodos).toBeUndefined();
    expect(client.getTodos).toBeUndefined();
    expect(client.getTaskOutput).toBeUndefined();
    expect(client.stopTask).toBeUndefined();
  });
});
