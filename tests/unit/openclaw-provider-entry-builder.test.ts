import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS,
  MINIMAX_M27_MAX_TOKENS,
} from '../../runtime-host/application/adapters/openclaw/projections/openclaw-anthropic-messages-max-tokens';
import {
  upsertOpenClawProviderEntry,
} from '../../runtime-host/application/adapters/openclaw/projections/openclaw-provider-entry-builder';

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

  it('pins OpenAI runtime providers to the embedded pi runtime', () => {
    const config: Record<string, unknown> = {};

    upsertOpenClawProviderEntry(config, 'openai-codex', {
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-codex-responses',
    });

    const entry = ((config.models as Record<string, any>).providers as Record<string, any>)['openai-codex'];
    expect(entry.agentRuntime).toEqual({ id: 'pi' });
  });

  it('adds MiniMax maxTokens defaults for anthropic-messages entries', () => {
    const config: Record<string, unknown> = {
      models: {
        providers: {
          'minimax-portal': {
            models: [{ id: 'MiniMax-M2.7', name: 'MiniMax-M2.7' }],
          },
        },
      },
    };

    upsertOpenClawProviderEntry(config, 'minimax-portal', {
      baseUrl: 'https://api.minimax.io/anthropic',
      api: 'anthropic-messages',
      apiKeyEnv: 'MINIMAX_API_KEY',
    });

    const entry = ((config.models as Record<string, any>).providers as Record<string, any>)['minimax-portal'];
    expect(entry.maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
    expect(entry.models[0].maxTokens).toBe(MINIMAX_M27_MAX_TOKENS);
  });

  it('adds generic maxTokens defaults for custom anthropic-messages entries', () => {
    const config: Record<string, unknown> = {
      models: {
        providers: {
          'custom-1': {
            models: [{ id: 'claude-proxy', name: 'claude-proxy', maxTokens: 12288 }],
          },
        },
      },
    };

    upsertOpenClawProviderEntry(config, 'custom-1', {
      baseUrl: 'https://api.example.com/anthropic',
      api: 'anthropic-messages',
    });

    const entry = ((config.models as Record<string, any>).providers as Record<string, any>)['custom-1'];
    expect(entry.maxTokens).toBe(ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS);
    expect(entry.models[0].maxTokens).toBe(12288);
  });
});
