import { describe, expect, it, vi } from 'vitest';
import { OpenClawRuntimeDriver } from '../../../runtime-host/api/platform/openclaw-runtime-driver';

describe('openclaw runtime driver', () => {
  it('healthCheck 直接映射 bridge 的只读连接状态快照', async () => {
    const bridge = {
      readGatewayConnectionState: vi.fn().mockResolvedValue({
        state: 'reconnecting',
        portReachable: true,
        lastError: 'ws reconnecting',
        updatedAt: 1234,
      }),
      isGatewayRunning: vi.fn().mockResolvedValue(true),
      platformInstallTool: vi.fn(),
      platformUninstallTool: vi.fn(),
      platformEnableTool: vi.fn(),
      platformDisableTool: vi.fn(),
      platformListToolsCatalog: vi.fn().mockResolvedValue([]),
      platformStartRun: vi.fn(),
      platformAbortRun: vi.fn(),
    };

    const driver = new OpenClawRuntimeDriver(bridge as never);
    await expect(driver.healthCheck()).resolves.toEqual({
      status: 'running',
      detail: 'gateway control channel reconnecting',
      portReachable: true,
      connectionState: 'reconnecting',
      lastError: 'ws reconnecting',
      updatedAt: 1234,
    });
    expect(bridge.readGatewayConnectionState).toHaveBeenCalledTimes(1);
    expect(bridge.isGatewayRunning).not.toHaveBeenCalled();
  });

  it('把平台运行时方法映射到 openclaw bridge', async () => {
    const bridge = {
      readGatewayConnectionState: vi.fn().mockResolvedValue({
        state: 'connected',
        portReachable: true,
        updatedAt: 1,
      }),
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
