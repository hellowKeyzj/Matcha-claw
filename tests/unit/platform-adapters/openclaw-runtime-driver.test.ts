import { describe, expect, it, vi } from 'vitest';
import { OpenClawRuntimeDriver } from '../../../runtime-host/api/platform/openclaw-runtime-driver';

describe('openclaw runtime driver', () => {
  it('把平台运行时方法映射到 openclaw bridge', async () => {
    const bridge = {
      isGatewayRunning: vi.fn().mockResolvedValue(true),
      platformInstallTool: vi.fn().mockResolvedValue({ toolId: 'tool-1' }),
      platformUninstallTool: vi.fn().mockResolvedValue(undefined),
      platformEnableTool: vi.fn().mockResolvedValue(undefined),
      platformDisableTool: vi.fn().mockResolvedValue(undefined),
      platformListToolsCatalog: vi.fn().mockResolvedValue([{ id: 'native-1', source: 'native' }]),
      platformStartRun: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      platformAbortRun: vi.fn().mockResolvedValue(undefined),
    };

    const driver = new OpenClawRuntimeDriver(bridge as never);
    await driver.installTool({ kind: 'package', spec: 'foo@1.0.0' });
    await driver.enableTool('tool-1');
    await driver.disableTool('tool-1');
    await driver.uninstallTool('tool-1');
    const tools = await driver.listInstalledTools();
    const runId = await driver.execute({
      sessionId: 's1',
      systemPrompt: '',
      resourceBindings: [],
      enabledTools: [],
      platformCredentials: {},
    });
    await driver.abort(runId);

    expect(tools).toHaveLength(1);
    expect(runId).toBe('run-1');
    expect(bridge.platformInstallTool).toHaveBeenCalledWith({ kind: 'package', spec: 'foo@1.0.0' });
    expect(bridge.platformStartRun).toHaveBeenCalledWith(expect.any(Object), undefined);
  });
});
