import { describe, it, expect } from 'vitest';
import { buildTeamSessionKey, filterMissingAgents } from '@/lib/team/binding';

describe('team binding', () => {
  it('builds team session key', () => {
    expect(buildTeamSessionKey('a1', 't1')).toBe('agent:a1:team:t1');
  });

  it('filters missing agents', () => {
    const missing = filterMissingAgents(['a1', 'a2'], ['a1']);
    expect(missing).toEqual(['a2']);
  });
});
