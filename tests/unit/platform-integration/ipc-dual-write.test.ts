import { describe, expect, it, vi } from 'vitest';
import { PlatformIpcFacade } from '@electron/main/platform-ipc-facade';
import { LocalPluginStateLedger } from '@electron/adapters/platform';
import { ToolRegistryStore } from '@electron/adapters/platform/tool-registry-store';

describe('platform ipc facade', () => {
  it('writes platform tools to registry and local ledger', async () => {
    const runtimeManager = {
      runtimeHealth: vi.fn().mockResolvedValue({ status: 'running' }),
      installNativeTool: vi.fn(),
      reconcileNativeTools: vi.fn(),
    };
    const runSessionService = {
      start: vi.fn(),
      abort: vi.fn(),
    };
    const toolCatalog = {
      listEffective: vi.fn().mockResolvedValue([]),
      upsertPlatformTools: vi.fn().mockResolvedValue(undefined),
      setToolEnabled: vi.fn().mockResolvedValue(undefined),
    };
    const executor = { executeTool: vi.fn() };
    const localLedger = new LocalPluginStateLedger();
    const registry = new ToolRegistryStore();
    await registry.upsertPlatform([{ id: 'p1', source: 'platform', enabled: true }]);

    const facade = new PlatformIpcFacade(
      runtimeManager as never,
      runSessionService as never,
      toolCatalog as never,
      executor as never,
      localLedger,
      registry,
    );

    await facade.upsertPlatformTools([{ id: 'p1', source: 'platform', enabled: true }]);
    expect(toolCatalog.upsertPlatformTools).toHaveBeenCalledTimes(1);
    expect(localLedger.list().map((tool) => tool.id)).toEqual(['p1']);
  });
});
