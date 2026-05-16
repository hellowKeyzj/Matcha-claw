import { describe, expect, it, vi } from 'vitest';
import { taskRoutes } from '../../runtime-host/api/routes/task-routes';
import { GatewayCapabilityService } from '../../runtime-host/application/gateway/gateway-capability-service';
import { TaskManagerService } from '../../runtime-host/application/tasks/service';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

function taskServiceWith(gatewayRpc = vi.fn(async () => ({})), inspectGatewayMethodReadiness = vi.fn(async () => ({
  ready: true,
  methods: ['TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate', 'TodoWrite'],
  missingMethods: [],
})), getWorkspaceDirForSession = vi.fn(async (sessionKey: string) => (
  sessionKey.startsWith('agent:ui-designer:')
    ? 'C:\\Users\\Dev\\.openclaw\\workspace-subagents\\ui-designer'
    : 'C:\\Users\\Dev\\.openclaw\\workspace'
)), emitTaskSnapshot = vi.fn()) {
  return {
    taskService: new TaskManagerService({
      gateway: { gatewayRpc },
      capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness } }),
      clock: { now: () => 1 },
      workspace: { getWorkspaceDirForSession },
      emitTaskSnapshot,
    }),
    gatewayRpc,
    inspectGatewayMethodReadiness,
    getWorkspaceDirForSession,
    emitTaskSnapshot,
  };
}

