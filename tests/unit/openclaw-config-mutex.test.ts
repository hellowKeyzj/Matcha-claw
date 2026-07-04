import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenClawConfigRepository } from '../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-repository';
import { OpenClawEnvironmentConfigFileWorkflow } from '../../runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-config-file-workflow';
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
import {
  readOpenClawToolPermissionMode,
  syncGatewayTokenToConfig,
  syncToolPermissionModeToOpenClaw,
} from '../../runtime-host/application/adapters/openclaw/projections/openclaw-runtime-config-sync';
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

  it('通过临时文件 rename 原子写入 openclaw.json，并在失败时清理临时文件', async () => {
    const fileSystem = createTestRuntimeFileSystem();
    const layout = {
      getOpenClawConfigDir: () => tempDir,
      getOpenClawConfigFilePath: () => join(tempDir, 'openclaw.json'),
    };
    const workflow = new OpenClawEnvironmentConfigFileWorkflow({ fileSystem, layout });
    const renameSpy = vi.spyOn(fileSystem, 'rename');

    await workflow.writeOpenClawConfigJson({ gateway: { mode: 'local' } });

    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy.mock.calls[0]![0]).toContain('.openclaw.json.');
    expect(renameSpy.mock.calls[0]![1]).toBe(join(tempDir, 'openclaw.json'));
    await expect(readFile(join(tempDir, 'openclaw.json'), 'utf8')).resolves.toBe(JSON.stringify({ gateway: { mode: 'local' } }, null, 2));

    renameSpy.mockRestore();
    const failingRenameSpy = vi.spyOn(fileSystem, 'rename').mockRejectedValue(new Error('rename failed'));
    await expect(workflow.writeOpenClawConfigJson({ gateway: { mode: 'remote' } })).rejects.toThrow('rename failed');
    const failedTempPath = failingRenameSpy.mock.calls[0]![0];
    await expect(readFile(failedTempPath, 'utf8')).rejects.toThrow();
  });

  it('openclaw.json rename 被 Windows 短暂占用拒绝时，仍提交同一份配置内容并清理临时文件', async () => {
    const fileSystem = createTestRuntimeFileSystem();
    const layout = {
      getOpenClawConfigDir: () => tempDir,
      getOpenClawConfigFilePath: () => join(tempDir, 'openclaw.json'),
    };
    const workflow = new OpenClawEnvironmentConfigFileWorkflow({ fileSystem, layout });
    const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const renameSpy = vi.spyOn(fileSystem, 'rename').mockRejectedValue(error);

    await workflow.writeOpenClawConfigJson({ gateway: { mode: 'local' } });

    const failedTempPath = renameSpy.mock.calls[0]![0];
    await expect(readFile(join(tempDir, 'openclaw.json'), 'utf8')).resolves.toBe(JSON.stringify({ gateway: { mode: 'local' } }, null, 2));
    await expect(readFile(failedTempPath, 'utf8')).rejects.toThrow();
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

  it('同步 OpenClaw 工具权限模式时只改 tools.fs 和 tools.exec', async () => {
    const configRepository = new OpenClawConfigRepository(createTestOpenClawEnvironmentRepository());

    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        tools: {
          profile: 'coding',
          fs: { workspaceOnly: false, keepFs: true },
          exec: { security: 'full', ask: 'off', keepExec: true },
          customToolConfig: true,
        },
        agents: { defaults: { model: { primary: 'anthropic/claude-opus-4-8' } } },
      }, null, 2)}\n`,
      'utf8',
    );

    await expect(syncToolPermissionModeToOpenClaw(configRepository, 'default')).resolves.toEqual({ mode: 'default' });
    await expect(readOpenClawToolPermissionMode(configRepository)).resolves.toEqual({ mode: 'default' });

    const defaultConfig = JSON.parse(await readFile(join(tempDir, 'openclaw.json'), 'utf8')) as Record<string, any>;
    expect(defaultConfig.tools).toEqual({
      profile: 'coding',
      fs: { workspaceOnly: true, keepFs: true },
      exec: { keepExec: true },
      customToolConfig: true,
    });
    expect(defaultConfig.agents).toEqual({ defaults: { model: { primary: 'anthropic/claude-opus-4-8' } } });
    expect(defaultConfig.commands.restart).toBe(true);

    await expect(syncToolPermissionModeToOpenClaw(configRepository, 'fullAccess')).resolves.toEqual({ mode: 'fullAccess' });
    const fullAccessConfig = JSON.parse(await readFile(join(tempDir, 'openclaw.json'), 'utf8')) as Record<string, any>;
    expect(fullAccessConfig.tools.fs.workspaceOnly).toBe(false);
    expect(fullAccessConfig.tools.exec).toEqual({ keepExec: true });

    await writeFile(
      join(tempDir, 'openclaw.json'),
      `${JSON.stringify({
        tools: {
          fs: { workspaceOnly: false },
          exec: { security: 'full', ask: 'off' },
        },
      }, null, 2)}\n`,
      'utf8',
    );

    await expect(syncToolPermissionModeToOpenClaw(configRepository, 'default')).resolves.toEqual({ mode: 'default' });
    const omittedExecConfig = JSON.parse(await readFile(join(tempDir, 'openclaw.json'), 'utf8')) as Record<string, any>;
    expect(omittedExecConfig.tools).toEqual({ fs: { workspaceOnly: true } });
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
