import { describe, expect, it, vi } from 'vitest';
import { buildPlatformCompositionRoot } from '@electron/main/platform-composition-root';

describe('platform composition root', () => {
  it('wires runtime manager and run service', async () => {
    const root = buildPlatformCompositionRoot({
      gatewayManager: {
        rpc: vi.fn().mockResolvedValue({ runId: 'run-1' }),
        getStatus: vi.fn().mockReturnValue({ state: 'running' }),
      } as never,
    });

    expect(root.runtimeManager).toBeDefined();
    expect(root.runSessionService).toBeDefined();

    const runId = await root.facade.startRun({ sessionId: 's1' });
    expect(runId).toBe('run-1');
  });
});
