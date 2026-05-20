import { describe, expect, it } from 'vitest';
import { OpenClawProviderModelsService } from '../../runtime-host/application/openclaw/openclaw-provider-models-service';

function createService(initialConfig: Record<string, unknown>) {
  let config = structuredClone(initialConfig);
  const service = new OpenClawProviderModelsService({
    read: async () => structuredClone(config),
    write: async (next) => {
      config = structuredClone(next);
    },
    update: async () => undefined as never,
    getConfigDir: () => '',
    getConfigFilePath: () => '',
    getOpenClawDirPath: () => '',
  });
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
        },
      ],
    });
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
