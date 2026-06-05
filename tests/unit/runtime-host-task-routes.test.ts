import { describe, expect, it, vi } from 'vitest';
import { GatewayCapabilityService } from '../../runtime-host/application/gateway/gateway-capability-service';
import { TaskManagerService } from '../../runtime-host/application/tasks/service';
import { TaskOperationsWorkflow } from '../../runtime-host/application/workflows/task-runtime/task-operations-workflow';
import { TaskRuntimeWorkflow } from '../../runtime-host/application/workflows/task-runtime/task-runtime-workflow';
import { createTaskControlCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/task/task-control-capability';
import { createToolInvokeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/tool/tool-invoke-capability';
import type { CapabilityOperationContext } from '../../runtime-host/application/capabilities/contracts/capability-router';
import { createOpenClawTestRuntimeAddress } from './helpers/runtime-address-fixtures';

function taskServiceWith(gatewayRpc = vi.fn(async () => ({})), inspectGatewayMethodReadiness = vi.fn(async () => ({
  ready: true,
  methods: ['TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate', 'TodoWrite', 'TodoGet'],
  missingMethods: [],
})), getWorkspaceDirForSession = vi.fn(async (sessionKey: string) => (
  sessionKey.startsWith('agent:ui-designer:')
    ? 'C:\\Users\\Dev\\.openclaw\\workspace-subagents\\ui-designer'
    : 'C:\\Users\\Dev\\.openclaw\\workspace'
)), emitTaskSnapshot = vi.fn()) {
  const runtimeWorkflow = new TaskRuntimeWorkflow({
    gateway: { gatewayRpc },
    capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness } }),
    workspace: { getWorkspaceDirForSession },
    emitTaskSnapshot,
  });
  return {
    taskService: new TaskManagerService(new TaskOperationsWorkflow({
      runtimeWorkflow,
    })),
    gatewayRpc,
    inspectGatewayMethodReadiness,
    getWorkspaceDirForSession,
    emitTaskSnapshot,
  };
}

function toolInvokeRoute(taskService: TaskManagerService) {
  return createToolInvokeCapabilityOperationRoutes({ taskService })[0]!;
}

function taskControlRoutes(taskService: TaskManagerService) {
  return createTaskControlCapabilityOperationRoutes({ taskService });
}

function capabilityContext(
  capabilityId: string,
  operationId: string,
  input: Record<string, unknown>,
): CapabilityOperationContext {
  const sessionKey = typeof input.params === 'object' && input.params && 'sessionKey' in input.params
    ? String((input.params as { sessionKey?: unknown }).sessionKey)
    : 'agent:main:main';
  const address = createOpenClawTestRuntimeAddress(sessionKey);
  return {
    capabilityId,
    operationId,
    address: { ...address, capabilityId },
    input: { ...input, runtimeAddress: { ...address, capabilityId } },
    domainInput: input,
  };
}

function toolInvokeContext(input: Record<string, unknown>): CapabilityOperationContext {
  return capabilityContext('tool.invoke', 'tools.invoke', input);
}

describe('runtime-host task routes', () => {

  it('routes session task list through tool.invoke capability operation', async () => {
    const gatewayRpc = vi.fn(async () => ({
      tasks: [{ id: '1', subject: '整理需求' }],
      todos: [],
    }));
    const deps = taskServiceWith(gatewayRpc);

    await expect(toolInvokeRoute(deps.taskService).handle(toolInvokeContext({
      method: 'TaskList',
      params: { sessionKey: 'agent:main:main' },
    }))).resolves.toEqual({
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

    await toolInvokeRoute(deps.taskService).handle(toolInvokeContext({
      method: 'TaskList',
      params: { sessionKey },
    }));

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

  it('validates required sessionKey and taskId before forwarding through capability operation', async () => {
    const deps = taskServiceWith();
    const route = toolInvokeRoute(deps.taskService);

    await expect(route.handle(toolInvokeContext({ method: 'TaskList', params: {} })))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'sessionKey is required' } });
    await expect(route.handle(toolInvokeContext({ method: 'TaskUpdate', params: { sessionKey: 'agent:main:main' } })))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'taskId is required' } });
    expect(deps.gatewayRpc).not.toHaveBeenCalled();
  });

  it('routes create, update, get and TodoWrite to uppercase gateway methods through capability operation', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const deps = taskServiceWith(gatewayRpc);
    const route = toolInvokeRoute(deps.taskService);

    await route.handle(toolInvokeContext({
      method: 'TaskCreate',
      params: {
        sessionKey: 'agent:main:main',
        subject: '实现接口',
        description: '接入 TaskCreate',
      },
    }));
    await route.handle(toolInvokeContext({
      method: 'TaskGet',
      params: {
        sessionKey: 'agent:main:main',
        taskId: '1',
      },
    }));
    await route.handle(toolInvokeContext({
      method: 'TaskUpdate',
      params: {
        sessionKey: 'agent:main:main',
        taskId: '1',
        status: 'deleted',
        addBlockedBy: ['0'],
        addBlocks: ['2'],
      },
    }));
    await route.handle(toolInvokeContext({
      method: 'TodoWrite',
      params: {
        sessionKey: 'agent:main:main',
        oldTodos: [],
        newTodos: [{ content: 'done', status: 'completed' }],
      },
    }));
    await route.handle(toolInvokeContext({
      method: 'TodoGet',
      params: { sessionKey: 'agent:main:main' },
    }));

    expect(gatewayRpc.mock.calls.map((call) => call[0])).toEqual([
      'TaskCreate',
      'TaskList',
      'TaskGet',
      'TaskUpdate',
      'TaskList',
      'TodoWrite',
      'TodoGet',
    ]);
    expect(gatewayRpc.mock.calls[3][1]).toMatchObject({
      addBlockedBy: ['0'],
      addBlocks: ['2'],
    });
    expect(gatewayRpc.mock.calls.map((call) => call[1].workspaceDir)).toEqual(
      Array(7).fill('C:\\Users\\Dev\\.openclaw\\workspace'),
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

    await toolInvokeRoute(deps.taskService).handle(toolInvokeContext({
      method: 'TaskUpdate',
      params: {
        sessionKey: 'agent:main:main',
        taskId: '2',
        status: 'deleted',
      },
    }));

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

    await toolInvokeRoute(deps.taskService).handle(toolInvokeContext({
      method: 'TaskList',
      params: { sessionKey: 'agent:main:main' },
    }));

    expect(deps.emitTaskSnapshot).not.toHaveBeenCalled();
  });

  it('returns background task output and stop results through task.control capability operation', async () => {
    const taskService = {
      output: vi.fn(async () => ({ status: 200, data: { success: true, task: { id: 'job-1' } } })),
      stop: vi.fn(async () => ({ status: 200, data: { success: true, task: { id: 'job-1', status: 'cancelled' } } })),
    } as never;
    const [outputRoute, stopRoute] = taskControlRoutes(taskService);

    await expect(outputRoute.handle(capabilityContext('task.control', 'tasks.output', {
      taskId: 'job-1',
      wait: true,
    }))).resolves.toEqual({
      status: 200,
      data: { success: true, task: { id: 'job-1' } },
    });

    await expect(stopRoute.handle(capabilityContext('task.control', 'tasks.stop', {
      taskId: 'job-1',
    }))).resolves.toEqual({
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

    await expect(toolInvokeRoute(deps.taskService).handle(toolInvokeContext({
      method: 'TaskList',
      params: { sessionKey: 'agent:main:main' },
    }))).resolves.toEqual({
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
