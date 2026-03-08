import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProviderStore } from '@/stores/providers';
import { useSubagentsStore } from '@/stores/subagents';
import type { ProviderWithKeyInfo } from '@/lib/providers';

function mockSubagentsActions() {
  const reconcileAgentModels = vi.fn(async () => false);
  const loadAvailableModels = vi.fn(async () => undefined);
  const loadAgents = vi.fn(async () => undefined);

  useSubagentsStore.setState({
    ...useSubagentsStore.getState(),
    reconcileAgentModels,
    loadAvailableModels,
    loadAgents,
  }, true);

  return { reconcileAgentModels, loadAvailableModels, loadAgents };
}

describe('providers store sync optimization', () => {
  beforeEach(() => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockReset();
    useProviderStore.setState(useProviderStore.getInitialState(), true);
    useSubagentsStore.setState(useSubagentsStore.getInitialState(), true);
  });

  it('addProvider 不触发前端 config.get/reconcile/loadAgents，仅刷新模型目录', async () => {
    const subagents = mockSubagentsActions();

    vi.mocked(window.electron.ipcRenderer.invoke).mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === 'provider:save') {
          return { success: true };
        }
        if (channel === 'provider:list') {
          return [];
        }
        if (channel === 'provider:getDefault') {
          return null;
        }
        throw new Error(`Unexpected invoke call: ${channel} ${String(args[0])}`);
      }
    );

    await useProviderStore.getState().addProvider(
      {
        id: 'custom-sync-test',
        type: 'custom',
        name: 'Custom Sync Test',
        baseUrl: 'https://example.com/v1',
        model: 'claude-sonnet-4.5',
        enabled: true,
      },
      'sk-test'
    );

    const configGetCalls = vi.mocked(window.electron.ipcRenderer.invoke).mock.calls
      .filter(([channel, method]) => channel === 'gateway:rpc' && method === 'config.get');
    expect(configGetCalls).toHaveLength(0);
    expect(subagents.reconcileAgentModels).not.toHaveBeenCalled();
    expect(subagents.loadAvailableModels).toHaveBeenCalledTimes(1);
    expect(subagents.loadAvailableModels).toHaveBeenCalledWith();
    expect(subagents.loadAgents).not.toHaveBeenCalled();
  });

  it('updateProvider 不再做 before/after 快照与前端 reconcile', async () => {
    const subagents = mockSubagentsActions();
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);

    const existingProvider: ProviderWithKeyInfo = {
      id: 'custom-sync-test',
      type: 'custom',
      name: 'Custom Sync Test',
      baseUrl: 'https://example.com/v1',
      model: 'old-model',
      enabled: true,
      hasKey: true,
      keyMasked: 'sk-****',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt: '2026-03-07T00:00:00.000Z',
    };

    useProviderStore.setState({
      ...useProviderStore.getState(),
      providers: [existingProvider],
    }, true);

    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'provider:save') {
        return { success: true };
      }
      if (channel === 'provider:list') {
        return [{ ...existingProvider, model: 'new-model' }];
      }
      if (channel === 'provider:getDefault') {
        return existingProvider.id;
      }
      throw new Error(`Unexpected invoke call: ${channel} ${String(args[0])}`);
    });

    await useProviderStore.getState().updateProvider('custom-sync-test', {
      model: 'new-model',
    });

    const configGetCalls = invoke.mock.calls
      .filter(([channel, method]) => channel === 'gateway:rpc' && method === 'config.get');
    expect(configGetCalls).toHaveLength(0);
    expect(subagents.reconcileAgentModels).not.toHaveBeenCalled();
    expect(subagents.loadAvailableModels).toHaveBeenCalledTimes(1);
    expect(subagents.loadAvailableModels).toHaveBeenCalledWith();
    expect(subagents.loadAgents).not.toHaveBeenCalled();
  });
});
