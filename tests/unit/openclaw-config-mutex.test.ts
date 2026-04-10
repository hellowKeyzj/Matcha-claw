import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathStorage from '../../runtime-host/api/storage/paths';
import { saveChannelConfigLocal } from '../../runtime-host/application/channels/channel-runtime';
import { withOpenClawConfigLock } from '../../runtime-host/application/openclaw/openclaw-config-mutex';
import { updateSkillConfigLocal } from '../../runtime-host/application/skills/store';

describe('openclaw-config-mutex', () => {
  let tempDir = '';
  let previousConfigDir: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-openclaw-lock-'));
    previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    process.env.OPENCLAW_CONFIG_DIR = tempDir;
    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        channels: {
          telegram: {
            defaultAccount: 'default',
            accounts: {
              default: { token: 'old-token' },
            },
          },
        },
      }, null, 2)}\n`,
      'utf8',
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousConfigDir === undefined) {
      delete process.env.OPENCLAW_CONFIG_DIR;
    } else {
      process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('支持可重入调用，不会在嵌套调用中死锁', async () => {
    const events: string[] = [];

    await withOpenClawConfigLock(async () => {
      events.push('outer:start');
      await withOpenClawConfigLock(async () => {
        events.push('inner:run');
      });
      events.push('outer:end');
    });

    expect(events).toEqual(['outer:start', 'inner:run', 'outer:end']);
  });

  it('会串行化跨模块的 openclaw.json 写入，避免并发覆盖', async () => {
    const originalWrite = pathStorage.writeOpenClawConfigJson;
    let writeStartedCount = 0;
    let resolveFirstWriteStarted: () => void = () => {};
    let releaseFirstWrite: () => void = () => {};

    const firstWriteStarted = new Promise<void>((resolve) => {
      resolveFirstWriteStarted = resolve;
    });
    const allowFirstWriteComplete = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    const writeSpy = vi.spyOn(pathStorage, 'writeOpenClawConfigJson').mockImplementation(async (config) => {
      writeStartedCount += 1;
      if (writeStartedCount === 1) {
        resolveFirstWriteStarted();
        await allowFirstWriteComplete;
      }
      await originalWrite(config);
    });

    const channelSavePromise = saveChannelConfigLocal({
      channelType: 'telegram',
      accountId: 'default',
      config: { token: 'new-token' },
      enabled: true,
    });

    await firstWriteStarted;

    const skillSavePromise = updateSkillConfigLocal('tavily-search', { apiKey: 'skill-key' });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writeStartedCount).toBe(1);

    releaseFirstWrite();
    const [, skillResult] = await Promise.all([channelSavePromise, skillSavePromise]);
    expect(skillResult).toEqual({ success: true });

    const finalConfig = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(finalConfig.channels.telegram.accounts.default.token).toBe('new-token');
    expect(finalConfig.skills.entries['tavily-search'].apiKey).toBe('skill-key');
    expect(finalConfig.channels.telegram.accounts.default.enabled).toBe(true);
    expect(typeof finalConfig.channels.telegram.accounts.default.updatedAt).toBe('string');
    writeSpy.mockRestore();
  });
});
