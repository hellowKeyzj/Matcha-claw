import { describe, expect, it, vi } from 'vitest';
import { createRuntimeHostPlatformRoot } from '../../../runtime-host/api/platform/runtime-root';

describe('runtime-host platform root', () => {
  it('在子进程内装配 runtime manager 和 run service', async () => {
    const platformEnableTool = vi.fn().mockResolvedValue(undefined);
    const platformDisableTool = vi.fn().mockResolvedValue(undefined);
    const platformListToolsCatalog = vi.fn().mockResolvedValue([{ id: 'p1', source: 'plugin', enabled: false }]);
    const root = createRuntimeHostPlatformRoot({
      isGatewayRunning: vi.fn().mockResolvedValue(true),
      platformInstallTool: vi.fn(),
      platformUninstallTool: vi.fn(),
      platformEnableTool,
      platformDisableTool,
      platformListToolsCatalog,
      platformStartRun: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      platformAbortRun: vi.fn(),
    });

    expect(root.runtimeManager).toBeDefined();
    expect(root.runSessionService).toBeDefined();

    const runId = await root.facade.startRun({ sessionId: 's1' });
    expect(runId).toBe('run-1');

    await root.facade.setToolEnabled('p1', true);
    expect(platformEnableTool).toHaveBeenCalledWith('p1');
  });
});
