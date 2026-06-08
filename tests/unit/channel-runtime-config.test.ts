import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelConfigRepository, type ChannelPluginConfigProjectionPort, type ChannelPluginProvisionerPort } from '../../runtime-host/application/channels/channel-runtime';
import { ChannelConfigWorkflow } from '../../runtime-host/application/workflows/channel-runtime/channel-config-workflow';
import { OpenClawConfigRepository } from '../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-repository';
import { OpenClawChannelConfigProjection } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-channel-config-projection';
import {
  applyManuallyManagedPluginIdsToOpenClawConfig,
  readManuallyManagedPluginIdsFromConfig,
} from '../../runtime-host/application/adapters/openclaw/projections/openclaw-plugin-config-service';
import { createTestOpenClawEnvironmentRepository } from './helpers/runtime-system-environment';
import { OpenClawManagedPluginCatalog } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-managed-plugin-catalog';
import { OpenClawManagedPluginInstaller } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-managed-plugin-installer';
import { PluginCompanionSkillService } from '../../runtime-host/application/plugins/plugin-companion-skill-service';
import { PluginCompanionSkillWorkflow } from '../../runtime-host/application/workflows/plugin-lifecycle/plugin-companion-skill-workflow';
import { createTestPluginFileSystem } from './helpers/plugin-file-system';

const require = createRequire(import.meta.url);
const { getLarkAccount } = require('../../node_modules/@larksuite/openclaw-lark/src/core/accounts.js') as {
  getLarkAccount: (config: Record<string, any>, accountId?: string | null) => Record<string, any>;
};

