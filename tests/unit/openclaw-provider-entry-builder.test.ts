import { describe, expect, it } from 'vitest';
import {
  buildNamedProviderModels,
  upsertOpenClawProviderEntry,
} from '../../runtime-host/application/openclaw/openclaw-provider-entry-builder';

describe('openclaw provider entry builder', () => {
  it('adds zero cost fields to named runtime models', () => {
    expect(buildNamedProviderModels(['model-a'])).toEqual([
      {
        id: 'model-a',
        name: 'model-a',
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    ]);
  });

  it('normalizes model cost when writing models.providers entries', () => {
    const config: Record<string, unknown> = {
      models: {
        providers: {
          custom: {
            baseUrl: 'https://old.example.com/v1',
            api: 'openai-completions',
            models: [
              {
                id: 'existing-model',
                name: 'existing-model',
                cost: {
                  input: 1.25,
                  output: Number.NaN,
                },
              },
            ],
          },
        },
      },
    };

    upsertOpenClawProviderEntry(config, 'custom', {
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      models: [{ id: 'new-model', name: 'new-model' }],
      mergeExistingModels: true,
    });

    const models = ((config.models as Record<string, unknown>).providers as Record<string, any>).custom.models;
    expect(models).toEqual([
      {
        id: 'existing-model',
        name: 'existing-model',
        cost: {
          input: 1.25,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      {
        id: 'new-model',
        name: 'new-model',
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    ]);
  });

  it('writes provider-specific runtime protocols such as openrouter unchanged', () => {
    const config: Record<string, unknown> = {};

    upsertOpenClawProviderEntry(config, 'openrouter', {
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openrouter',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      headers: {
        'HTTP-Referer': 'https://matchaclaw-x.com',
      },
    });

    expect(((config.models as Record<string, any>).providers as Record<string, any>).openrouter).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openrouter',
      apiKey: 'OPENROUTER_API_KEY',
      headers: {
        'HTTP-Referer': 'https://matchaclaw-x.com',
      },
    });
  });
});
