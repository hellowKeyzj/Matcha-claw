import { describe, expect, it } from 'vitest';
import { buildCronSessionFallbackMessages } from '@electron/api/routes/cron';

describe('cron session fallback messages', () => {
  it('prefers recovered summary over prompt-echo summary', () => {
    const messages = buildCronSessionFallbackMessages({
      sessionKey: 'agent:main:cron:job-1',
      job: {
        name: 'github今日热门项目',
        payload: {
          kind: 'agentTurn',
          message: '请直接返回今天 GitHub 热门项目 Top 10（项目名、链接、stars）。',
        },
        state: {},
      },
      runs: [
        {
          jobId: 'job-1',
          action: 'finished',
          status: 'ok',
          summary: '请直接返回今天 GitHub 热门项目 Top 10（项目名、链接、stars）。',
          recoveredSummary: '1. microsoft/BitNet\n2. obra/superpowers',
          ts: 1773419252443,
          runAtMs: 1773419219786,
          durationMs: 32655,
        },
      ],
      limit: 200,
    });

    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toContain('microsoft/BitNet');
    expect(messages[1].content).not.toContain('请直接返回今天 GitHub 热门项目 Top 10');
    expect(messages[1].content).toContain('Duration: 33s');
  });

  it('keeps real summary when it is not a prompt echo', () => {
    const messages = buildCronSessionFallbackMessages({
      sessionKey: 'agent:main:cron:job-2',
      job: {
        name: 'github今日热门项目',
        payload: {
          kind: 'agentTurn',
          message: '请直接返回今天 GitHub 热门项目 Top 10（项目名、链接、stars）。',
        },
        state: {},
      },
      runs: [
        {
          jobId: 'job-2',
          action: 'finished',
          status: 'ok',
          summary: 'Top 10: microsoft/BitNet, obra/superpowers, promptfoo/promptfoo',
          ts: 1773419252443,
          runAtMs: 1773419219786,
          durationMs: 14600,
        },
      ],
      limit: 200,
    });

    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain('Top 10: microsoft/BitNet');
  });
});
