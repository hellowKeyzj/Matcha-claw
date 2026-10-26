import { describe, expect, it, vi } from 'vitest';
import { createTaskManagerTransport } from '../../electron/main/runtime-host-delivery/transport/task-manager';
import { createCallLogTransport } from '../../electron/main/runtime-host-delivery/transport/call-log';
import { decodeTaskManagerCallDetail } from '../../src/types/call-log/task-manager';

vi.mock('../../electron/utils/logger', () => ({ logger: { warn: vi.fn() } }));

const identity = {
  endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
  agentId: 'main', sessionKey: 'session-1',
} as const;
const listRequest = {
  id: 'task.management', operationId: 'tasks.list',
  scope: { kind: 'session', identity }, target: { kind: 'task-manager', identity },
  input: { sessionIdentity: identity },
} as const;

describe('Task Manager transport', () => {
  it('signs and forwards the exact list envelope', async () => {
    const signDecision = vi.fn().mockReturnValue('signed');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ tasks: [], todos: [] }) });
    const transport = createTaskManagerTransport({ verificationKey: 'public', signDecision }, 34_138, fetcher);

    await expect(transport.list(listRequest)).resolves.toEqual({ status: 200, body: { tasks: [], todos: [] } });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({ endpoint: '/api/tasks/list', scope: 'tasks:read', capability: 'task.management', subject: 'tasks-list' }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34138/api/tasks/list', expect.objectContaining({ method: 'POST', body: JSON.stringify(listRequest) }));
  });


  it.each([
    { ...listRequest, input: { ...listRequest.input, workspaceDir: 'C:/private' } },
    { ...listRequest, target: { kind: 'task-manager', identity: { ...identity, agentId: 'other' } } },
    { ...listRequest, operationId: 'todos.get' },
  ])('fails closed before signing invalid requests', async (request) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createTaskManagerTransport({ verificationKey: 'public', signDecision }, 34_138, fetcher);
    await expect(transport.list(request)).resolves.toEqual({ status: 503, body: {
      success: false, error: 'The task request parameters are invalid',
      failure: { stage: 'task_request', code: 'invalid_params', delivery: 'notSent' },
    } });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['create', 'tasks.create', { sessionIdentity: identity, subject: 'subject', description: 'description', metadata: { scope: 'private', nested: { values: ['opaque'] }, removed: null } }],
    ['update', 'tasks.update', { sessionIdentity: identity, taskId: 'task-1', metadata: { path: 'C:/private', nested: { values: ['opaque'] }, removed: null } }],
  ] as const)('forwards opaque metadata on public %s requests', async (method, operationId, input) => {
    const signDecision = vi.fn().mockReturnValue('signed');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome: 'unknown' }) });
    const transport = createTaskManagerTransport({ verificationKey: 'public', signDecision }, 34_138, fetcher);
    const request = { id: 'task.management', operationId, scope: { kind: 'session', identity }, target: { kind: 'task-manager', identity }, input };
    await expect(transport[method](request)).resolves.toEqual({ status: 200, body: { outcome: 'unknown' } });
    expect(fetcher).toHaveBeenCalledWith(
      `http://127.0.0.1:34138/api/tasks/${method}`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
    );
  });

  it('keeps absent metadata distinct from an empty object when forwarding create requests', async () => {
    const signDecision = vi.fn().mockReturnValue('signed');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome: 'unknown' }) });
    const transport = createTaskManagerTransport({ verificationKey: 'public', signDecision }, 34_138, fetcher);
    const withoutMetadata = { id: 'task.management', operationId: 'tasks.create', scope: { kind: 'session', identity }, target: { kind: 'task-manager', identity }, input: { sessionIdentity: identity, subject: 'subject', description: 'description' } };
    const withEmptyMetadata = { ...withoutMetadata, input: { ...withoutMetadata.input, metadata: {} } };

    await transport.create(withoutMetadata);
    await transport.create(withEmptyMetadata);

    expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ body: JSON.stringify(withoutMetadata) }));
    expect(fetcher.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ body: JSON.stringify(withEmptyMetadata) }));
  });

  it.each([
    ['create', 'tasks.create', { sessionIdentity: identity, subject: 'subject', description: 'description', metadata: null }],
    ['create', 'tasks.create', { sessionIdentity: identity, subject: 'subject', description: 'description', metadata: [] }],
    ['update', 'tasks.update', { sessionIdentity: identity, taskId: 'task-1', metadata: null }],
    ['update', 'tasks.update', { sessionIdentity: identity, taskId: 'task-1', metadata: [] }],
  ] as const)('rejects null and array metadata before signing for %s', async (method, operationId, input) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createTaskManagerTransport({ verificationKey: 'public', signDecision }, 34_138, fetcher);
    const request = { id: 'task.management', operationId, scope: { kind: 'session', identity }, target: { kind: 'task-manager', identity }, input };
    await expect(transport[method](request)).resolves.toEqual({ status: 503, body: {
      success: false, error: 'The task request parameters are invalid',
      failure: { stage: 'task_request', code: 'invalid_params', delivery: 'notSent' },
    } });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unrelated fields even when create metadata is valid', async () => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createTaskManagerTransport({ verificationKey: 'public', signDecision }, 34_138, fetcher);
    const request = {
      id: 'task.management', operationId: 'tasks.create',
      scope: { kind: 'session', identity }, target: { kind: 'task-manager', identity },
      input: { sessionIdentity: identity, subject: 'subject', description: 'description', metadata: {}, workspaceDir: 'C:/private' },
    };

    await expect(transport.create(request)).resolves.toEqual({ status: 503, body: {
      success: false, error: 'The task request parameters are invalid',
      failure: { stage: 'task_request', code: 'invalid_params', delivery: 'notSent' },
    } });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('forwards state-only TodoWrite and keeps rejected and unknown outcomes closed', async () => {
    const request = {
      id: 'task.management', operationId: 'todos.write',
      scope: { kind: 'session', identity }, target: { kind: 'task-manager', identity },
      input: {
        sessionIdentity: identity,
        oldTodos: [],
        newTodos: [{ content: 'todo', status: 'pending' }],
      },
    } as const;

    for (const outcome of ['rejected', 'unknown'] as const) {
      const signDecision = vi.fn().mockReturnValue('signed');
      const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome }) });
      const transport = createTaskManagerTransport({ verificationKey: 'public', signDecision }, 34_138, fetcher);
      await expect(transport.writeTodos(request)).resolves.toEqual({ status: 200, body: { outcome } });
      expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
        endpoint: '/api/tasks/todos/write', scope: 'tasks:write', capability: 'task.management', subject: 'todos-write',
      }));
      expect(fetcher).toHaveBeenCalledWith(
        'http://127.0.0.1:34138/api/tasks/todos/write',
        expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
      );
    }
  });

  it('rejects Todo public requests that carry task or private scope fields before signing', async () => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createTaskManagerTransport({ verificationKey: 'public', signDecision }, 34_138, fetcher);
    const request = {
      id: 'task.management', operationId: 'todos.get',
      scope: { kind: 'session', identity }, target: { kind: 'task-manager', identity },
      input: { sessionIdentity: identity, teamKey: 'forbidden', workspaceDir: 'C:/private' },
    };

    await expect(transport.getTodos(request)).resolves.toEqual({ status: 503, body: {
      success: false, error: 'The task request parameters are invalid',
      failure: { stage: 'task_request', code: 'invalid_params', delivery: 'notSent' },
    } });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves metadata in create responses while keeping empty and absent metadata distinct', async () => {
    const signDecision = vi.fn().mockReturnValue('signed');
    const metadata = { scope: 'private', nested: { values: ['opaque'] }, removed: null };
    const taskWithMetadata = { id: 'task-2', subject: 'subject', description: 'description', status: 'pending', blockedBy: [], blocks: [], metadata, createdAt: 1, updatedAt: 2 };
    const taskWithEmptyMetadata = { id: 'task-3', subject: 'subject', description: 'description', status: 'pending', blockedBy: [], blocks: [], metadata: {}, createdAt: 1, updatedAt: 2 };
    const taskWithoutMetadata = { id: 'task-1', subject: 'subject', description: 'description', status: 'pending', blockedBy: [], blocks: [], createdAt: 1, updatedAt: 2 };
    const response = { outcome: 'applied', task: taskWithMetadata, snapshot: { tasks: [taskWithMetadata, taskWithEmptyMetadata, taskWithoutMetadata], todos: [] } };
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => response });
    const transport = createTaskManagerTransport({ verificationKey: 'public', signDecision }, 34_138, fetcher);
    const request = { id: 'task.management', operationId: 'tasks.create', scope: { kind: 'session', identity }, target: { kind: 'task-manager', identity }, input: { sessionIdentity: identity, subject: 'subject', description: 'description' } };

    await expect(transport.create(request)).resolves.toEqual({ status: 200, body: response });
  });

  it.each([
    { id: 'task-1', subject: 'subject', description: 'description', status: 'pending', blockedBy: [], blocks: [], metadata: null, createdAt: 1, updatedAt: 2 },
    { id: 'task-1', subject: 'subject', description: 'description', status: 'pending', blockedBy: [], blocks: [], metadata: [], createdAt: 1, updatedAt: 2 },
  ])('rejects task responses with non-object metadata: %j', async (task) => {
    const signDecision = vi.fn().mockReturnValue('signed');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ tasks: [task], todos: [] }),
    });
    const transport = createTaskManagerTransport({ verificationKey: 'public', signDecision }, 34_138, fetcher);
    await expect(transport.list(listRequest)).resolves.toEqual({ status: 503, body: {
      success: false, error: 'The task response format is invalid',
      failure: { stage: 'response', code: 'protocol', delivery: 'responseReceived' },
    } });
  });

  it('redacts loopback failure details', async () => {
    const transport = createTaskManagerTransport({ verificationKey: 'public', signDecision: () => 'signed' }, 34_138, vi.fn().mockRejectedValue(new Error('private loopback detail')));
    await expect(transport.list(listRequest)).resolves.toEqual({ status: 503, body: {
      success: false, error: 'Task request delivery could not be confirmed',
      failure: { stage: 'transport', code: 'transport', delivery: 'unknown' },
    } });
  });
});

