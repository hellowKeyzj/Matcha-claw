import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractSessionIdFromTranscriptFileName,
  getRecentTokenUsageHistory,
} from '../../runtime-host/application/usage/token-usage-history';

describe('token usage history scan', () => {
  let configDir = '';

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'matchaclaw-token-usage-'));
  });

  afterEach(async () => {
    if (configDir) {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('支持解析 deleted+reset transcript 文件名', () => {
    expect(extractSessionIdFromTranscriptFileName('abc-123.deleted.jsonl.reset.2026-03-09T03-01-29.968Z')).toBe('abc-123');
    expect(extractSessionIdFromTranscriptFileName('abc-123.deleted.jsonl')).toBe('abc-123');
  });

  it('会扫描磁盘上的 agent 目录并读取 deleted/reset transcript', async () => {
    await writeFile(join(configDir, 'openclaw.json'), JSON.stringify({
      agents: {
        list: [{ id: 'main', name: 'Main' }],
      },
    }, null, 2), 'utf8');

    const diskOnlySessionsDir = join(configDir, 'agents', 'custom-custom25', 'sessions');
    await mkdir(diskOnlySessionsDir, { recursive: true });
    await writeFile(
      join(diskOnlySessionsDir, 'f8e66f77-0125-4e2f-b750-9c4de01e8f5a.deleted.jsonl.reset.2026-03-09T03-01-29.968Z'),
      `${JSON.stringify({
        type: 'message',
        timestamp: '2026-03-12T12:19:00.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-5.2-2025-12-11',
          provider: 'openai',
          usage: {
            input: 17649,
            output: 107,
            total: 17756,
          },
        },
      })}\n`,
      'utf8',
    );

    const entries = await getRecentTokenUsageHistory({
      openclawConfigDir: configDir,
    });

    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: 'custom-custom25',
        sessionId: 'f8e66f77-0125-4e2f-b750-9c4de01e8f5a',
        model: 'gpt-5.2-2025-12-11',
        totalTokens: 17756,
      }),
    ]));
  });
});
