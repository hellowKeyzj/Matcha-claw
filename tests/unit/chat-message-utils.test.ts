import { describe, expect, it, vi } from 'vitest';
import { formatTimestamp } from '@/pages/Chat/message-utils';

describe('chat message utils', () => {
  it('returns empty string for invalid timestamp values', () => {
    expect(formatTimestamp(undefined)).toBe('');
    expect(formatTimestamp('not-a-number')).toBe('');
  });

  it('formats old timestamps as local clock time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-04T12:00:00.000Z'));

    expect(formatTimestamp(Date.parse('2026-05-02T09:30:00.000Z'))).toMatch(/\d{1,2}:\d{2}/);

    vi.useRealTimers();
  });
});
