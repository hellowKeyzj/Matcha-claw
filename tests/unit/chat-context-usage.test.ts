import { describe, expect, it } from 'vitest';
import { buildChatContextUsageViewModel, formatTokensCompact } from '../../src/pages/Chat/context-usage';
import type { ModelCatalogEntry } from '../../src/types/subagent';

const models: ModelCatalogEntry[] = [
  {
    id: 'claude-sonnet',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    modelLabel: 'Claude Sonnet',
    displayLabel: 'Anthropic · Claude Sonnet',
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
];

describe('buildChatContextUsageViewModel', () => {
  it('hides explicitly stale totalTokens', () => {
    expect(buildChatContextUsageViewModel({
      snapshot: { totalTokens: 10_000, totalTokensFresh: false, contextTokens: 200_000 },
      currentModelId: 'claude-sonnet',
      availableModels: models,
    })).toBeNull();
  });

  it('shows legacy unknown freshness when token counts are valid', () => {
    expect(buildChatContextUsageViewModel({
      snapshot: { totalTokens: 50_000, contextTokens: 200_000 },
      currentModelId: 'claude-sonnet',
      availableModels: models,
    })).toEqual({
      usedTokens: 50_000,
      limitTokens: 200_000,
      pct: 25,
      detail: '50k / 200k',
      level: 'neutral',
    });
  });

  it('uses model contextWindow when row contextTokens is missing', () => {
    expect(buildChatContextUsageViewModel({
      snapshot: { totalTokens: 20_000, totalTokensFresh: true },
      currentModelId: 'claude-sonnet',
      availableModels: models,
    })).toMatchObject({
      usedTokens: 20_000,
      limitTokens: 200_000,
      pct: 10,
    });
  });

  it('does not use maxTokens as a context limit', () => {
    expect(buildChatContextUsageViewModel({
      snapshot: { totalTokens: 2_000, totalTokensFresh: true },
      currentModelId: 'max-only',
      availableModels: [{
        id: 'max-only',
        provider: 'anthropic',
        providerLabel: 'Anthropic',
        modelLabel: 'Max Only',
        displayLabel: 'Anthropic · Max Only',
        maxTokens: 8_192,
      }],
    })).toBeNull();
  });

  it('classifies warning and danger levels from usage ratio', () => {
    expect(buildChatContextUsageViewModel({
      snapshot: { totalTokens: 170_000, contextTokens: 200_000 },
      currentModelId: null,
      availableModels: [],
    })?.level).toBe('warning');

    expect(buildChatContextUsageViewModel({
      snapshot: { totalTokens: 190_000, contextTokens: 200_000 },
      currentModelId: null,
      availableModels: [],
    })?.level).toBe('danger');
  });

  it('requires a non-negative totalTokens value from the session snapshot', () => {
    expect(buildChatContextUsageViewModel({
      snapshot: { totalTokens: 0, contextTokens: 200_000 },
      currentModelId: 'claude-sonnet',
      availableModels: models,
    })).toMatchObject({
      usedTokens: 0,
      pct: 0,
      level: 'neutral',
    });

    expect(buildChatContextUsageViewModel({
      snapshot: { totalTokens: -1, contextTokens: 200_000 },
      currentModelId: 'claude-sonnet',
      availableModels: models,
    })).toBeNull();
  });
});

describe('formatTokensCompact', () => {
  it('formats compact token counts', () => {
    expect(formatTokensCompact(999)).toBe('999');
    expect(formatTokensCompact(1_000)).toBe('1k');
    expect(formatTokensCompact(12_500)).toBe('12.5k');
    expect(formatTokensCompact(1_000_000)).toBe('1M');
  });
});
