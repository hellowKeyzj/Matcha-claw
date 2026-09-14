import { describe, expect, it } from 'vitest';
import { SUBAGENT_TARGET_FILES } from '@/constants/subagent-files';

describe('subagent target files', () => {
  it('should only include the 4 editable md files', () => {
    expect(SUBAGENT_TARGET_FILES).toEqual([
      'AGENTS.md',
      'SOUL.md',
      'USER.md',
      'MEMORY.md',
    ]);
  });
});
