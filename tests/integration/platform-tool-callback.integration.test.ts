import { describe, expect, it, vi } from 'vitest';
import { buildPlatformCompositionRoot } from '@electron/main/platform-composition-root';

describe('platform tool callback integration', () => {
  it('executes registered platform tool through facade', async () => {
    const root = buildPlatformCompositionRoot({
      gatewayManager: {
        rpc: vi.fn().mockResolvedValue({ runId: 'run-1' }),
        getStatus: vi.fn().mockReturnValue({ state: 'running' }),
      } as never,
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
