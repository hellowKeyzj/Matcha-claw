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

  it('uses wider line budget for CJK text to avoid under-estimation', () => {
    const latin = 'a'.repeat(300);
    const cjk = '你'.repeat(300);

    const latinHeight = estimateMessageRowHeight(latin);
    const cjkHeight = estimateMessageRowHeight(cjk);
    expect(cjkHeight).toBeGreaterThan(latinHeight);
  });

  it('allows very long markdown rows to estimate beyond legacy hard cap', () => {
    const longList = Array.from({ length: 40 }, (_, index) => (
      `${index + 1}. 这是一个很长的中文列表项，用来模拟真实聊天里的大段结构化内容和换行开销`
    )).join('\n');

    const height = estimateMessageRowHeight(longList);
    expect(height).toBeGreaterThan(1000);
  });
});
