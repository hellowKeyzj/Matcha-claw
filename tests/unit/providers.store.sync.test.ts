import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProviderStore } from '@/stores/providers';
import { useSubagentsStore } from '@/stores/subagents';
import type { ProviderWithKeyInfo } from '@/lib/providers';
import type { ConfigGetResult } from '@/types/subagent';

function buildModelConfig(modelIdsByProvider: Record<string, string[]>): ConfigGetResult {
  return {
    hash: 'hash-model-config',
    config: {
      models: {
        providers: Object.fromEntries(
          Object.entries(modelIdsByProvider).map(([providerId, modelIds]) => [
            providerId,
            {
              models: modelIds.map((id) => ({ id })),
            },
          ])
        ),
      },
    },
  } as ConfigGetResult;
}

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

  it('addProvider 只读取一次 config.get 且不触发 reconcileAgentModels', async () => {
    const subagents = mockSubagentsActions();
    const afterConfig = buildModelConfig({
      custom: ['claude-sonnet-4.5'],
    });

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
        if (channel === 'gateway:rpc' && args[0] === 'config.get') {
          return { success: true, result: afterConfig };
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
    expect(configGetCalls).toHaveLength(1);
    expect(subagents.reconcileAgentModels).not.toHaveBeenCalled();
    expect(subagents.loadAvailableModels).toHaveBeenCalledWith(afterConfig);
    expect(subagents.loadAgents).not.toHaveBeenCalled();
  });

  it('updateProvider 复用后快照，config.get 调用降为两次', async () => {
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

    const beforeConfig = buildModelConfig({
      custom: ['old-model'],
    });
    const afterConfig = buildModelConfig({
      custom: ['new-model'],
    });

    let configGetCount = 0;
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'gateway:rpc' && args[0] === 'config.get') {
        configGetCount += 1;
        return {
          success: true,
          result: configGetCount === 1 ? beforeConfig : afterConfig,
        };
      }
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
    expect(configGetCalls).toHaveLength(2);
    expect(subagents.reconcileAgentModels).toHaveBeenCalledWith({
      removedModelIds: ['custom/old-model'],
      cfg: afterConfig,
    });
    expect(subagents.loadAvailableModels).toHaveBeenCalledWith(afterConfig);
  });
});
