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
const listRequest = {
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
      incoming(listRequest) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { runtimeHostTransports: { taskManagerTransport: { list } } } as never,
    );

    expect(list).toHaveBeenCalledWith(listRequest);
    expect(result.state).toEqual({ statusCode: 200, body: { tasks: [], todos: [] } });
  });

  it('rejects unknown task operations before dispatch', async () => {
    const list = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming({ ...listRequest, operationId: 'tools.invoke' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { runtimeHostTransports: { taskManagerTransport: { list } } } as never,
    );

    expect(list).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Task manager request is invalid' },
    });
  });

  it('forwards direct task.management metadata without legacy tool invocation', async () => {
    const metadata = { source: 'direct' };
    const task = taskRow(metadata);
    const create = vi.fn().mockResolvedValue({
      status: 200,
      body: { outcome: 'applied', task, snapshot: { tasks: [task], todos: [] } },
    });
    const result = response();
    const request = {
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
    };

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { runtimeHostTransports: { taskManagerTransport: { create } } } as never,
    );

    expect(create).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({
      statusCode: 200,
      body: { outcome: 'applied', task, snapshot: { tasks: [task], todos: [] } },
    });
  });

  it('does not expose legacy tool.invoke for task-manager products', async () => {
    const list = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming({
        id: 'tool.invoke',
        operationId: 'tools.invoke',
        scope: { kind: 'session', identity },
        target: { kind: 'tool', toolName: 'TaskList', identity },
        input: { sessionIdentity: identity, method: 'TaskList', params: { sessionKey: identity.sessionKey } },
      }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { runtimeHostTransports: { taskManagerTransport: { list } } } as never,
    );

    expect(list).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
  });
});
