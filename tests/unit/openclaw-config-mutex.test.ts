import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenClawConfigRepository } from '../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-repository';
import { createTestOpenClawEnvironmentRepository } from './helpers/runtime-system-environment';
import { ChannelConfigRepository, type ChannelPluginConfigProjectionPort } from '../../runtime-host/application/channels/channel-runtime';
import { ChannelConfigWorkflow } from '../../runtime-host/application/workflows/channel-runtime/channel-config-workflow';
import { OpenClawChannelConfigProjection } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-channel-config-projection';
import {
  applyManuallyManagedPluginIdsToOpenClawConfig,
  readManuallyManagedPluginIdsFromConfig,
} from '../../runtime-host/application/adapters/openclaw/projections/openclaw-plugin-config-service';
import { withOpenClawConfigLock } from '../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-mutex';
import { SkillsConfigRepository } from '../../runtime-host/application/skills/store';
import { ClawHubSkillInventory } from '../../runtime-host/application/skills/clawhub';
import { OpenClawManagedPluginCatalog } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-managed-plugin-catalog';
import { OpenClawManagedPluginInstaller } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-managed-plugin-installer';
import { PluginCompanionSkillService } from '../../runtime-host/application/plugins/plugin-companion-skill-service';
import { PluginCompanionSkillWorkflow } from '../../runtime-host/application/workflows/plugin-lifecycle/plugin-companion-skill-workflow';
import { syncGatewayTokenToConfig } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-runtime-config-sync';
import { createTestPluginFileSystem } from './helpers/plugin-file-system';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';

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

  it('拒绝在已有 openclaw.json 不可解析时执行事务写回', async () => {
    const configRepository = new OpenClawConfigRepository(createTestOpenClawEnvironmentRepository());

    await writeFile(join(tempDir, 'openclaw.json'), '{ invalid json', 'utf8');

    await expect(configRepository.updateDirty((config) => {
      config.gateway = { mode: 'local' };
      return { result: undefined, changed: true };
    })).rejects.toThrow('Invalid OpenClaw config JSON');
    await expect(readFile(join(tempDir, 'openclaw.json'), 'utf8')).resolves.toBe('{ invalid json');
  });

  it('updateDirty 由 mutator dirty bit 决定是否写盘', async () => {
    const configRepository = new OpenClawConfigRepository(createTestOpenClawEnvironmentRepository());
    const writeSpy = vi.spyOn(configRepository, 'write');

    await expect(configRepository.updateDirty((config) => {
      config.channels = {
        telegram: {
          defaultAccount: 'default',
          accounts: {
            default: { token: 'old-token' },
          },
        },
      };
      return { result: 'unchanged', changed: false };
    })).resolves.toBe('unchanged');

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('patchSection 只在 mutator 标记 section dirty 时写回', async () => {
    const configRepository = new OpenClawConfigRepository(createTestOpenClawEnvironmentRepository());
    const writeSpy = vi.spyOn(configRepository, 'write');

    await expect(configRepository.patchSection('channels', (channels) => ({
      result: 'same',
      value: channels,
      changed: false,
    }))).resolves.toBe('same');
    expect(writeSpy).not.toHaveBeenCalled();

    await expect(configRepository.patchSection('gateway', () => ({
      result: 'changed',
      value: { mode: 'local' },
      changed: true,
    }))).resolves.toBe('changed');
    expect(writeSpy).toHaveBeenCalledTimes(1);

    const finalConfig = JSON.parse(await readFile(join(tempDir, 'openclaw.json'), 'utf8')) as Record<string, any>;
    expect(finalConfig.channels.telegram.accounts.default.token).toBe('old-token');
    expect(finalConfig.gateway).toEqual({ mode: 'local' });
  });

  it('启动同步只 patch 自己拥有的路径，保留其它 openclaw.json 内容', async () => {
    const configRepository = new OpenClawConfigRepository(createTestOpenClawEnvironmentRepository());
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        agents: {
          defaults: { model: { primary: 'openai/gpt-4.1-mini' } },
          list: [
            { id: 'ppc', name: 'ppc', workspace: 'E:/agents/ppc' },
            { id: 'github', name: 'github', skills: ['git'] },
          ],
          customAgentField: { keep: true },
        },
        gateway: {
          mode: 'remote',
          customGatewayField: 'keep',
        },
        skills: { entries: { existing: { enabled: true, custom: 'keep' } } },
        tools: { customToolConfig: true },
        channels: { customChannel: { enabled: true } },
        plugins: { entries: { external: { enabled: true, config: { keep: true } } } },
        unknownTopLevel: { keep: true },
      }, null, 2)}\n`,
      'utf8',
    );

    await syncGatewayTokenToConfig(configRepository, 'runtime-token', logger);

    const finalConfig = JSON.parse(
      await readFile(join(tempDir, 'openclaw.json'), 'utf8'),
    ) as Record<string, any>;

    expect(finalConfig.gateway.auth).toEqual({ mode: 'token', token: 'runtime-token' });
    expect(finalConfig.gateway.mode).toBe('remote');
    expect(finalConfig.gateway.customGatewayField).toBe('keep');
    expect(finalConfig.agents).toEqual({
      defaults: { model: { primary: 'openai/gpt-4.1-mini' } },
      list: [
        { id: 'ppc', name: 'ppc', workspace: 'E:/agents/ppc' },
        { id: 'github', name: 'github', skills: ['git'] },
      ],
      customAgentField: { keep: true },
    });
    expect(finalConfig.skills).toEqual({ entries: { existing: { enabled: true, custom: 'keep' } } });
    expect(finalConfig.tools).toEqual({ customToolConfig: true });
    expect(finalConfig.channels).toEqual({ customChannel: { enabled: true } });
    expect(finalConfig.plugins).toEqual({ entries: { external: { enabled: true, config: { keep: true } } } });
    expect(finalConfig.unknownTopLevel).toEqual({ keep: true });
    expect(finalConfig.commands.restart).toBe(true);
  });

  it('会串行化跨模块的 openclaw.json 写入，避免并发覆盖', async () => {
    const environmentRepository = createTestOpenClawEnvironmentRepository();
    const configRepository = new OpenClawConfigRepository(environmentRepository);
    const originalWrite = configRepository.write.bind(configRepository);
    let writeStartedCount = 0;
    let resolveFirstWriteStarted: () => void = () => {};
    let releaseFirstWrite: () => void = () => {};

    const firstWriteStarted = new Promise<void>((resolve) => {
      resolveFirstWriteStarted = resolve;
    });
    const allowFirstWriteComplete = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    const writeSpy = vi.spyOn(configRepository, 'write').mockImplementation(async (config) => {
      writeStartedCount += 1;
      if (writeStartedCount === 1) {
        resolveFirstWriteStarted();
        await allowFirstWriteComplete;
      }
      await originalWrite(config);
    });

    const pluginFileSystem = createTestPluginFileSystem();
    const runtimeFileSystem = createTestRuntimeFileSystem();
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
    const pluginInstaller = new OpenClawManagedPluginInstaller({
      getManagedPluginRegistryRootCandidates: () => environmentRepository.getManagedPluginRegistryRootCandidates(),
      getExtensionsRootDir: () => join(configRepository.getConfigDir(), 'extensions'),
    }, pluginFileSystem, catalog);
    const pluginProjection: ChannelPluginConfigProjectionPort = {
      reconcileChannelDerivedPluginState: async (config) => await applyManuallyManagedPluginIdsToOpenClawConfig(
        configRepository,
        pluginFileSystem,
        config,
        await readManuallyManagedPluginIdsFromConfig(configRepository, pluginFileSystem, config),
      ),
    };
    const pluginProvisioner = {
      ensureChannelPluginInstalled: async (pluginId: string, options?: { force?: boolean }) => {
        const definition = catalog.findChannelDefinition(pluginId);
        if (definition) {
          await pluginInstaller.ensureDefinitionInstalled(definition, options);
        }
      },
    };
    const channelSavePromise = new ChannelConfigRepository(new ChannelConfigWorkflow({
      configRepository,
      configProjection: new OpenClawChannelConfigProjection(),
      pluginProjection,
      pluginProvisioner,
      clock: {
        nowMs: () => 1_700_000_000_000,
        nowIso: () => '2023-11-14T22:13:20.000Z',
      },
    })).saveChannelConfig({
      channelType: 'telegram',
      accountId: 'default',
      config: { token: 'new-token' },
      enabled: true,
    });

    await firstWriteStarted;

    const skillSavePromise = new SkillsConfigRepository(
      configRepository,
      new ClawHubSkillInventory({
        getSkillsRootDir: () => join(configRepository.getConfigDir(), 'skills'),
        getLockFilePath: () => join(configRepository.getConfigDir(), '.clawhub', 'lock.json'),
      }, runtimeFileSystem),
    ).updateConfig('tavily-search', { apiKey: 'skill-key' });

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
  }, 15_000);
});
