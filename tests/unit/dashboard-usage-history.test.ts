import { describe, expect, it } from 'vitest';
import {
  filterUsageHistoryByWindow,
  groupUsageHistory,
  type UsageHistoryEntry,
} from '@/pages/Dashboard/usage-history';

function createEntry(day: number, totalTokens: number): UsageHistoryEntry {
  return {
    timestamp: `2026-03-${String(day).padStart(2, '0')}T12:00:00.000Z`,
    sessionId: `session-${day}`,
    agentId: 'main',
    model: 'gpt-5',
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
  };
}

describe('dashboard usage history helpers', () => {
  it('按日期分组时保留完整时间桶，不截断为前 8 项', () => {
    const entries = Array.from({ length: 12 }, (_, index) => createEntry(index + 1, index + 1));

    const groups = groupUsageHistory(entries, 'day');

    expect(groups).toHaveLength(12);
    expect(groups[0]?.totalTokens).toBe(1);
    expect(groups[11]?.totalTokens).toBe(12);
  });

  it('按模型分组时只保留 totalTokens 前 8 项', () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      ...createEntry(index + 1, index + 1),
      model: `model-${index + 1}`,
    }));

    const groups = groupUsageHistory(entries, 'model');

    expect(groups).toHaveLength(8);
    expect(groups[0]?.label).toBe('model-10');
    expect(groups[7]?.label).toBe('model-3');
  });

  it('窗口过滤使用相对滚动 30 天，而不是自然月边界', () => {
    const now = Date.parse('2026-03-12T12:00:00.000Z');
    const entries = [
      {
        ...createEntry(12, 12),
        timestamp: '2026-03-12T12:00:00.000Z',
      },
      {
        ...createEntry(11, 11),
        timestamp: '2026-02-11T12:00:00.000Z',
      },
      {
        ...createEntry(10, 10),
        timestamp: '2026-02-10T11:59:59.000Z',
      },
    ];

    const filtered = filterUsageHistoryByWindow(entries, '30d', now);

    expect(filtered).toHaveLength(2);
    expect(filtered.map((entry) => entry.totalTokens)).toEqual([12, 11]);
  });
});
