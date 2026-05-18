import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractSessionIdFromTranscriptFileName,
  TokenUsageHistoryRepository,
} from '../../runtime-host/application/usage/token-usage-history';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';

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

  it('只解析 live transcript 和 reset 快照文件名', () => {
    expect(extractSessionIdFromTranscriptFileName('abc-123.jsonl')).toBe('abc-123');
    expect(extractSessionIdFromTranscriptFileName('abc-123.jsonl.reset.2026-03-09T03-01-29.968Z')).toBe('abc-123');
    expect(extractSessionIdFromTranscriptFileName('abc-123.deleted.jsonl')).toBeUndefined();
    expect(extractSessionIdFromTranscriptFileName('abc-123.deleted.jsonl.reset.2026-03-09T03-01-29.968Z')).toBeUndefined();
  });

  it('会扫描磁盘上的 agent 目录并读取 live/reset transcript', async () => {
    await writeFile(join(configDir, 'openclaw.json'), JSON.stringify({
      agents: {
        list: [{ id: 'main', name: 'Main' }],
      },
    }, null, 2), 'utf8');

    const diskOnlySessionsDir = join(configDir, 'agents', 'custom-custom25', 'sessions');
    await mkdir(diskOnlySessionsDir, { recursive: true });
    await writeFile(
      join(diskOnlySessionsDir, 'f8e66f77-0125-4e2f-b750-9c4de01e8f5a.jsonl.reset.2026-03-09T03-01-29.968Z'),
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

    const repository = new TokenUsageHistoryRepository({
      configRepository: {
        getConfigDir: () => configDir,
        read: async () => ({}),
        write: async () => {},
        update: async (mutate) => await mutate({}),
        getConfigFilePath: () => join(configDir, 'openclaw.json'),
        getOpenClawDirPath: () => '',
      },
      fileSystem: createTestRuntimeFileSystem(),
    });
    const entries = await repository.scanRecent();

    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: 'custom-custom25',
        sessionId: 'f8e66f77-0125-4e2f-b750-9c4de01e8f5a',
        model: 'gpt-5.2-2025-12-11',
        totalTokens: 17756,
      }),
    ]));
  });

  it('recent 只读取缓存快照，refreshCache 才扫描磁盘', async () => {
    await writeFile(join(configDir, 'openclaw.json'), JSON.stringify({
      agents: {
        list: [{ id: 'main', name: 'Main' }],
      },
    }, null, 2), 'utf8');
    const sessionsDir = join(configDir, 'agents', 'main', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, 'session-1.jsonl'),
      `${JSON.stringify({
        type: 'message',
        timestamp: '2026-03-12T12:19:00.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-5.2-2025-12-11',
          provider: 'openai',
          usage: {
            input: 1,
            output: 2,
            total: 3,
          },
        },
      })}\n`,
      'utf8',
    );

    const repository = new TokenUsageHistoryRepository({
      configRepository: {
        getConfigDir: () => configDir,
        read: async () => ({}),
        write: async () => {},
        update: async (mutate) => await mutate({}),
        getConfigFilePath: () => join(configDir, 'openclaw.json'),
        getOpenClawDirPath: () => '',
      },
      fileSystem: createTestRuntimeFileSystem(),
    });

    expect(repository.recent()).toEqual([]);
    await repository.refreshCache();
    expect(repository.recent()).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        totalTokens: 3,
      }),
    ]);
  });
});