describe('runtime-host task routes', () => {
  it('routes session task list through TaskList gateway method', async () => {
    const gatewayRpc = vi.fn(async () => ({
      tasks: [{ id: '1', subject: '整理需求' }],
      todos: [],
    }));
    const deps = taskServiceWith(gatewayRpc);

    const response = await dispatchRuntimeRouteDefinition(
      taskRoutes,
      'POST',
      '/api/tasks/list',
      { sessionKey: 'agent:main:main' },
      { taskService: deps.taskService },
    );

    expect(response).toEqual({
      status: 200,
      data: {
        tasks: [{ id: '1', subject: '整理需求' }],
        todos: [],
      },
    });
    expect(gatewayRpc).toHaveBeenCalledWith(
      'TaskList',
      { sessionKey: 'agent:main:main', workspaceDir: 'C:\\Users\\Dev\\.openclaw\\workspace' },
      60000,
    );
    expect(deps.inspectGatewayMethodReadiness).toHaveBeenCalledWith(['TaskList'], 5000);
  });

  it('routes subagent task list to the same workspace used by session tools', async () => {
    const gatewayRpc = vi.fn(async () => ({ tasks: [], todos: [{ content: '分析页面结构', status: 'pending' }] }));
    const deps = taskServiceWith(gatewayRpc);
    const sessionKey = 'agent:ui-designer:session-1';

    await dispatchRuntimeRouteDefinition(
      taskRoutes,
      'POST',
      '/api/tasks/list',
      { sessionKey },
      { taskService: deps.taskService },
    );

    expect(deps.getWorkspaceDirForSession).toHaveBeenCalledWith(sessionKey);
    expect(gatewayRpc).toHaveBeenCalledWith(
      'TaskList',
      {
        sessionKey,
        workspaceDir: 'C:\\Users\\Dev\\.openclaw\\workspace-subagents\\ui-designer',
      },
      60000,
    );
  });

  it('validates required sessionKey and taskId before forwarding', async () => {
    const deps = taskServiceWith();

    await expect(dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/list', {}, { taskService: deps.taskService }))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'sessionKey is required' } });
    await expect(dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/update', { sessionKey: 'agent:main:main' }, { taskService: deps.taskService }))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'taskId is required' } });
    expect(deps.gatewayRpc).not.toHaveBeenCalled();
  });

  it('routes create, update, get and TodoWrite to uppercase gateway methods', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const deps = taskServiceWith(gatewayRpc);

    await dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/create', {
      sessionKey: 'agent:main:main',
      subject: '实现接口',
      description: '接入 TaskCreate',
    }, { taskService: deps.taskService });
    await dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/get', {
      sessionKey: 'agent:main:main',
      taskId: '1',
    }, { taskService: deps.taskService });
    await dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/update', {
      sessionKey: 'agent:main:main',
      taskId: '1',
      status: 'deleted',
    }, { taskService: deps.taskService });
    await dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/todos/write', {
      sessionKey: 'agent:main:main',
      newTodos: [{ content: 'done', status: 'completed' }],
    }, { taskService: deps.taskService });
    await dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/todos/get', {
      sessionKey: 'agent:main:main',
    }, { taskService: deps.taskService });

    // 写方法（TaskCreate / TaskUpdate / TodoWrite）成功后会追加一次 TaskList 推送权威全量。
    expect(gatewayRpc.mock.calls.map((call) => call[0])).toEqual([
      'TaskCreate',
      'TaskList',
      'TaskGet',
      'TaskUpdate',
      'TaskList',
      'TodoWrite',
      'TaskList',
      'TodoGet',
    ]);
    expect(gatewayRpc.mock.calls.map((call) => call[1].workspaceDir)).toEqual(
      Array(8).fill('C:\\Users\\Dev\\.openclaw\\workspace'),
    );
  });

  it('buildTaskSnapshot replays from the session workspace', async () => {
    const gatewayRpc = vi.fn(async () => ({
      tasks: [],
      todos: [{ content: '恢复 todo', status: 'pending' }],
    }));
    const deps = taskServiceWith(gatewayRpc);

    await expect(deps.taskService.buildTaskSnapshot('agent:ui-designer:session-1')).resolves.toMatchObject({
      sessionKey: 'agent:ui-designer:session-1',
      todos: [{ content: '恢复 todo', status: 'pending' }],
      source: 'replay',
    });

    expect(gatewayRpc).toHaveBeenCalledWith(
      'TaskList',
      {
        sessionKey: 'agent:ui-designer:session-1',
        workspaceDir: 'C:\\Users\\Dev\\.openclaw\\workspace-subagents\\ui-designer',
      },
      60000,
    );
  });

  it('TaskUpdate(status=deleted) 完成后基于 TaskList 推送权威全量快照', async () => {
    let listCount = 0;
    const gatewayRpc = vi.fn(async (method: string) => {
      if (method === 'TaskUpdate') {
        return { taskId: '2', deleted: true };
      }
      if (method === 'TaskList') {
        listCount += 1;
        return {
          tasks: [
            { id: '1', subject: '保留', status: 'pending', blocks: [], blockedBy: [] },
            { id: '3', subject: '保留 2', status: 'completed', blocks: [], blockedBy: [] },
          ],
          todos: [],
        };
      }
      return {};
    });
    const deps = taskServiceWith(gatewayRpc);

    await dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/update', {
      sessionKey: 'agent:main:main',
      taskId: '2',
      status: 'deleted',
    }, { taskService: deps.taskService });

    expect(listCount).toBe(1);
    expect(deps.emitTaskSnapshot).toHaveBeenCalledTimes(1);
    const event = deps.emitTaskSnapshot.mock.calls[0][0];
    expect(event.sessionKey).toBe('agent:main:main');
    expect(event.source).toBe('tool');
    expect(event.tasks.map((t: { id: string }) => t.id)).toEqual(['1', '3']);
  });

  it('TaskList 等读方法不会触发权威全量 emit', async () => {
    const gatewayRpc = vi.fn(async () => ({ tasks: [], todos: [] }));
    const deps = taskServiceWith(gatewayRpc);

    await dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/list', {
      sessionKey: 'agent:main:main',
    }, { taskService: deps.taskService });

    expect(deps.emitTaskSnapshot).not.toHaveBeenCalled();
  });

  it('returns background task output and stop results without renderer gateway access', async () => {
    const taskService = {
      output: vi.fn(async () => ({ status: 200, data: { success: true, task: { id: 'job-1' } } })),
      stop: vi.fn(async () => ({ status: 200, data: { success: true, task: { id: 'job-1', status: 'cancelled' } } })),
    } as never;

    await expect(dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/output', {
      taskId: 'job-1',
      wait: true,
    }, { taskService })).resolves.toEqual({
      status: 200,
      data: { success: true, task: { id: 'job-1' } },
    });

    await expect(dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/stop', {
      taskId: 'job-1',
    }, { taskService })).resolves.toEqual({
      status: 200,
      data: { success: true, task: { id: 'job-1', status: 'cancelled' } },
    });
  });

  it('returns structured 503 when required gateway method is absent', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const inspectGatewayMethodReadiness = vi.fn(async () => ({
      ready: false,
      methods: [],
      missingMethods: ['TaskList'],
    }));
    const deps = taskServiceWith(gatewayRpc, inspectGatewayMethodReadiness);

    await expect(dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/list', {
      sessionKey: 'agent:main:main',
    }, { taskService: deps.taskService }))
      .resolves.toEqual({
        status: 503,
        data: {
          success: false,
          code: 'PLUGIN_CAPABILITY_UNAVAILABLE',
          pluginId: 'task-manager',
          missingMethods: ['TaskList'],
          message: 'task-manager plugin is not enabled or did not register required Gateway methods.',
        },
      });
    expect(gatewayRpc).not.toHaveBeenCalled();
  });
});
