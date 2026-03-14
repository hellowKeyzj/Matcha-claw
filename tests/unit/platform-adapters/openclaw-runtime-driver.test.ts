import { describe, expect, it, vi } from 'vitest';
import { OpenClawRuntimeDriver } from '@electron/adapters/openclaw';

describe('openclaw runtime driver', () => {
  it('maps runtime methods to gateway rpc', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ toolId: 'tool-1' })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ id: 'native-1', source: 'native' }])
      .mockResolvedValueOnce({ runId: 'run-1' })
      .mockResolvedValueOnce(undefined);
    const gateway = {
      rpc,
      getStatus: vi.fn().mockReturnValue({ state: 'running' }),
    };

    const driver = new OpenClawRuntimeDriver(gateway as never);
    await driver.installTool({ kind: 'package', spec: 'foo@1.0.0' });
    await driver.enableTool('tool-1');
    await driver.disableTool('tool-1');
    await driver.uninstallTool('tool-1');
    const tools = await driver.listInstalledTools();
    const runId = await driver.execute({
      sessionId: 's1',
      systemPrompt: '',
      resourceBindings: [],
      enabledTools: [],
      platformCredentials: {},
    });
    await driver.abort(runId);

    expect(tools).toHaveLength(1);
    expect(runId).toBe('run-1');
    expect(rpc).toHaveBeenCalledWith('plugins.install', { kind: 'package', spec: 'foo@1.0.0' });
    expect(rpc).toHaveBeenCalledWith('agent.run', expect.any(Object));
  });
});
