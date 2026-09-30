import { describe, expect, it } from 'vitest';
import { buildLineDiff } from '@/lib/line-diff';

describe('line diff', () => {
  it('builds line-level diff (add/remove/keep)', () => {
    const diff = buildLineDiff('line-1\nline-2', 'line-1\nline-3');
    expect(diff).toEqual([
      { type: 'keep', value: 'line-1' },
      { type: 'remove', value: 'line-2' },
      { type: 'add', value: 'line-3' },
    ]);
  });
});
