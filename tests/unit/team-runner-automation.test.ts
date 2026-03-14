import { describe, expect, it } from 'vitest';
import {
  deriveAutoBlockedDecision,
  deriveTaskTitleFromProposal,
  parseBlockedDecision,
} from '@/features/teams/domain/runner-automation';

describe('team runner automation helpers', () => {
  it('parses retry/fail decisions from plain text and json', () => {
    expect(parseBlockedDecision('请重试这个任务')).toBe('retry');
    expect(parseBlockedDecision('建议 cancel 当前任务')).toBe('fail');
    expect(parseBlockedDecision('{"decision":"retry"}')).toBe('retry');
    expect(parseBlockedDecision('{"decision":"fail"}')).toBe('fail');
    expect(parseBlockedDecision('unknown decision')).toBeNull();
  });

  it('derives auto decision by attempt count', () => {
    expect(deriveAutoBlockedDecision({ attempt: 0, error: 'e1' }).action).toBe('retry');
    expect(deriveAutoBlockedDecision({ attempt: 1, error: 'e2' }).action).toBe('retry');
    expect(deriveAutoBlockedDecision({ attempt: 2, error: 'e3' }).action).toBe('fail');
  });

  it('derives concise task title from proposal text', () => {
    expect(deriveTaskTitleFromProposal('')).toBe('自动规划任务');
    expect(deriveTaskTitleFromProposal('短标题')).toBe('短标题');
    expect(deriveTaskTitleFromProposal('这是一个非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长的标题')).toMatch(/\.\.\.$/);
  });
});
