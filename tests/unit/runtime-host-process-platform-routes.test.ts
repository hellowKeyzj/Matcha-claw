import { describe, expect, it, vi } from 'vitest';
import { handlePlatformRoute } from '../../runtime-host/api/routes/platform-routes';

function createDeps() {
  return {
    platformRuntime: {
      runtimeHealth: vi.fn(async () => ({ status: 'running' })),
      installNativeTool: vi.fn(async () => 'tool-native-1'),
      reconcileNativeTools: vi.fn(async () => ({ discovered: [], missing: [], conflicts: [] })),
      startRun: vi.fn(async () => 'run-1'),
      abortRun: vi.fn(async () => undefined),
      listEffectiveTools: vi.fn(async () => [{ id: 'tool.echo', source: 'platform', enabled: true }]),
      upsertPlatformTools: vi.fn(async () => undefined),
      setToolEnabled: vi.fn(async () => undefined),
      executePlatformTool: vi.fn(async () => ({ ok: true, output: 'hello' })),
    },
  };
}

describe('runtime-host process platform routes', () => {
  it('平台工具查询和刷新在子进程内执行', async () => {
    const deps = createDeps();

    const result = await handlePlatformRoute(
      'GET',
      '/api/platform/tools',
      new URL('http://127.0.0.1/api/platform/tools?includeDisabled=true'),
      undefined,
      deps,
    );

    expect(deps.platformRuntime.runtimeHealth).toHaveBeenCalledTimes(1);
    expect(deps.platformRuntime.reconcileNativeTools).toHaveBeenCalledTimes(1);
    expect(deps.platformRuntime.listEffectiveTools).toHaveBeenCalledWith({ includeDisabled: true });
    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        tools: [{ id: 'tool.echo', source: 'platform', enabled: true }],
        refreshed: true,
      },
    });
  });

  it('平台工具执行走子进程 facade', async () => {
    const deps = createDeps();

    const result = await handlePlatformRoute(
      'POST',
      '/api/platform/tools/execute',
      new URL('http://127.0.0.1/api/platform/tools/execute'),
      { req: { toolId: 'tool.echo', args: { value: 'hello' } } },
      deps,
    );

    expect(deps.platformRuntime.executePlatformTool).toHaveBeenCalledWith({
      toolId: 'tool.echo',
      args: { value: 'hello' },
    });
    expect(result).toEqual({
      status: 200,
      data: { ok: true, output: 'hello' },
    });
  });
});
