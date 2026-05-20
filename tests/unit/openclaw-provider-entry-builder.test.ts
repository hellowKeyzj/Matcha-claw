import { describe, expect, it } from 'vitest';
import {
  upsertOpenClawProviderEntry,
} from '../../runtime-host/application/openclaw/openclaw-provider-entry-builder';

describe('openclaw provider entry builder', () => {
  it('updates provider transport fields without owning models[]', () => {
    const config: Record<string, unknown> = {
      models: {
        providers: {
          custom: {
            baseUrl: 'https://old.example.com/v1',
            api: 'openai-completions',
            models: [{ id: 'existing-model', name: 'existing-model' }],
          },
        },
      },
    };

    upsertOpenClawProviderEntry(config, 'custom', {
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-responses',
      headers: { 'x-foo': 'bar' },
    });

    expect(((config.models as Record<string, any>).providers as Record<string, any>).custom).toEqual({
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-responses',
      headers: { 'x-foo': 'bar' },
      models: [{ id: 'existing-model', name: 'existing-model' }],
    });
  });

  it('writes OpenRouter through the OpenAI-compatible runtime protocol', () => {
    const config: Record<string, unknown> = {};

    upsertOpenClawProviderEntry(config, 'openrouter', {
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openai-completions',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      headers: {
        'HTTP-Referer': 'https://matchaclaw-x.com',
      },
    });

    expect(((config.models as Record<string, any>).providers as Record<string, any>).openrouter).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openai-completions',
      apiKey: 'OPENROUTER_API_KEY',
      headers: {
        'HTTP-Referer': 'https://matchaclaw-x.com',
      },
    });
  });
});
