import { describe, expect, it, vi } from 'vitest';
import {
  registerRuntimeHostPlatformRoot,
  resolveRuntimeHostPlatformRoot,
} from '../../runtime-host/composition/modules/platform-runtime-module';
import { createTestRuntimeHostContainer } from '../unit/helpers/runtime-host-container';

describe('platform tool callback integration', () => {
  it('通过子进程 facade 执行注册的平台工具', async () => {
    const container = createTestRuntimeHostContainer();
    container.registerValue('gateway.runtime', {});
    container.registerValue('platform.runtimeDriverFactory', {
      createRuntimeDriver: () => ({
        initialize: vi.fn(async () => undefined),
        healthCheck: vi.fn(async () => ({ status: 'running' })),
        installTool: vi.fn(async () => 'tool.echo'),
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

    root.toolExecutor.register('tool.echo', async (req) => ({
      ok: true,
      output: req.args?.value ?? null,
    }));

    const result = await root.facade.executePlatformTool({
      toolId: 'tool.echo',
      args: { value: 'hello' },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('hello');
  });
});
