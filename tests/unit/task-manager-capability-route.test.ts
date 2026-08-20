import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleCapabilityRoutes } from '../../electron/api/routes/capabilities';

const identity = {
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  agentId: 'main',
  sessionKey: 'session-1',
};
const request = {
  id: 'task.management',
  operationId: 'tasks.list',
  scope: { kind: 'session', identity },
  target: { kind: 'task-manager', identity },
  input: { sessionIdentity: identity },
};

function taskRow(metadata?: Record<string, unknown>) {
  return {
    id: 'task-1',
    subject: 'Task subject',
    description: 'Task description',
    status: 'pending',
    blockedBy: [],
    blocks: [],
    ...(metadata === undefined ? {} : { metadata }),
    createdAt: 1,
    updatedAt: 2,
  };
}

function legacyRequest(method: string, params: Record<string, unknown>) {
  return {
    id: 'tool.invoke',
    operationId: 'tools.invoke',
    scope: { kind: 'session', identity },
    target: { kind: 'tool', toolName: method, identity },
    input: { sessionIdentity: identity, method, params },
  };
}

function incoming(body: unknown) {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

describe('Task Manager capability route', () => {
  it('dispatches task.management only to the dedicated transport', async () => {
    const list = vi.fn().mockResolvedValue({ status: 200, body: { tasks: [], todos: [] } });
    const result = response();

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { taskManagerTransport: { list } } as never,
    );

    expect(list).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({ statusCode: 200, body: { tasks: [], todos: [] } });
  });

  it('rejects unknown task operations before dispatch', async () => {
    const list = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming({ ...request, operationId: 'tools.invoke' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { taskManagerTransport: { list } } as never,
    );

    expect(list).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Task manager request is invalid' },
    });
  });

  it('preserves metadata in legacy TaskList and TaskGet projections', async () => {
    const metadata = { source: 'legacy' };
    const task = taskRow(metadata);
    const list = vi.fn().mockResolvedValue({ status: 200, body: { tasks: [task], todos: [] } });
    const get = vi.fn().mockResolvedValue({ status: 200, body: { task } });
    const listResult = response();
    const getResult = response();

    await handleCapabilityRoutes(
      incoming(legacyRequest('TaskList', { sessionKey: identity.sessionKey })) as never,
      listResult.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { taskManagerTransport: { list } } as never,
    );
    await handleCapabilityRoutes(
      incoming(legacyRequest('TaskGet', { sessionKey: identity.sessionKey, taskId: task.id })) as never,
      getResult.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { taskManagerTransport: { get } } as never,
    );

    expect(listResult.state).toEqual({ statusCode: 200, body: { tasks: [task], todos: [] } });
    expect(getResult.state).toEqual({ statusCode: 200, body: { task } });
  });

  it('forwards empty metadata for legacy TaskCreate', async () => {
    const metadata = {};
    const task = taskRow(metadata);
    const create = vi.fn().mockResolvedValue({
      status: 200,
      body: { outcome: 'applied', task, snapshot: { tasks: [task], todos: [] } },
    });
    const result = response();

    await handleCapabilityRoutes(
      incoming(legacyRequest('TaskCreate', {
        sessionKey: identity.sessionKey,
        subject: task.subject,
        description: task.description,
        metadata,
      })) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { taskManagerTransport: { create } } as never,
    );

    expect(create).toHaveBeenCalledWith({
      id: 'task.management',
      operationId: 'tasks.create',
      scope: { kind: 'session', identity },
      target: { kind: 'task-manager', identity },
      input: {
        sessionIdentity: identity,
        subject: task.subject,
        description: task.description,
        metadata,
      },
    });
    expect(result.state).toEqual({ statusCode: 200, body: { task, todos: [] } });
  });

  it('keeps omitted metadata absent for legacy TaskCreate and TaskUpdate', async () => {
    const task = taskRow();
    const create = vi.fn().mockResolvedValue({
      status: 200,
      body: { outcome: 'applied', task, snapshot: { tasks: [task], todos: [] } },
    });
    const update = vi.fn().mockResolvedValue({
      status: 200,
      body: { outcome: 'applied', snapshot: { tasks: [task], todos: [] } },
    });
    const createResult = response();
    const updateResult = response();

    await handleCapabilityRoutes(
      incoming(legacyRequest('TaskCreate', {
        sessionKey: identity.sessionKey,
        subject: task.subject,
        description: task.description,
      })) as never,
      createResult.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { taskManagerTransport: { create } } as never,
    );
    await handleCapabilityRoutes(
      incoming(legacyRequest('TaskUpdate', {
        sessionKey: identity.sessionKey,
        taskId: task.id,
      })) as never,
      updateResult.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { taskManagerTransport: { update } } as never,
    );

    expect(create).toHaveBeenCalledWith({
      id: 'task.management',
      operationId: 'tasks.create',
      scope: { kind: 'session', identity },
      target: { kind: 'task-manager', identity },
      input: {
        sessionIdentity: identity,
        subject: task.subject,
        description: task.description,
      },
    });
    expect(update).toHaveBeenCalledWith({
      id: 'task.management',
      operationId: 'tasks.update',
      scope: { kind: 'session', identity },
      target: { kind: 'task-manager', identity },
      input: { sessionIdentity: identity, taskId: task.id },
    });
    expect(createResult.state).toEqual({ statusCode: 200, body: { task, todos: [] } });
    expect(updateResult.state).toEqual({ statusCode: 200, body: { task } });
  });

  it('forwards opaque metadata patches for legacy TaskUpdate', async () => {
    const metadata = { nested: { values: ['opaque'] }, removed: null };
    const task = taskRow({ nested: { values: ['opaque'] } });
    const update = vi.fn().mockResolvedValue({
      status: 200,
      body: { outcome: 'applied', snapshot: { tasks: [task], todos: [] } },
    });
    const result = response();

    await handleCapabilityRoutes(
      incoming(legacyRequest('TaskUpdate', {
        sessionKey: identity.sessionKey,
        taskId: task.id,
        metadata,
      })) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { taskManagerTransport: { update } } as never,
    );

    expect(update).toHaveBeenCalledWith({
      id: 'task.management',
      operationId: 'tasks.update',
      scope: { kind: 'session', identity },
      target: { kind: 'task-manager', identity },
      input: { sessionIdentity: identity, taskId: task.id, metadata },
    });
    expect(result.state).toEqual({ statusCode: 200, body: { task } });
  });

  it('maps legacy TodoGet to todos.get and preserves the public snapshot', async () => {
    const todos = [{ content: 'First todo', status: 'pending' }];
    const getTodos = vi.fn().mockResolvedValue({
      status: 200,
      body: { todos, updatedAt: 42 },
    });
    const result = response();

    await handleCapabilityRoutes(
      incoming(legacyRequest('TodoGet', { sessionKey: identity.sessionKey })) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { taskManagerTransport: { getTodos } } as never,
    );

    expect(getTodos).toHaveBeenCalledWith({
      id: 'task.management',
      operationId: 'todos.get',
      scope: { kind: 'session', identity },
      target: { kind: 'task-manager', identity },
      input: { sessionIdentity: identity },
    });
    expect(result.state).toEqual({ statusCode: 200, body: { todos, updatedAt: 42 } });
  });

  it('maps legacy TodoWrite to todos.write without interpreting todo contents', async () => {
    const oldTodos = [{ content: 'Old todo', status: 'pending' }];
    const newTodos = [{ content: 'New todo', status: 'completed' }];
    const writeTodos = vi.fn().mockResolvedValue({
      status: 200,
      body: { outcome: 'applied', snapshot: { todos: newTodos, updatedAt: 43 } },
    });
    const result = response();

    await handleCapabilityRoutes(
      incoming(legacyRequest('TodoWrite', {
        sessionKey: identity.sessionKey,
        oldTodos,
        newTodos,
      })) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { taskManagerTransport: { writeTodos } } as never,
    );

    expect(writeTodos).toHaveBeenCalledWith({
      id: 'task.management',
      operationId: 'todos.write',
      scope: { kind: 'session', identity },
      target: { kind: 'task-manager', identity },
      input: { sessionIdentity: identity, oldTodos, newTodos },
    });
    expect(result.state).toEqual({ statusCode: 200, body: { todos: newTodos, updatedAt: 43 } });
  });

  it.each([null, [], 'metadata', 1, false])(
    'rejects non-object legacy task metadata: %p',
    async (metadata) => {
      const create = vi.fn();
      const result = response();

      await handleCapabilityRoutes(
        incoming(legacyRequest('TaskCreate', {
          sessionKey: identity.sessionKey,
          subject: 'Task subject',
          description: 'Task description',
          metadata,
        })) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/capabilities/execute'),
        { taskManagerTransport: { create } } as never,
      );

      expect(create).not.toHaveBeenCalled();
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Task manager request is invalid' },
      });
    },
  );
});
