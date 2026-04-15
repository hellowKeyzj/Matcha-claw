import { describe, expect, it, vi } from 'vitest';
import {
  historyLoadPipelineStrategyRegistry,
  readHistoryLoadPipelineStrategyKey,
  resolveHistoryLoadPipelineStrategy,
  resolveHistoryLoadPipelineStrategyKey,
  HISTORY_LOAD_PIPELINE_STRATEGY_STORAGE_KEY,
} from '@/stores/chat/history-pipeline-strategies';

describe('chat history pipeline strategies', () => {
  it('resolves unknown key to default strategy key', () => {
    expect(resolveHistoryLoadPipelineStrategyKey('unknown')).toBe('default');
    expect(resolveHistoryLoadPipelineStrategyKey(null)).toBe('default');
  });

  it('supports shorthand aliases for stable strategy keys', () => {
    expect(resolveHistoryLoadPipelineStrategyKey('active')).toBe('active_only');
    expect(resolveHistoryLoadPipelineStrategyKey('quiet')).toBe('quiet_only');
    expect(resolveHistoryLoadPipelineStrategyKey('probe')).toBe('probe_only');
  });

  it('returns registry strategy function by resolved key', () => {
    const defaultStrategy = resolveHistoryLoadPipelineStrategy('not-found');
    const quietStrategy = resolveHistoryLoadPipelineStrategy('quiet_only');

    expect(defaultStrategy).toBe(historyLoadPipelineStrategyRegistry.default);
    expect(quietStrategy).toBe(historyLoadPipelineStrategyRegistry.quiet_only);
  });

  it('reads and trims strategy key from storage', () => {
    const storage = {
      getItem: vi.fn((key: string) => (key === HISTORY_LOAD_PIPELINE_STRATEGY_STORAGE_KEY ? '  quiet_only  ' : null)),
    };

    const key = readHistoryLoadPipelineStrategyKey({ storage });
    expect(key).toBe('quiet_only');
  });

  it('returns null when storage throws', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('storage blocked');
      }),
    };

    const key = readHistoryLoadPipelineStrategyKey({ storage });
    expect(key).toBeNull();
  });
});

