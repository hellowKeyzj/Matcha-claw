import { describe, expect, it } from 'vitest';
import { OpenClawCustomMediaPluginConfigService } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-custom-media-plugin-config-service';
import { OpenClawCustomMediaPluginConfigWorkflow } from '../../runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-custom-media-plugin-config-workflow';

function createService(initialConfig: Record<string, unknown>) {
  let config = structuredClone(initialConfig);
  let writeCount = 0;
  const service = new OpenClawCustomMediaPluginConfigService(new OpenClawCustomMediaPluginConfigWorkflow({
    read: async () => structuredClone(config),
    write: async (next) => {
      writeCount += 1;
      config = structuredClone(next);
    },
    updateDirty: async (mutate) => {
      const next = structuredClone(config);
      const update = await mutate(next);
      if (update.changed) {
        writeCount += 1;
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
    writeCount: () => writeCount,
  };
}

describe('OpenClawCustomMediaPluginConfigService', () => {
  it('writes custom media providers without API keys to the MatchaClaw media plugin config', async () => {
    const { service, readConfig } = createService({});

    await service.replaceAll({
      'custom-592a8424': {
        label: 'pic2api',
        baseUrl: 'http://pic2api.com/v1beta',
        apiProtocol: 'google',
        models: [
          {
            modelId: 'gemini-2.5-flash-image',
            capabilities: ['imageGenerate'],
            timeoutMs: 90_000,
            aspectRatio: '16:9',
            resolution: '2K',
            quality: 'high',
          },
        ],
      },
    });

    expect((readConfig().plugins as any).allow).toContain('matchaclaw-media');
    expect((readConfig().plugins as any).entries['matchaclaw-media']).toEqual({
      enabled: true,
      config: {
        providers: {
          'custom-592a8424': {
            label: 'pic2api',
            baseUrl: 'http://pic2api.com/v1beta',
            apiProtocol: 'google',
            models: [
              {
                id: 'gemini-2.5-flash-image',
                capabilities: ['imageGenerate'],
                timeoutMs: 90_000,
                aspectRatio: '16:9',
                resolution: '2K',
                quality: 'high',
              },
            ],
          },
        },
      },
    });
  });

  it('removes stale inline API keys from custom media plugin config', async () => {
    const { service, readConfig } = createService({
      plugins: {
        entries: {
          'matchaclaw-media': {
            config: {
              providers: {
                'custom-592a8424': {
                  baseUrl: 'http://pic2api.com/v1beta',
                  apiKey: 'stale-key',
                  apiProtocol: 'google',
                  models: [{ id: 'gemini-2.5-flash-image', capabilities: ['imageGenerate'] }],
                },
              },
            },
          },
        },
      },
    });

    await service.replaceAll({
      'custom-592a8424': {
        baseUrl: 'http://pic2api.com/v1beta',
        apiProtocol: 'google',
        models: [{ modelId: 'gemini-2.5-flash-image', capabilities: ['imageGenerate'] }],
      },
    });

    expect((readConfig().plugins as any).entries['matchaclaw-media'].config.providers['custom-592a8424']).not.toHaveProperty('apiKey');
  });

  it('does not rewrite openclaw config when custom media providers are unchanged', async () => {
    const providerMap = {
      'custom-592a8424': {
        label: 'pic2api',
        baseUrl: 'http://pic2api.com/v1beta',
        apiProtocol: 'google',
        models: [{ modelId: 'gemini-2.5-flash-image', capabilities: ['imageGenerate'], timeoutMs: 90_000 }],
      },
    };
    const { service, writeCount } = createService({
      plugins: {
        allow: ['matchaclaw-media'],
        entries: {
          'matchaclaw-media': {
            enabled: true,
            config: {
              providers: {
                'custom-592a8424': {
                  label: 'pic2api',
                  baseUrl: 'http://pic2api.com/v1beta',
                  apiProtocol: 'google',
                  models: [{ id: 'gemini-2.5-flash-image', capabilities: ['imageGenerate'], timeoutMs: 90_000 }],
                },
              },
            },
          },
        },
      },
    });

    await service.replaceAll(providerMap);

    expect(writeCount()).toBe(0);
  });

  it('reads model-level timeoutMs from custom media plugin config', async () => {
    const { service } = createService({
      plugins: {
        entries: {
          'matchaclaw-media': {
            config: {
              providers: {
                'custom-592a8424': {
                  baseUrl: 'http://pic2api.com/v1beta',
                  apiProtocol: 'google',
                  models: [
                    {
                      id: 'gemini-2.5-flash-image',
                      capabilities: ['imageGenerate'],
                      timeoutMs: 90_000,
                      aspectRatio: '16:9',
                      resolution: '2K',
                      quality: 'high',
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });

    await expect(service.readAll()).resolves.toEqual({
      'custom-592a8424': [
        {
          modelId: 'gemini-2.5-flash-image',
          capabilities: ['imageGenerate'],
          timeoutMs: 90_000,
          aspectRatio: '16:9',
          resolution: '2K',
          quality: 'high',
        },
      ],
    });
  });

  it('removes legacy models.providers nodes and rewrites legacy media routes', async () => {
    const { service, readConfig } = createService({
      models: {
        providers: {
          'custom-592a8424': {
            baseUrl: 'http://pic2api.com/v1beta',
            api: 'google-generative-ai',
            models: [{ id: 'gemini-2.5-flash-image' }],
          },
          'custom-chat': {
            baseUrl: 'https://api.example.com/v1',
            api: 'openai-completions',
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: 'custom-592a8424/gemini-2.5-flash-image',
            fallbacks: ['custom-chat/gpt-5.4'],
          },
        },
      },
    });

    await service.replaceAll({
      'custom-592a8424': {
        baseUrl: 'http://pic2api.com/v1beta',
        apiProtocol: 'google',
        models: [{ modelId: 'gemini-2.5-flash-image', capabilities: ['imageGenerate'] }],
      },
    });

    expect((readConfig().models as any).providers).toEqual({
      'custom-chat': {
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        models: [],
      },
    });
    expect((readConfig().agents as any).defaults.imageGenerationModel).toEqual({
      primary: 'matchaclaw-media/custom-592a8424/gemini-2.5-flash-image',
      fallbacks: ['custom-chat/gpt-5.4'],
    });
  });
});
