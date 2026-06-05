import { describe, expect, it, vi } from 'vitest';
import {
  registerRuntimeHostPlatformRoot,
  resolveRuntimeHostPlatformRoot,
} from '../../../runtime-host/composition/modules/platform-runtime-module';
import { createTestRuntimeHostContainer } from '../helpers/runtime-host-container';

describe('runtime-host platform facade', () => {
  it('写入 platform tools 后会更新子进程注册表快照', async () => {
    const container = createTestRuntimeHostContainer();
    container.registerValue('gateway.runtime', {});
    container.registerValue('platform.runtimeDriverFactory', {
      createRuntimeDriver: () => ({
        initialize: vi.fn(async () => undefined),
        healthCheck: vi.fn(async () => ({ status: 'running' })),
        installTool: vi.fn(async () => 'tool-1'),
        uninstallTool: vi.fn(async () => undefined),
        enableTool: vi.fn(async () => undefined),
        disableTool: vi.fn(async () => undefined),
        listInstalledTools: vi.fn(async () => []),
        execute: vi.fn(async () => 'run-1'),
        abort: vi.fn(async () => undefined),
      }),
    });
    registerRuntimeHostPlatformRoot(container);
    const root = resolveRuntimeHostPlatformRoot(container);

    await root.facade.upsertPlatformTools([{ id: 'p1', source: 'platform', enabled: true }]);
    expect(root.toolRegistry.snapshotPlatform().map((tool) => tool.id)).toEqual(['p1']);
  });
});