describe('Task Manager call details', () => {
  const detail = {
    agentRef: 'main', sessionRef: 'session-1', teamRef: null, taskRef: null,
    requestedStatus: null, taskStatus: null, taskCount: null, todoCount: null,
    mutation: null, read: 'unavailable', failure: 'unavailable', diagnostic: null,
    runtimeAdapterId: 'matcha-agent', runtimeInstanceId: 'local',
  } as const;
  const callId = '0123456789abcdef0123456789abcdef';

  it.each([
    null,
    { stage: 'runtime', code: 'runtime_not_ready' },
    { stage: 'response', code: 'remote_error', rpcCode: -32603 },
    { stage: 'native_start', code: 'native_start_failed', delivery: 'notSent' },
    { stage: 'task_request', code: 'remote_error', rpcCode: -32603, delivery: 'responseReceived' },
  ] as const)('accepts current Rust details in Calls list, get and history: %j', async (diagnostic) => {
    const call = { callId, module: 'task-manager', command: 'tasks.list', status: 'failed',
      start: 1, end: 2, revision: 4, detail: { ...detail, diagnostic } };
    const page = { items: [call], next: null };
    const history = { items: [{ revision: 4, status: 'failed', at: 2, detail: call.detail }], next: null };
    const responses = new Map<string, unknown>([
      ['http://127.0.0.1:34138/api/calls/list', page],
      ['http://127.0.0.1:34138/api/calls/get', call],
      ['http://127.0.0.1:34138/api/calls/history', history],
    ]);
    const fetcher = vi.fn().mockImplementation(async (url: string) => ({ status: 200, json: async () => responses.get(url) }));
    const transport = createCallLogTransport({ verificationKey: 'public', signDecision: () => 'signed' }, 34_138, fetcher);

    await expect(transport.list({ limit: 50 })).resolves.toEqual({ status: 200, body: page });
    await expect(transport.get({ callId })).resolves.toEqual({ status: 200, body: call });
    await expect(transport.history({ callId, limit: 50 })).resolves.toEqual({ status: 200, body: history });
  });

  it.each(Object.keys(detail))('requires the serialized nullable field %s', (key) => {
    const missing = Object.fromEntries(Object.entries(detail).filter(([field]) => field !== key));
    expect(decodeTaskManagerCallDetail(missing)).toBeNull();
  });

  it.each(['runtimeAdapterId', 'runtimeInstanceId'])('validates %s with the producer safe-reference grammar', (key) => {
    for (const value of [null, 'a'.repeat(128), 'A0._:-']) {
      const input = { ...detail, [key]: value };
      expect(decodeTaskManagerCallDetail(input)).toEqual(input);
    }
    for (const value of ['', 'a'.repeat(129), 'C:/private', '../private', '运行时', 'local\n', 1, undefined]) {
      expect(decodeTaskManagerCallDetail({ ...detail, [key]: value })).toBeNull();
    }
  });

  it.each([
    { diagnostic: undefined },
    { diagnostic: 'runtime_not_ready' },
    { diagnostic: [] },
    { diagnostic: {} },
    { diagnostic: { stage: 'unknown', code: 'protocol' } },
    { diagnostic: { stage: 'response', code: 'unknown' } },
    { diagnostic: { stage: 'response', code: 'protocol', rpcCode: null } },
    { diagnostic: { stage: 'response', code: 'protocol', rpcCode: '503' } },
    { diagnostic: { stage: 'response', code: 'protocol', rpcCode: 1.5 } },
    { diagnostic: { stage: 'response', code: 'protocol', rpcCode: Number.MAX_SAFE_INTEGER + 1 } },
    { diagnostic: { stage: 'response', code: 'protocol', delivery: null } },
    { diagnostic: { stage: 'response', code: 'protocol', delivery: 'delivered' } },
    { diagnostic: { stage: 'response', code: 'protocol', message: 'private error' } },
    { diagnostic: { stage: 'response', code: 'protocol', path: 'C:/private' } },
    { diagnostic: { stage: 'response', code: 'protocol', token: 'private token' } },
    { runtimeAdapterId: 'matcha-agent', privatePath: 'C:/private' },
    { unknown: true },
    { agentRef: '' },
    { sessionRef: 'C:/private' },
    { teamRef: 'team\n' },
    { taskRef: 1 },
    { requestedStatus: 'unknown' },
    { taskStatus: 'done' },
    { taskCount: -1 },
    { taskCount: Number.MAX_SAFE_INTEGER + 1 },
    { todoCount: 0.5 },
    { mutation: 'done', read: null },
    { read: 'missing' },
    { failure: 'runtime_not_ready' },
    { mutation: 'applied', read: 'found' },
  ])('rejects malformed or private detail fields without weakening the original contract: %j', (fields) => {
    expect(decodeTaskManagerCallDetail({ ...detail, ...fields })).toBeNull();
  });

  it('keeps malformed diagnostics as a fixed 502 rather than exposing their contents', async () => {
    const call = { callId, module: 'task-manager', command: 'tasks.list', status: 'failed',
      start: 1, end: 2, revision: 4, detail: { ...detail, diagnostic: { stage: 'runtime', code: 'runtime_not_ready', message: 'private error' } } };
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => call });
    const transport = createCallLogTransport({ verificationKey: 'public', signDecision: () => 'signed' }, 34_138, fetcher);

    await expect(transport.get({ callId })).resolves.toEqual({ status: 502, body: { success: false, error: 'Call log response is invalid' } });
  });
});
