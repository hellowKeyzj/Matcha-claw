import { describe, expect, it, vi } from 'vitest';
import {
  registerRuntimeHostPlatformRoot,
  resolveRuntimeHostPlatformRoot,
} from '../../runtime-host/composition/modules/platform-runtime-module';
import { createTestRuntimeHostContainer } from '../unit/helpers/runtime-host-container';

describe('platform runtime execute integration', () => {
  it('在 runtime-host 子进程里组装 context 并通过 bridge 执行', async () => {
    const container = createTestRuntimeHostContainer();
    const platformStartRun = vi.fn().mockResolvedValue({ runId: 'run-integration-1' });
    registerRuntimeHostPlatformRoot(container, () => ({
      isGatewayRunning: vi.fn().mockResolvedValue(true),
      platformInstallTool: vi.fn(),
      platformUninstallTool: vi.fn(),
      platformEnableTool: vi.fn(),
      platformDisableTool: vi.fn(),
      platformListToolsCatalog: vi.fn().mockResolvedValue([]),
      platformStartRun,
      platformAbortRun: vi.fn(),
    }));
    const root = resolveRuntimeHostPlatformRoot(container);

    const runId = await root.facade.startRun({
      sessionId: 'session-integration',
      systemPrompt: 'hello',
    });

    expect(runId).toBe('run-integration-1');
    expect(platformStartRun).toHaveBeenCalledWith(expect.any(Object), undefined);
  });
});