describe('channel-runtime config save', () => {
  let tempDir = '';
  let previousConfigDir: string | undefined;
  let repository: ChannelConfigRepository;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-channel-config-'));
    previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    process.env.OPENCLAW_CONFIG_DIR = tempDir;
    const environmentRepository = createTestOpenClawEnvironmentRepository();
    const configRepository = new OpenClawConfigRepository(environmentRepository);
    const pluginFileSystem = createTestPluginFileSystem();
    const catalog = new OpenClawManagedPluginCatalog();
    const companionSkillWorkflow = new PluginCompanionSkillWorkflow({
      workspace: {
        getCompanionSkillRootCandidates: () => environmentRepository.getCompanionSkillRootCandidates(),
        getSkillsRootDir: () => join(configRepository.getConfigDir(), 'skills'),
      },
      fileSystem: pluginFileSystem,
      managedPluginCatalog: catalog,
    });
    const companionSkills = new PluginCompanionSkillService(companionSkillWorkflow);
    const pluginProjection: ChannelPluginConfigProjectionPort = {
      reconcileChannelDerivedPluginState: async (config) => await applyManuallyManagedPluginIdsToOpenClawConfig(
        configRepository,
        pluginFileSystem,
        config,
        await readManuallyManagedPluginIdsFromConfig(configRepository, pluginFileSystem, config),
      ),
    };
    const pluginInstaller = new OpenClawManagedPluginInstaller({
      getManagedPluginRegistryRootCandidates: () => environmentRepository.getManagedPluginRegistryRootCandidates(),
      getExtensionsRootDir: () => join(configRepository.getConfigDir(), 'extensions'),
    }, pluginFileSystem, catalog);
    const pluginProvisioner: ChannelPluginProvisionerPort = {
      ensureChannelPluginInstalled: async (pluginId, options) => {
        const definition = catalog.findChannelDefinition(pluginId);
        if (!definition) {
          return;
        }
        await pluginInstaller.ensureDefinitionInstalled(definition, options);
      },
    };
    repository = new ChannelConfigRepository(new ChannelConfigWorkflow({
      configRepository,
      configProjection: new OpenClawChannelConfigProjection(),
      pluginProjection,
      pluginProvisioner,
      clock: {
        nowMs: () => 1_700_000_000_000,
        nowIso: () => '2023-11-14T22:13:20.000Z',
      },
    }));
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
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('保存 Feishu 配置时会迁移到 openclaw-lark 并禁用旧 feishu entry', async () => {
    await repository.saveChannelConfig({
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
    expect(config.plugins.entries.feishu).toBeUndefined();
  }, 30_000);

  it('保存 Feishu 默认账号时写入插件实际读取的顶层凭证', async () => {
    await repository.saveChannelConfig({
      channelType: 'feishu',
      config: {
        appId: 'cli_default',
        appSecret: 'default-secret',
      },
      enabled: true,
    });

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(config.channels.feishu.appId).toBe('cli_default');
    expect(config.channels.feishu.appSecret).toBe('default-secret');
    expect(config.channels.feishu.accounts?.default).toBeUndefined();
    expect(getLarkAccount(config as any, 'default')).toMatchObject({
      accountId: 'default',
      configured: true,
      appId: 'cli_default',
      appSecret: 'default-secret',
    });
  }, 30_000);

  it('读取 Feishu 表单值时兼容旧 accounts.default 凭证', async () => {
    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        channels: {
          feishu: {
            enabled: true,
            defaultAccount: 'default',
            accounts: {
              default: {
                appId: 'cli_old_default',
                appSecret: 'old-default-secret',
                enabled: true,
              },
            },
          },
        },
      }, null, 2)}\n`,
      'utf8',
    );

    await expect(repository.getChannelFormValues('feishu')).resolves.toMatchObject({
      appId: 'cli_old_default',
      appSecret: 'old-default-secret',
    });
  });

  it('同一频道下不同账号禁止复用唯一凭证', async () => {
    await expect(repository.saveChannelConfig({
      channelType: 'feishu',
      accountId: 'acc2',
      config: {
        appId: 'cli_legacy',
        appSecret: 'another-secret',
      },
      enabled: true,
    })).rejects.toThrow('already bound to another agent');
  }, 30_000);

  it('保存 WeCom 配置时会迁移到 wecom 插件 ID 并启用 entries.wecom', async () => {
    await repository.saveChannelConfig({
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
  }, 15000);

  it('准备 WeChat 插件时只安装扩展，不提前写入渠道配置', async () => {
    await repository.prepareChannelPlugin('openclaw-weixin');

    await expect(readFile(
      join(tempDir, 'extensions', 'openclaw-weixin', 'openclaw.plugin.json'),
      'utf8',
    )).resolves.toContain('"id": "openclaw-weixin"');

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(config.channels?.['openclaw-weixin']).toBeUndefined();
    expect(config.plugins?.allow ?? []).not.toContain('openclaw-weixin');
    expect(config.plugins?.entries?.['openclaw-weixin']).toBeUndefined();
  }, 15000);

  it('保存 WeChat 新登录账号时移除同一用户的旧账号并设为默认账号', async () => {
    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        plugins: {
          allow: ['openclaw-weixin'],
          entries: {
            'openclaw-weixin': { enabled: true },
          },
        },
        channels: {
          'openclaw-weixin': {
            enabled: true,
            defaultAccount: 'old-im-bot',
            accounts: {
              'old-im-bot': {
                enabled: true,
                updatedAt: '2026-04-20T00:00:00.000Z',
              },
              'other-im-bot': {
                enabled: true,
                updatedAt: '2026-04-21T00:00:00.000Z',
              },
            },
          },
        },
      }, null, 2)}\n`,
      'utf8',
    );

    await repository.saveChannelConfig({
      channelType: 'openclaw-weixin',
      accountId: 'new-im-bot',
      config: { enabled: true },
      enabled: true,
      staleAccountIds: ['old-im-bot'],
    });

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(config.channels['openclaw-weixin'].defaultAccount).toBe('new-im-bot');
    expect(config.channels['openclaw-weixin'].accounts['old-im-bot']).toBeUndefined();
    expect(config.channels['openclaw-weixin'].accounts['other-im-bot']).toBeDefined();
    expect(config.channels['openclaw-weixin'].accounts['new-im-bot']).toMatchObject({
      enabled: true,
      updatedAt: '2023-11-14T22:13:20.000Z',
    });
  }, 15000);

  it('保存 QQBot 配置时会启用官方 qqbot 插件 ID', async () => {
    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        plugins: {
          allow: ['qqbot'],
          entries: {
            qqbot: { enabled: true },
          },
        },
        channels: {},
      }, null, 2)}\n`,
      'utf8',
    );

    await repository.saveChannelConfig({
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

    expect(config.plugins.allow).toContain('qqbot');
    expect(config.plugins.entries.qqbot).toMatchObject({
      enabled: true,
      defaultAccount: 'acc1',
      accounts: {
        acc1: {
          appId: 'qq-app-id',
          clientSecret: 'qq-secret',
          enabled: true,
        },
      },
    });
  });

  it('仅插件启用但没有频道配置时不再识别为已配置频道', async () => {
    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        plugins: {
          allow: ['qqbot'],
          entries: {
            qqbot: { enabled: true },
          },
        },
        channels: {},
      }, null, 2)}\n`,
      'utf8',
    );

    const channels = await repository.listConfiguredChannels();
    expect(channels).not.toContain('qqbot');
  });

  it('Feishu accounts 形态异常但顶层凭证存在时仍识别为默认账号配置', async () => {
    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        channels: {
          feishu: {
            enabled: true,
            defaultAccount: 'default',
            accounts: [null, null, { appId: 'ghost-account' }],
            appId: 'cli_real_app',
            appSecret: 'real_secret',
          },
        },
      }, null, 2)}\n`,
      'utf8',
    );

    const channels = await repository.listConfiguredChannels();
    expect(channels).toContain('feishu');

    await expect(repository.getChannelFormValues('feishu')).resolves.toMatchObject({
      appId: 'cli_real_app',
      appSecret: 'real_secret',
    });
  });

  it('内置频道保存配置时保留已有信任白名单但不把 bundled channel 写进 allowlist', async () => {
    await repository.saveChannelConfig({
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

    expect(config.plugins.allow).toEqual(['openclaw-lark']);
  });

  it('保存 WhatsApp 配置时会启用官方 whatsapp 插件并镜像账号', async () => {
    await repository.saveChannelConfig({
      channelType: 'whatsapp',
      accountId: 'default',
      config: {},
      enabled: true,
    });

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(config.channels.whatsapp.enabled).toBe(true);
    expect(config.channels.whatsapp.defaultAccount).toBe('default');
    expect(config.channels.whatsapp.accounts.default).toMatchObject({
      enabled: true,
      updatedAt: '2023-11-14T22:13:20.000Z',
    });
    expect(config.plugins.allow).toContain('whatsapp');
    expect(config.plugins.entries.whatsapp).toMatchObject({
      enabled: true,
      defaultAccount: 'default',
      accounts: {
        default: {
          enabled: true,
        },
      },
    });
  }, 15000);

  it('删除外部频道配置时会同步禁用对应插件', async () => {
    await repository.saveChannelConfig({
      channelType: 'qqbot',
      accountId: 'acc1',
      config: {
        appId: 'qq-app-id',
        clientSecret: 'qq-secret',
      },
      enabled: true,
    });

    await repository.deleteChannelConfig('qqbot');

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(config.channels?.qqbot).toBeUndefined();
    expect(config.plugins.entries.qqbot.enabled).toBe(false);
    expect(config.plugins.allow).not.toContain('qqbot');
  });

  it('保存 Discord 配置时会启用官方 discord 插件并写入 schema 有效的 guild channel 配置', async () => {
    await repository.saveChannelConfig({
      channelType: 'discord',
      accountId: 'default',
      config: {
        token: 'discord-token',
        guildId: 'guild-1',
        channelId: 'channel-1',
      },
      enabled: true,
    });

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(config.channels.discord.accounts.default).toMatchObject({
      token: 'discord-token',
      guilds: {
        'guild-1': {
          channels: {
            'channel-1': { requireMention: true },
          },
        },
      },
    });
    expect(config.channels.discord.accounts.default).not.toHaveProperty('guildId');
    expect(config.channels.discord.accounts.default).not.toHaveProperty('channelId');
    expect(config.channels.discord.accounts.default.guilds['guild-1'].channels['channel-1']).not.toHaveProperty('allow');
    expect(config.plugins.allow).toContain('discord');
    expect(config.plugins.entries.discord.accounts.default).toMatchObject(config.channels.discord.accounts.default);
  });

  it('保存 Discord 配置时会清理已有 allow 标记', async () => {
    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        channels: {
          discord: {
            enabled: true,
            defaultAccount: 'default',
            accounts: {
              default: {
                token: 'discord-token',
                guilds: {
                  'guild-1': {
                    channels: {
                      '*': { allow: false, requireMention: true },
                    },
                  },
                },
              },
            },
          },
        },
      }, null, 2)}\n`,
      'utf8',
    );

    await repository.saveChannelConfig({
      channelType: 'discord',
      accountId: 'default',
      config: { token: 'discord-token' },
      enabled: true,
    });

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;
    const channelConfig = config.channels.discord.accounts.default.guilds['guild-1'].channels['*'];

    expect(channelConfig).toMatchObject({ enabled: false, requireMention: true });
    expect(channelConfig).not.toHaveProperty('allow');
    expect(config.plugins.entries.discord.accounts.default.guilds['guild-1'].channels['*']).not.toHaveProperty('allow');
  });

  it('保存 dingtalk 配置时使用 strict-schema 顶层结构，不写 accounts/defaultAccount', async () => {
    await repository.saveChannelConfig({
      channelType: 'dingtalk',
      accountId: 'team-1',
      config: {
        clientId: 'ding-client-id',
        clientSecret: 'ding-secret',
        robotCode: 'ding-robot',
      },
      enabled: true,
    });

    const config = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(config.channels.dingtalk.clientId).toBe('ding-client-id');
    expect(config.channels.dingtalk.clientSecret).toBe('ding-secret');
    expect(config.channels.dingtalk.robotCode).toBe('ding-robot');
    expect(config.channels.dingtalk.enabled).toBe(true);
    expect(config.channels.dingtalk.accounts).toBeUndefined();
    expect(config.channels.dingtalk.defaultAccount).toBeUndefined();

    const configuredChannels = await repository.listConfiguredChannels();
    expect(configuredChannels).toContain('dingtalk');

    const values = await repository.getChannelFormValues('dingtalk', 'team-1');
    expect(values).toMatchObject({
      clientId: 'ding-client-id',
      clientSecret: 'ding-secret',
      robotCode: 'ding-robot',
    });
  });
});
