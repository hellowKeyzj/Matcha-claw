import { describe, expect, it } from 'vitest';
import { readHistoryLoadPipelineStrategyKeyFromSettings } from '@/stores/chat/history-pipeline-settings';

describe('chat history pipeline settings reader', () => {
  it('returns null when setting is missing', () => {
    const key = readHistoryLoadPipelineStrategyKeyFromSettings({
      getSettings: () => ({}),
    });
    expect(key).toBeNull();
  });

  it('returns trimmed key when setting is present', () => {
    const key = readHistoryLoadPipelineStrategyKeyFromSettings({
      getSettings: () => ({
        chatHistoryPipelineStrategyKey: '  quiet_only  ',
      }),
    });
    expect(key).toBe('quiet_only');
  });

  it('returns null when setting is blank', () => {
    const key = readHistoryLoadPipelineStrategyKeyFromSettings({
      getSettings: () => ({
        chatHistoryPipelineStrategyKey: '   ',
      }),
    });
    expect(key).toBeNull();
  });
});

