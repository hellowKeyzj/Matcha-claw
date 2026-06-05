import { describe, expect, it, vi } from 'vitest';
import {
  registerRuntimeHostPlatformRoot,
  resolveRuntimeHostPlatformRoot,
} from '../../runtime-host/composition/modules/platform-runtime-module';
import { createTestRuntimeHostContainer } from '../unit/helpers/runtime-host-container';

describe('platform runtime execute integration', () => {
  it('在 runtime-host 子进程里组装 context 并通过 bridge 执行', async () => {
    const container = createTestRuntimeHostContainer();
    const platformStartRun = vi.fn().mockResolvedValue('run-integration-1');
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
        execute: platformStartRun,
        abort: vi.fn(async () => undefined),
      }),
    });
    registerRuntimeHostPlatformRoot(container);
    const root = resolveRuntimeHostPlatformRoot(container);

    const runId = await root.facade.startRun({
      sessionId: 'session-integration',
      systemPrompt: 'hello',
    });

    expect(runId).toBe('run-integration-1');
    expect(platformStartRun).toHaveBeenCalledWith(expect.any(Object), undefined);
  });
});
