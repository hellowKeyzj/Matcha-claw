import { describe, expect, it, vi } from 'vitest';
import {
  registerRuntimeHostPlatformRoot,
  resolveRuntimeHostPlatformRoot,
} from '../../../runtime-host/composition/modules/platform-runtime-module';
import { createTestRuntimeHostContainer } from '../helpers/runtime-host-container';

describe('runtime-host platform facade', () => {
  it('写入 platform tools 后会更新子进程注册表快照', async () => {
    const container = createTestRuntimeHostContainer();
    registerRuntimeHostPlatformRoot(container, () => ({
      isGatewayRunning: vi.fn().mockResolvedValue(true),
      platformInstallTool: vi.fn(),
      platformUninstallTool: vi.fn(),
      platformEnableTool: vi.fn(),
      platformDisableTool: vi.fn(),
      platformListToolsCatalog: vi.fn().mockResolvedValue([]),
      platformStartRun: vi.fn(),
      platformAbortRun: vi.fn(),
    }));
    const root = resolveRuntimeHostPlatformRoot(container);

    await root.facade.upsertPlatformTools([{ id: 'p1', source: 'platform', enabled: true }]);
    expect(root.toolRegistry.snapshotPlatform().map((tool) => tool.id)).toEqual(['p1']);
  });
});
