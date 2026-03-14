import { describe, expect, it } from 'vitest';
import { ToolRegistryStore } from '@electron/adapters/platform';

describe('tool registry contract', () => {
  it('returns enabled tools only by default', async () => {
    const registry = new ToolRegistryStore();
    await registry.upsertNative([
      { id: 'n-enabled', source: 'native', enabled: true },
      { id: 'n-disabled', source: 'native', enabled: false },
    ]);

    const tools = await registry.listEffective({});
    expect(tools.map((tool) => tool.id)).toEqual(['n-enabled']);
  });

  it('supports setEnabled and includeDisabled query', async () => {
    const registry = new ToolRegistryStore();
    await registry.upsertPlatform([{ id: 'p1', source: 'platform', enabled: true }]);
    await registry.setEnabled('p1', false);

    const disabledIncluded = await registry.listEffective({ includeDisabled: true });
    const defaultView = await registry.listEffective({});
    expect(disabledIncluded.map((tool) => tool.id)).toContain('p1');
    expect(defaultView.map((tool) => tool.id)).not.toContain('p1');
  });
});
