import { describe, expect, it, vi } from 'vitest';
import { createRuntimeHostPlatformRoot } from '../../runtime-host/api/platform/runtime-root';

describe('platform tool callback integration', () => {
  it('通过子进程 facade 执行注册的平台工具', async () => {
    const root = createRuntimeHostPlatformRoot({
      isGatewayRunning: vi.fn().mockResolvedValue(true),
      platformInstallTool: vi.fn(),
      platformUninstallTool: vi.fn(),
      platformEnableTool: vi.fn(),
      platformDisableTool: vi.fn(),
      platformListToolsCatalog: vi.fn().mockResolvedValue([]),
      platformStartRun: vi.fn(),
      platformAbortRun: vi.fn(),
    });

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
