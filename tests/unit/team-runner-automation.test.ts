import { describe, expect, it } from 'vitest';
import {
  deriveAutoBlockedDecision,
  deriveTaskTitleFromProposal,
  parseBlockedDecision,
} from '@/lib/team/runner-automation';

describe('team runner automation rules', () => {
  it('parses explicit blocked decisions from JSON and text', () => {
    expect(parseBlockedDecision('{"decision":"resume"}')).toBe('retry');
    expect(parseBlockedDecision('please fail this task')).toBe('fail');
    expect(parseBlockedDecision('need more context')).toBeNull();
  });

  it('retries only low-attempt blocked tasks', () => {
    expect(deriveAutoBlockedDecision({ attempt: 1, error: 'timeout' })).toEqual({
      action: 'retry',
      reason: '自动仲裁：当前重试次数较低，先执行一次重试。',
    });
    expect(deriveAutoBlockedDecision({ attempt: 2, error: 'timeout' }).action).toBe('fail');
  });

  it('derives a bounded task title from a proposal', () => {
    expect(deriveTaskTitleFromProposal('Review the release plan\nwith details')).toBe('Review the release plan');
    expect(deriveTaskTitleFromProposal('')).toBe('自动规划任务');
    expect(deriveTaskTitleFromProposal('x'.repeat(40))).toHaveLength(35);
  });
});
