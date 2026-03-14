import { describe, expect, it } from 'vitest';
import { ContextAssembler, PolicyEngine, ToolRegistryStore } from '@electron/adapters/platform';

describe('platform ports', () => {
  it('merges native and platform tools', async () => {
    const registry = new ToolRegistryStore();
    await registry.upsertNative([{ id: 'n1', source: 'native', enabled: true }]);
    await registry.upsertPlatform([{ id: 'p1', source: 'platform', enabled: true }]);
    const tools = await registry.listEffective({});
    expect(tools.map((tool) => tool.id)).toEqual(['n1', 'p1']);
  });

  it('context assembler applies policy decisions', async () => {
    const registry = new ToolRegistryStore();
    await registry.upsertPlatform([
      { id: 'allowed', source: 'platform', enabled: true },
      { id: 'blocked', source: 'platform', enabled: true },
    ]);
    const policy = new PolicyEngine(new Set(['blocked']));
    const assembler = new ContextAssembler(registry, policy);
    const context = await assembler.assemble({ sessionId: 's1' });
    expect(context.enabledTools.map((tool) => tool.id)).toEqual(['allowed']);
  });
});
