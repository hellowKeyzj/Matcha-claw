import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS,
  MINIMAX_M27_MAX_TOKENS,
} from '../../runtime-host/application/adapters/openclaw/projections/openclaw-anthropic-messages-max-tokens';
import { OpenClawProviderModelsService } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-provider-models-service';
import { OpenClawProviderModelsProjectionWorkflow } from '../../runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-provider-models-projection-workflow';

function createService(initialConfig: Record<string, unknown>) {
  let config = structuredClone(initialConfig);
  const service = new OpenClawProviderModelsService(new OpenClawProviderModelsProjectionWorkflow({
    read: async () => structuredClone(config),
    write: async (next) => {
      config = structuredClone(next);
    },
    updateDirty: async (mutate) => {
      const next = structuredClone(config);
      const update = await mutate(next);
      if (update.changed) {
        config = structuredClone(next);
      }
      return update.result;
    },
    getConfigDir: () => '',
    getConfigFilePath: () => '',
    getOpenClawDirPath: () => '',
  }));
  return {
    service,
    readConfig: () => config,
  };
}

describe('OpenClawProviderModelsService', () => {
  it('writes custom provider transport and models as one valid provider node', async () => {
    const { service, readConfig } = createService({});

    await service.replaceAll({
      'custom-dd749b2e': {
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        headers: { 'User-Agent': 'MatchaClaw/1.0' },
        models: [
          { modelId: 'gpt-5.4', input: ['text'], contextWindow: 128000, maxTokens: 8192 },
        ],
      },
    });

    expect((readConfig().models as any).providers['custom-dd749b2e']).toEqual({
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      headers: { 'User-Agent': 'MatchaClaw/1.0' },
      models: [
        {
          id: 'gpt-5.4',
          name: 'gpt-5.4',
          input: ['text'],
          contextWindow: 128000,
          maxTokens: 8192,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      ],
    });
  });

  it('adds maxTokens defaults for anthropic-messages provider models', async () => {
    const { service, readConfig } = createService({});

    await service.replaceAll({
      'minimax-portal': {
        baseUrl: 'https://api.minimax.io/anthropic',
        api: 'anthropic-messages',
        models: [
          { modelId: 'MiniMax-M2.7' },
        ],
      },
      'custom-anthropic': {
        baseUrl: 'https://api.example.com/anthropic',
        api: 'anthropic-messages',
        models: [
          { modelId: 'claude-proxy' },
          { modelId: 'claude-proxy-capped', maxTokens: 12288 },
        ],
      },
    });

    const providers = (readConfig().models as any).providers;
    expect(providers['minimax-portal'].maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
    expect(providers['minimax-portal'].models[0].maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
    expect(providers['custom-anthropic'].maxTokens).toBe(ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS);
    expect(providers['custom-anthropic'].models[0].maxTokens).toBe(ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS);
    expect(providers['custom-anthropic'].models[1].maxTokens).toBe(12288);
  });

  it('keeps provider node schema-valid when the last model is removed', async () => {
    const { service, readConfig } = createService({
      models: {
        providers: {
          'custom-dd749b2e': {
            baseUrl: 'https://api.example.com/v1',
            api: 'openai-completions',
            models: [{ id: 'gpt-5.4', name: 'gpt-5.4' }],
          },
        },
      },
    });

    await service.replaceAll({
      'custom-dd749b2e': {
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        models: [],
      },
    });

    expect((readConfig().models as any).providers['custom-dd749b2e']).toEqual({
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      models: [],
    });
  });

  it('removes replaced provider keys while writing the current provider node', async () => {
    const { service, readConfig } = createService({
      models: {
        providers: {
          'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a': {
            baseUrl: 'https://api.example.com/v1',
            api: 'openai-completions',
            models: [],
          },
        },
      },
    });

    await service.replaceAll({
      'custom-dd749b2e': {
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        replaceProviderKeys: ['custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a'],
        models: [
          { modelId: 'gpt-5.4' },
        ],
      },
    });

    expect((readConfig().models as any).providers).toEqual({
      'custom-dd749b2e': {
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        models: [
          {
            id: 'gpt-5.4',
            name: 'gpt-5.4',
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        ],
      },
    });
  });

  it('prunes agent model refs that are not in the current model catalog', async () => {
    const { service, readConfig } = createService({
      models: {
        providers: {
          'custom-old': {
            baseUrl: 'https://old.example.com/v1',
            api: 'openai-completions',
            models: [{ id: 'old-model', name: 'old-model' }],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: 'custom-old/old-model',
            fallbacks: ['custom-live/gpt-5.4', 'custom-missing/nope'],
          },
        },
        list: [
          {
            id: 'stale-agent',
            model: 'custom-old/old-model',
          },
          {
            id: 'live-agent',
            model: 'custom-live/gpt-5.4',
          },
        ],
      },
    });

    await service.replaceAll({
      'custom-live': {
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        models: [
          { modelId: 'gpt-5.4' },
        ],
      },
    }, ['custom-live/gpt-5.4']);

    const agents = readConfig().agents as any;
    expect(agents.defaults.model).toEqual({
      primary: 'custom-live/gpt-5.4',
    });
    expect(agents.list).toEqual([
      { id: 'stale-agent' },
      { id: 'live-agent', model: 'custom-live/gpt-5.4' },
    ]);
  });

  it('only updates provider nodes explicitly owned by the provider model catalog', async () => {
    const { service, readConfig } = createService({
      models: {
        providers: {
          'custom-old12345': {
            models: [{ id: 'stale', name: 'stale' }],
          },
        },
      },
    });

    await service.replaceAll({});

    expect((readConfig().models as any).providers).toEqual({
      'custom-old12345': {
        models: [{ id: 'stale', name: 'stale' }],
      },
    });
  });

  it('does not prune unrelated incomplete provider nodes', async () => {
    const { service, readConfig } = createService({
      models: {
        providers: {
          'custom-custome9': {},
          openai: {},
        },
      },
    });

    await service.replaceAll({});

    expect((readConfig().models as any).providers).toEqual({
      'custom-custome9': {},
      openai: {},
    });
  });
});
