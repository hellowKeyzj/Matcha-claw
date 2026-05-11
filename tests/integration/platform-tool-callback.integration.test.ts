import { describe, expect, it, vi } from 'vitest';
import {
  registerRuntimeHostPlatformRoot,
  resolveRuntimeHostPlatformRoot,
} from '../../runtime-host/composition/modules/platform-runtime-module';
import { createTestRuntimeHostContainer } from '../unit/helpers/runtime-host-container';

describe('platform tool callback integration', () => {
  it('通过子进程 facade 执行注册的平台工具', async () => {
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
