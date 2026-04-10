import { describe, expect, it } from 'vitest';
import { parseUsageEntriesFromJsonl } from '../../runtime-host/application/usage/token-usage-parser';

describe('token usage parser', () => {
  it('解析 assistant usage（camelCase）', () => {
    const jsonl = `${JSON.stringify({
      timestamp: '2026-04-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        model: 'gpt-5.4',
        provider: 'openai',
        usage: {
          input: 10,
          output: 4,
          cacheRead: 2,
          total: 16,
          cost: { total: 0.12 },
        },
      },
    })}\n`;

    expect(parseUsageEntriesFromJsonl(jsonl, { sessionId: 's1', agentId: 'a1' })).toEqual([
      {
        timestamp: '2026-04-01T00:00:00.000Z',
        sessionId: 's1',
        agentId: 'a1',
        model: 'gpt-5.4',
        provider: 'openai',
        usageStatus: 'available',
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        totalTokens: 16,
        costUsd: 0.12,
      },
    ]);
  });

  it('显式零 token 也保留记录', () => {
    const jsonl = `${JSON.stringify({
      timestamp: '2026-04-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        usage: {
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    })}\n`;

    expect(parseUsageEntriesFromJsonl(jsonl, { sessionId: 's1', agentId: 'a1' })).toEqual([
      expect.objectContaining({
        usageStatus: 'available',
        totalTokens: 0,
      }),
    ]);
  });

  it('支持 snake_case 与 *_token_count 字段', () => {
    const jsonl = `${JSON.stringify({
      timestamp: '2026-04-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        usage: {
          input_token_count: 11,
          output_tokens: 5,
          cache_write_token_count: 3,
        },
      },
    })}\n`;

    expect(parseUsageEntriesFromJsonl(jsonl, { sessionId: 's1', agentId: 'a1' })).toEqual([
      expect.objectContaining({
        usageStatus: 'available',
        inputTokens: 11,
        outputTokens: 5,
        cacheWriteTokens: 3,
        totalTokens: 19,
      }),
    ]);
  });

  it('usage 对象无可识别字段时标记 missing', () => {
    const jsonl = `${JSON.stringify({
      timestamp: '2026-04-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        usage: { note: 'n/a' },
      },
    })}\n`;

    expect(parseUsageEntriesFromJsonl(jsonl, { sessionId: 's1', agentId: 'a1' })).toEqual([
      expect.objectContaining({
        usageStatus: 'missing',
        totalTokens: 0,
      }),
    ]);
  });

  it('usage 结构非法时标记 error', () => {
    const jsonl = `${JSON.stringify({
      timestamp: '2026-04-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        usage: 'invalid',
      },
    })}\n`;

    expect(parseUsageEntriesFromJsonl(jsonl, { sessionId: 's1', agentId: 'a1' })).toEqual([
      expect.objectContaining({
        usageStatus: 'error',
        totalTokens: 0,
      }),
    ]);
  });

  it('支持 tool_result.details.usage', () => {
    const jsonl = `${JSON.stringify({
      timestamp: '2026-04-01T00:00:00.000Z',
      message: {
        role: 'tool_result',
        details: {
          provider: 'openai',
          model: 'gpt-5.4',
          usage: {
            input_tokens: 7,
            output_tokens: 9,
          },
        },
      },
    })}\n`;

    expect(parseUsageEntriesFromJsonl(jsonl, { sessionId: 's1', agentId: 'a1' })).toEqual([
      expect.objectContaining({
        usageStatus: 'available',
        inputTokens: 7,
        outputTokens: 9,
        totalTokens: 16,
        provider: 'openai',
        model: 'gpt-5.4',
      }),
    ]);
  });
});
