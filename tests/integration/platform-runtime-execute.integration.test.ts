import { describe, expect, it, vi } from 'vitest';
import { buildPlatformCompositionRoot } from '@electron/main/platform-composition-root';

describe('platform runtime execute integration', () => {
  it('assembles context and executes through runtime driver', async () => {
    const rpc = vi.fn().mockResolvedValue({ runId: 'run-integration-1' });
    const root = buildPlatformCompositionRoot({
      gatewayManager: {
        rpc,
        getStatus: vi.fn().mockReturnValue({ state: 'running' }),
      } as never,
    });

    const runId = await root.facade.startRun({
      sessionId: 'session-integration',
      systemPrompt: 'hello',
    });

    expect(runId).toBe('run-integration-1');
    expect(rpc).toHaveBeenCalledWith('agent.run', expect.any(Object), undefined);
  });
});
