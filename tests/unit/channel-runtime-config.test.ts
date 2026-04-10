import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listConfiguredChannelsLocal, saveChannelConfigLocal } from '../../runtime-host/application/channels/channel-runtime';

describe('channel-runtime config save', () => {
  let tempDir = '';
  let previousConfigDir: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-channel-config-'));
    previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    process.env.OPENCLAW_CONFIG_DIR = tempDir;
    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        plugins: {
          allow: ['feishu', 'feishu-openclaw-plugin', 'wecom-openclaw-plugin'],
          entries: {
            feishu: { enabled: true },
            'feishu-openclaw-plugin': { enabled: true },
            'wecom-openclaw-plugin': { enabled: true, legacy: true },
          },
        },
        channels: {
          feishu: {
            accounts: {
              acc1: {
                appId: 'cli_legacy',
                appSecret: 'legacy-secret',
                enabled: true,
              },
            },
          },
        },
      }, null, 2)}\n`,
      'utf8',
    );
  });

  afterEach(async () => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCLAW_CONFIG_DIR;
    } else {
      process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('保存 Feishu 配置时会迁移到 openclaw-lark 并禁用旧 feishu entry', async () => {
    await saveChannelConfigLocal({
      channelType: 'feishu',
      accountId: 'acc2',
      config: {
        appId: 'cli_new',
        appSecret: 'new-secret',
      },
      enabled: true,
    });

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(config.plugins.allow).toContain('openclaw-lark');
    expect(config.plugins.allow).not.toContain('feishu');
    expect(config.plugins.allow).not.toContain('feishu-openclaw-plugin');
    expect(config.plugins.entries['openclaw-lark']).toBeDefined();
    expect(config.plugins.entries.feishu?.enabled).toBe(false);
  });

  it('同一频道下不同账号禁止复用唯一凭证', async () => {
    await expect(saveChannelConfigLocal({
      channelType: 'feishu',
      accountId: 'acc2',
      config: {
        appId: 'cli_legacy',
        appSecret: 'another-secret',
      },
      enabled: true,
    })).rejects.toThrow('already bound to another agent');
  });

  it('保存 WeCom 配置时会迁移到 wecom 插件 ID 并启用 entries.wecom', async () => {
    await saveChannelConfigLocal({
      channelType: 'wecom',
      accountId: 'acc1',
      config: {
        botId: 'wecom-bot',
        secret: 'secret-1',
      },
      enabled: true,
    });

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(config.plugins.allow).toContain('wecom');
    expect(config.plugins.allow).not.toContain('wecom-openclaw-plugin');
    expect(config.plugins.entries.wecom).toBeDefined();
    expect(config.plugins.entries.wecom.enabled).toBe(true);
    expect(config.plugins.entries['wecom-openclaw-plugin']).toBeUndefined();
  });

  it('保存 QQBot 配置时会迁移到 openclaw-qqbot 插件 ID', async () => {
    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        plugins: {
          allow: ['qqbot'],
          entries: {
            qqbot: { enabled: true, legacy: true },
          },
        },
        channels: {},
      }, null, 2)}\n`,
      'utf8',
    );

    await saveChannelConfigLocal({
      channelType: 'qqbot',
      accountId: 'acc1',
      config: {
        appId: 'qq-app-id',
        clientSecret: 'qq-secret',
      },
      enabled: true,
    });

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(config.plugins.allow).toContain('openclaw-qqbot');
    expect(config.plugins.allow).not.toContain('qqbot');
    expect(config.plugins.entries['openclaw-qqbot']).toBeDefined();
    expect(config.plugins.entries['openclaw-qqbot'].enabled).toBe(true);
    expect(config.plugins.entries.qqbot).toBeUndefined();
  });

  it('plugins.allow 仅配置 openclaw-qqbot 时仍识别为已配置频道', async () => {
    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        plugins: {
          allow: ['openclaw-qqbot'],
          entries: {
            'openclaw-qqbot': { enabled: true },
          },
        },
        channels: {},
      }, null, 2)}\n`,
      'utf8',
    );

    const channels = await listConfiguredChannelsLocal();
    expect(channels).toContain('qqbot');
  });

  it('内置频道保存配置时会在存在外部插件时补齐 built-in allowlist', async () => {
    await saveChannelConfigLocal({
      channelType: 'telegram',
      accountId: 'default',
      config: {
        botToken: 'token-1',
      },
      enabled: true,
    });

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(Array.isArray(config.plugins.allow)).toBe(true);
    expect(config.plugins.allow).toContain('telegram');
  });

  it('保存 whatsapp 配置时会清理 legacy plugins.entries.whatsapp', async () => {
    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        plugins: {
          allow: ['whatsapp'],
          entries: {
            whatsapp: { enabled: true },
          },
        },
        channels: {},
      }, null, 2)}\n`,
      'utf8',
    );

    await saveChannelConfigLocal({
      channelType: 'whatsapp',
      accountId: 'default',
      config: {
        phoneNumber: '+861234567890',
      },
      enabled: true,
    });

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(config.plugins).toBeUndefined();
  });
});
