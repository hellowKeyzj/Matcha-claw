import { describe, expect, it } from 'vitest';
import type { AgentRuntimeDriver, RunContext } from '@electron/core/contracts';

class FakeRuntimeDriver implements AgentRuntimeDriver {
  async initialize(): Promise<void> {}
  async healthCheck(): Promise<{ status: string }> { return { status: 'running' }; }
  async installTool(): Promise<string> { return 'tool-1'; }
  async uninstallTool(): Promise<void> {}
  async enableTool(): Promise<void> {}
  async disableTool(): Promise<void> {}
  async listInstalledTools(): Promise<Array<{ id: string; source: string }>> { return [{ id: 'tool-1', source: 'native' }]; }
  async execute(context: RunContext): Promise<string> { return `run:${context.sessionId}`; }
  async abort(): Promise<void> {}
}

describe('runtime driver contract', () => {
  it('must support install/list/execute lifecycle', async () => {
    const driver = new FakeRuntimeDriver();
    const toolId = await driver.installTool({ kind: 'package', spec: 'foo' });
    const list = await driver.listInstalledTools();
    const runId = await driver.execute({
      sessionId: 's1',
      systemPrompt: '',
      resourceBindings: [],
      enabledTools: [],
      platformCredentials: {},
    });

    expect(toolId).toBe('tool-1');
    expect(list[0].id).toBe('tool-1');
    expect(runId).toBe('run:s1');
  });
});
