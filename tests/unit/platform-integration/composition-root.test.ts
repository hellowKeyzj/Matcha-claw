import { describe, expect, it, vi } from 'vitest';
import { createRuntimeHostPlatformRoot } from '../../../runtime-host/api/platform/runtime-root';

describe('runtime-host platform root', () => {
  it('在子进程内装配 runtime manager 和 run service', async () => {
    const root = createRuntimeHostPlatformRoot({
      isGatewayRunning: vi.fn().mockResolvedValue(true),
      platformInstallTool: vi.fn(),
      platformUninstallTool: vi.fn(),
      platformEnableTool: vi.fn(),
      platformDisableTool: vi.fn(),
      platformListToolsCatalog: vi.fn().mockResolvedValue([]),
      platformStartRun: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      platformAbortRun: vi.fn(),
    });

    expect(root.runtimeManager).toBeDefined();
    expect(root.runSessionService).toBeDefined();

    const runId = await root.facade.startRun({ sessionId: 's1' });
    expect(runId).toBe('run-1');
  });
});
