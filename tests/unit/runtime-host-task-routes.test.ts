import { describe, expect, it, vi } from 'vitest';
import { taskRoutes } from '../../runtime-host/api/routes/task-routes';
import { GatewayCapabilityService } from '../../runtime-host/application/gateway/gateway-capability-service';
import { TaskManagerService } from '../../runtime-host/application/tasks/service';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';
import type { RuntimeClockPort } from '../../runtime-host/application/common/runtime-ports';

function clock(nowMs: number): RuntimeClockPort {
  return {
    nowMs: () => nowMs,
    nowIso: () => new Date(nowMs).toISOString(),
    toIsoString: (ms) => new Date(ms).toISOString(),
  };
}

describe('runtime-host task routes', () => {
  it('routes task list through TaskManagerService and gateway task_manager.list', async () => {
    const gatewayRpc = vi.fn(async () => ({
      tasks: [{ id: 'task-1', subject: '整理需求' }],
    }));
    const inspectGatewayMethodReadiness = vi.fn(async () => ({
      ready: true,
      methods: ['task_manager.list'],
      missingMethods: [],
    }));
    const taskService = new TaskManagerService({
      gateway: { gatewayRpc },
      capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness } }),
      clock: clock(1000),
    });

    const response = await dispatchRuntimeRouteDefinition(
      taskRoutes,
      'POST',
      '/api/tasks/list',
      { workspaceDir: 'E:/workspace/main' },
      { taskService },
    );

    expect(response).toEqual({
      status: 200,
      data: {
        success: true,
        tasks: [],
        ready: false,
        refreshing: true,
        updatedAt: null,
        error: null,
      },
    });
    expect(gatewayRpc).toHaveBeenCalledWith(
      'task_manager.list',
      { workspaceDir: 'E:/workspace/main' },
      60000,
    );
    expect(inspectGatewayMethodReadiness).toHaveBeenCalledWith(['task_manager.list'], 5000);
  });

  it('validates task id before update and claim', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const inspectGatewayMethodReadiness = vi.fn(async () => ({
      ready: true,
      methods: ['task_manager.update'],
      missingMethods: [],
    }));
    const taskService = new TaskManagerService({
      gateway: { gatewayRpc },
      capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness } }),
      clock: clock(1000),
    });

    await expect(dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/update', {}, { taskService }))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'taskId is required' } });
    await expect(dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/claim', {}, { taskService }))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'taskId is required' } });
    expect(gatewayRpc).not.toHaveBeenCalled();
    expect(inspectGatewayMethodReadiness).not.toHaveBeenCalled();
  });

  it('returns structured 503 when task-manager gateway method is absent', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const inspectGatewayMethodReadiness = vi.fn(async () => ({
      ready: false,
      methods: ['task_manager.list'],
      missingMethods: ['task_manager.list'],
    }));
    const taskService = new TaskManagerService({
      gateway: { gatewayRpc },
      capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness } }),
      clock: clock(1000),
    });

    await expect(dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/list', {}, { taskService }))
      .resolves.toEqual({
        status: 503,
        data: {
          success: false,
          code: 'PLUGIN_CAPABILITY_UNAVAILABLE',
          pluginId: 'task-manager',
          missingMethods: ['task_manager.list'],
          message: 'task-manager plugin is not enabled or did not register required Gateway methods.',
        },
      });
    expect(gatewayRpc).not.toHaveBeenCalled();
  });

  it('task list cold start uses one background gateway rpc for concurrent reads', async () => {
    let resolveGatewayRpc: ((value: unknown) => void) | null = null;
    const gatewayRpc = vi.fn(() => new Promise<unknown>((resolve) => {
      resolveGatewayRpc = resolve;
    }));
    const inspectGatewayMethodReadiness = vi.fn(async () => ({
      ready: true,
      methods: ['task_manager.list'],
      missingMethods: [],
    }));
    const taskService = new TaskManagerService({
      gateway: { gatewayRpc },
      capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness } }),
      clock: clock(2000),
    });

    const first = await dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/list', {}, { taskService });
    const second = await dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/list', {}, { taskService });

    expect(first).toEqual({
      status: 200,
      data: {
        success: true,
        tasks: [],
        ready: false,
        refreshing: true,
        updatedAt: null,
        error: null,
      },
    });
    expect(second).toEqual(first);
    expect(gatewayRpc).toHaveBeenCalledTimes(1);

    resolveGatewayRpc?.({ tasks: [{ id: 'task-1', subject: '整理需求' }] });
    await Promise.resolve();

    await expect(dispatchRuntimeRouteDefinition(taskRoutes, 'POST', '/api/tasks/list', {}, { taskService }))
      .resolves.toEqual({
        status: 200,
        data: {
          success: true,
          tasks: [{ id: 'task-1', subject: '整理需求' }],
          ready: true,
          refreshing: true,
          updatedAt: 2000,
          error: null,
        },
      });
  });
});
