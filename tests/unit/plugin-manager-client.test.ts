import { beforeEach, describe, expect, it } from 'vitest';
import { hostApiFetchMock } from './helpers/mock-gateway-client';

describe('plugin manager client', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
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
    hostApiFetchMock
      .mockResolvedValueOnce({ success: true, execution: { enabledPluginIds: ['task-manager'] } });

    const { setEnabledPluginIds } = await import('@/services/openclaw/plugin-manager-client');
    await setEnabledPluginIds(['task-manager']);

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/plugins/runtime/enabled-plugins', {
      method: 'PUT',
      body: JSON.stringify({ pluginIds: ['task-manager'] }),
    });
  });
});
