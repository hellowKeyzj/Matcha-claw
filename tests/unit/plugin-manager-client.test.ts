import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostApiFetchMock, capabilityExecuteMock } from './helpers/mock-gateway-client';

const waitForRuntimeJobResultMock = vi.fn();

const pluginRuntimeScope = {
  kind: 'runtime-instance' as const,
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
};

vi.mock('@/lib/host-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/host-api')>();
  return {
    ...actual,
    waitForRuntimeJobResult: (...args: unknown[]) => waitForRuntimeJobResultMock(...args),
  };
});

describe('plugin manager client', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
    capabilityExecuteMock.mockReset();
    waitForRuntimeJobResultMock.mockReset();
  });

  it('getPluginCatalog/getPluginRuntime 走通用插件中心接口', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ success: true, plugins: [] })
      .mockResolvedValueOnce({ success: true, execution: { enabledPluginIds: [] } });

    const { getPluginCatalog, getPluginRuntime } = await import('@/services/openclaw/plugin-manager-client');
    const catalog = await getPluginCatalog();
    const runtime = await getPluginRuntime();

    expect(catalog.success).toBe(true);
    expect(runtime.success).toBe(true);
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/plugins/catalog', undefined);
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/plugins/runtime', undefined);
  });

  it('setEnabledPluginIds 走通用插件写接口', async () => {
    capabilityExecuteMock
      .mockResolvedValueOnce({
        success: true,
        job: {
          id: 'job-1',
          type: 'plugins.setEnabled',
          status: 'queued',
          queuedAt: 1,
          attempts: 0,
          maxAttempts: 1,
        },
      });
    waitForRuntimeJobResultMock.mockResolvedValue({
      success: true,
      execution: { enabledPluginIds: ['task-manager'] },
    });

    const { setEnabledPluginIds } = await import('@/services/openclaw/plugin-manager-client');
    await setEnabledPluginIds(['task-manager']);

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'plugin.runtime',
        operationId: 'plugins.setEnabled',
        scope: pluginRuntimeScope,
        target: { kind: 'plugin', pluginId: 'task-manager' },
        input: { pluginIds: ['task-manager'], enabled: true },
      }),
      { timeoutMs: undefined },
    );
    expect(waitForRuntimeJobResultMock).toHaveBeenCalledWith('job-1');
  });
});
