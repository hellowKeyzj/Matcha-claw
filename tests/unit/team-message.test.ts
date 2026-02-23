import { describe, it, expect } from 'vitest';
import { detectTeamMessageKind } from '@/lib/team/message';

describe('team message kind', () => {
  it('detects REPORT blocks', () => {
    expect(detectTeamMessageKind('REPORT: {"status":"done"}')).toBe('report');
  });

  it('detects PLAN blocks', () => {
    expect(detectTeamMessageKind('PLAN:\n- step1')).toBe('plan');
  });

  it('defaults to normal', () => {
    expect(detectTeamMessageKind('hello')).toBe('normal');
  });
});
