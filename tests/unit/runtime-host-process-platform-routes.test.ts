import { describe, expect, it, vi } from 'vitest';
import { platformRoutes } from '../../runtime-host/api/routes/platform-routes';
import { PlatformService } from '../../runtime-host/application/platform-runtime/service';
import { PlatformRuntimeOperationsWorkflow } from '../../runtime-host/application/workflows/platform-runtime/platform-runtime-operations-workflow';
import { PlatformToolRuntimeWorkflow } from '../../runtime-host/application/workflows/platform-runtime/platform-tool-runtime-workflow';
import { createPlatformRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/platform/platform-runtime-capability';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

function createDeps() {
  const platformRuntime = {
      runtimeHealth: vi.fn(async () => ({ status: 'running' })),
      installNativeTool: vi.fn(async () => 'tool-native-1'),
      reconcileNativeTools: vi.fn(async () => ({ discovered: [], missing: [], conflicts: [] })),
      startRun: vi.fn(async () => 'run-1'),
      abortRun: vi.fn(async () => undefined),
      listEffectiveTools: vi.fn(async () => [{ id: 'tool.echo', source: 'platform', enabled: true }]),
      upsertPlatformTools: vi.fn(async () => undefined),
      setToolEnabled: vi.fn(async () => undefined),
  };
  const longTasks = {
    submit: vi.fn((type: string, payload: unknown) => ({
      success: true,
      job: {
        id: `job:${type}`,
        type,
        status: 'queued',
        payload,
      },
    })),
  };
  const jobs = {
    submitInstallNativeTool: vi.fn((source: unknown) => longTasks.submit('platform.installNativeTool', { source })),
    submitReconcileTools: vi.fn(() => longTasks.submit('platform.reconcileTools', null)),
  };
  return {
    platformRuntime,
    longTasks,
    jobs,
    routeDeps: {
      platformService: new PlatformService({
        operationsWorkflow: new PlatformRuntimeOperationsWorkflow({
          platformRuntime,
          jobs,
          toolRuntimeWorkflow: new PlatformToolRuntimeWorkflow({ platformRuntime }),
        }),
      }),
    },
  };
}

async function dispatchPlatformRuntimeCapability(
  platformService: PlatformService,
  toolchainUvService: { install(): unknown },
  operationId: string,
  payload: Record<string, unknown> = {},
) {
  const route = createPlatformRuntimeCapabilityOperationRoutes({ platformService, toolchainUvService })
    .find((candidate) => candidate.operationId === operationId);
  if (!route) {
    throw new Error(`Missing platform runtime operation: ${operationId}`);
  }
  return await route.handle(payload);
}

describe('runtime-host process platform routes', () => {
  it('平台工具列表只读当前快照，不在查询请求里刷新 runtime', async () => {
    const deps = createDeps();

    const result = await dispatchRuntimeRouteDefinition(platformRoutes, 
      'GET',
      '/api/platform/tools',
      new URL('http://127.0.0.1/api/platform/tools?includeDisabled=true'),
      undefined,
      deps.routeDeps,
    );

    expect(deps.platformRuntime.runtimeHealth).not.toHaveBeenCalled();
    expect(deps.platformRuntime.reconcileNativeTools).not.toHaveBeenCalled();
    expect(deps.platformRuntime.listEffectiveTools).toHaveBeenCalledWith({ includeDisabled: true });
    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        tools: [{ id: 'tool.echo', source: 'platform', enabled: true }],
      },
    });
  });

  it('平台工具刷新 capability 提交后台任务，不在请求里执行 reconcile', async () => {
    const deps = createDeps();

    const result = await dispatchPlatformRuntimeCapability(
      deps.routeDeps.platformService,
      { install: vi.fn(() => deps.longTasks.submit('toolchain.uvInstall', null)) },
      'platform.reconcileTools',
    );

    expect(deps.platformRuntime.reconcileNativeTools).not.toHaveBeenCalled();
    expect(deps.jobs.submitReconcileTools).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job:platform.reconcileTools',
          type: 'platform.reconcileTools',
          status: 'queued',
          payload: null,
        },
      },
    });
  });

  it('不再暴露平台工具 direct mutation 路由', async () => {
    const deps = createDeps();

    const result = await dispatchRuntimeRouteDefinition(platformRoutes,
      'POST',
      '/api/platform/tools/reconcile',
      new URL('http://127.0.0.1/api/platform/tools/reconcile'),
      {},
      deps.routeDeps,
    );

    expect(result).toBeNull();
  });
});
