import { describe, expect, it } from 'vitest';
import { pruneProviderModelRefsInAgentsConfig } from '@electron/utils/openclaw-auth';

describe('openclaw auth model prune', () => {
  it('prunes provider model refs from agents.defaults and agents.list', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          model: {
            primary: 'custom-abc/gpt-5.4',
            fallbacks: ['openai/gpt-4.1-mini', 'custom-abc/gpt-5.3'],
          },
        },
        list: [
          {
            id: 'writer',
            model: 'custom-abc/gpt-5.4',
          },
          {
            id: 'reviewer',
            model: {
              primary: 'anthropic/claude-3-7-sonnet',
              fallbacks: ['custom-abc/gpt-5.3', 'openai/gpt-4.1-mini'],
            },
          },
        ],
      },
    };

    const changed = pruneProviderModelRefsInAgentsConfig(config, 'custom-abc');

    expect(changed).toBe(true);
    expect(config).toEqual({
      agents: {
        defaults: {
          model: {
            primary: 'openai/gpt-4.1-mini',
          },
        },
        list: [
          {
            id: 'writer',
          },
          {
            id: 'reviewer',
            model: {
              primary: 'anthropic/claude-3-7-sonnet',
              fallbacks: ['openai/gpt-4.1-mini'],
            },
          },
        ],
      },
    });
  });

  it('returns false when no refs match the provider', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          model: {
            primary: 'openai/gpt-4.1-mini',
            fallbacks: ['anthropic/claude-3-7-sonnet'],
          },
        },
        list: [
          {
            id: 'writer',
            model: 'openai/gpt-4.1-mini',
          },
        ],
      },
    };

    const changed = pruneProviderModelRefsInAgentsConfig(config, 'custom-abc');

    expect(changed).toBe(false);
    expect(config).toEqual({
      agents: {
        defaults: {
          model: {
            primary: 'openai/gpt-4.1-mini',
            fallbacks: ['anthropic/claude-3-7-sonnet'],
          },
        },
        list: [
          {
            id: 'writer',
            model: 'openai/gpt-4.1-mini',
          },
        ],
      },
    });
  });
});

