import { describe, expect, it } from 'vitest';
import { estimateMessageRowHeight } from '@/pages/Chat/useChatListCtl';

describe('chat virtual row height estimate', () => {
  it('raises estimate for multiline markdown list content', () => {
    const compactText = 'agents_list sessions_spawn allowlist subagent allowedAgents';
    const listText = [
      '- `agents_list`',
      '- `sessions_spawn`',
      '- `allowlist`',
      '- `subagent`',
      '- `allowedAgents`',
    ].join('\n');

    const compactHeight = estimateMessageRowHeight(compactText);
    const listHeight = estimateMessageRowHeight(listText);
    expect(listHeight).toBeGreaterThan(compactHeight);
  });

  it('raises estimate for fenced code blocks', () => {
    const plain = 'line 1\nline 2\nline 3';
    const withFence = [
      '```json',
      '{',
      '  "agents": ["main", "analysis"]',
      '}',
      '```',
    ].join('\n');

    const plainHeight = estimateMessageRowHeight(plain);
    const fencedHeight = estimateMessageRowHeight(withFence);
    expect(fencedHeight).toBeGreaterThan(plainHeight);
  });
});

