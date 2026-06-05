import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelConfigRepository, type ChannelPluginConfigProjectionPort } from '../../runtime-host/application/channels/channel-runtime';
import { ChannelConfigWorkflow } from '../../runtime-host/application/workflows/channel-runtime/channel-config-workflow';
import { OpenClawConfigRepository } from '../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-repository';
import { OpenClawChannelConfigProjection, OpenClawChannelPluginProjection } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-channel-config-projection';
import { OpenClawEnvironmentRepository } from '../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-environment-repository';
import { OpenClawEnvironmentConfigFileWorkflow } from '../../runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-config-file-workflow';
import { OpenClawEnvironmentStatusWorkflow } from '../../runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-status-workflow';
import { PrelaunchMaintenanceCacheRepository } from '../../runtime-host/application/runtime-host/prelaunch-maintenance-cache';
import { PrelaunchMaintenanceCacheWorkflow } from '../../runtime-host/application/workflows/runtime-bootstrap/prelaunch-maintenance-cache-workflow';
import { PrelaunchPluginMaintenanceService } from '../../runtime-host/application/runtime-host/prelaunch-plugin-maintenance';
import { OpenClawManagedPluginCatalog } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-managed-plugin-catalog';
import { OpenClawManagedPluginInstaller } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-managed-plugin-installer';
import { PluginCompanionSkillService } from '../../runtime-host/application/plugins/plugin-companion-skill-service';
import { RuntimePluginLifecycleRunner } from '../../runtime-host/application/plugins/plugin-lifecycle-registry';
import { RuntimePluginRepository, type RuntimePluginConfigProjectionPort } from '../../runtime-host/application/plugins/runtime-plugin-service';
import { PluginCompanionSkillWorkflow } from '../../runtime-host/application/workflows/plugin-lifecycle/plugin-companion-skill-workflow';
import { RuntimePluginLifecycleWorkflow } from '../../runtime-host/application/workflows/plugin-lifecycle/runtime-plugin-lifecycle-workflow';
import {
  applyManuallyManagedPluginIdsToOpenClawConfig,
  readManuallyManagedPluginIdsFromConfig,
  resolveEffectivePluginIdsForConfig,
} from '../../runtime-host/application/adapters/openclaw/projections/openclaw-plugin-config-service';
import { NodePluginFileSystem } from '../../runtime-host/composition/plugin-file-system-adapter';
import { createTestRuntimeClock } from './helpers/runtime-clock';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';
import { createTestRuntimeSystemEnvironment } from './helpers/runtime-system-environment';

describe('runtime-host prelaunch plugin maintenance', () => {
  let configDir: string;
  let openclawDir: string;
  let workspaceDir: string;
  let previousConfigDir: string | undefined;
  let previousRuntimeHostDataDir: string | undefined;
  let previousOpenClawDir: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    previousRuntimeHostDataDir = process.env.MATCHACLAW_RUNTIME_HOST_DATA_DIR;
    previousOpenClawDir = process.env.MATCHACLAW_OPENCLAW_DIR;
    previousCwd = process.cwd();
    configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-prelaunch-config-'));
    openclawDir = mkdtempSync(join(tmpdir(), 'matchaclaw-prelaunch-openclaw-'));
    workspaceDir = mkdtempSync(join(tmpdir(), 'matchaclaw-prelaunch-workspace-'));
    process.env.OPENCLAW_CONFIG_DIR = configDir;
    process.env.MATCHACLAW_RUNTIME_HOST_DATA_DIR = configDir;
    process.env.MATCHACLAW_OPENCLAW_DIR = openclawDir;
    process.chdir(workspaceDir);
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCLAW_CONFIG_DIR;
    } else {
      process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
    }
    if (previousRuntimeHostDataDir === undefined) {
      delete process.env.MATCHACLAW_RUNTIME_HOST_DATA_DIR;
    } else {
      process.env.MATCHACLAW_RUNTIME_HOST_DATA_DIR = previousRuntimeHostDataDir;
    }
    if (previousOpenClawDir === undefined) {
      delete process.env.MATCHACLAW_OPENCLAW_DIR;
    } else {
      process.env.MATCHACLAW_OPENCLAW_DIR = previousOpenClawDir;
    }
    process.chdir(previousCwd);
    rmSync(configDir, { recursive: true, force: true });
    rmSync(openclawDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeManagedPluginSource(pluginId: string, version: string, name = pluginId): void {
    const sourceDir = join(workspaceDir, 'build', 'openclaw-plugins', pluginId);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'openclaw.plugin.json'), JSON.stringify({
      id: pluginId,
      name,
      version,
      category: 'runtime',
    }, null, 2));
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
      name: `@matchaclaw/${pluginId}`,
      version,
    }, null, 2));
  }

  function writeCompanionSkillSource(skillSlug: string): void {
    const sourceDir = join(workspaceDir, 'resources', 'skills', 'plugin-companion-skills', skillSlug);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'SKILL.md'), `# ${skillSlug}\n`, 'utf8');
  }

  function writeOpenClawConfig(config: Record<string, unknown>): void {
    writeFileSync(join(configDir, 'openclaw.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  function createMaintenanceService(): PrelaunchPluginMaintenanceService {
    const fileSystem = createTestRuntimeFileSystem();
    const pluginFileSystem = new NodePluginFileSystem();
    const clock = createTestRuntimeClock();
    const systemEnvironment = createTestRuntimeSystemEnvironment({
      workingDir: workspaceDir,
      homeDir: workspaceDir,
      getEnv: (name) => {
        if (name === 'OPENCLAW_CONFIG_DIR' || name === 'MATCHACLAW_RUNTIME_HOST_DATA_DIR') {
          return configDir;
        }
        if (name === 'MATCHACLAW_OPENCLAW_DIR') {
          return openclawDir;
        }
        return '';
      },
    });
    const environmentLayout = {
      getOpenClawDirPath: () => resolve(openclawDir),
      getOpenClawConfigDir: () => resolve(configDir),
      getOpenClawConfigFilePath: () => join(resolve(configDir), 'openclaw.json'),
    };
    const environment = new OpenClawEnvironmentRepository(
      systemEnvironment,
      fileSystem,
      new OpenClawEnvironmentConfigFileWorkflow({ fileSystem, layout: environmentLayout }),
      new OpenClawEnvironmentStatusWorkflow({ fileSystem, layout: environmentLayout }),
    );
    const configRepository = new OpenClawConfigRepository(environment);
    const catalog = new OpenClawManagedPluginCatalog();
    const companionSkillWorkflow = new PluginCompanionSkillWorkflow({
      workspace: {
        getCompanionSkillRootCandidates: () => environment.getCompanionSkillRootCandidates(),
        getSkillsRootDir: () => join(configRepository.getConfigDir(), 'skills'),
      },
      fileSystem: pluginFileSystem,
      managedPluginCatalog: catalog,
    });
    const companionSkills = new PluginCompanionSkillService(companionSkillWorkflow);
    const installer = new OpenClawManagedPluginInstaller({
      getManagedPluginRegistryRootCandidates: () => environment.getManagedPluginRegistryRootCandidates(),
      getExtensionsRootDir: () => join(configRepository.getConfigDir(), 'extensions'),
    }, pluginFileSystem, catalog);
    const lifecycleRunner = new RuntimePluginLifecycleRunner(companionSkills);
    const runtimePluginProjection: RuntimePluginConfigProjectionPort = {
      readManuallyManagedPluginIds: async (config) => await readManuallyManagedPluginIdsFromConfig(configRepository, pluginFileSystem, config),
      applyManuallyManagedPluginIds: async (config, manualPluginIds) => await applyManuallyManagedPluginIdsToOpenClawConfig(
        configRepository,
        pluginFileSystem,
        config,
        manualPluginIds,
      ),
      resolveEffectivePluginIds: (config, manualPluginIds) => resolveEffectivePluginIdsForConfig(config, manualPluginIds),
    };
    const runtimePluginCatalogProjection = new OpenClawChannelPluginProjection();
    const channelPluginProjection: ChannelPluginConfigProjectionPort = {
      reconcileChannelDerivedPluginState: async (config) => await applyManuallyManagedPluginIdsToOpenClawConfig(
        configRepository,
        pluginFileSystem,
        config,
        await readManuallyManagedPluginIdsFromConfig(configRepository, pluginFileSystem, config),
      ),
    };
    const lifecycleWorkflow = new RuntimePluginLifecycleWorkflow({
      configRepository,
      configProjection: runtimePluginProjection,
      catalogProjection: runtimePluginCatalogProjection,
      installer,
      managedPluginCatalog: catalog,
      lifecycleRunner,
    });
    const runtimePlugins = new RuntimePluginRepository(lifecycleWorkflow);
    const channelProvisioner = {
      ensureChannelPluginInstalled: async (pluginId: string, options?: { force?: boolean }) => {
        const definition = catalog.findChannelDefinition(pluginId);
        if (definition) {
          await installer.ensureDefinitionInstalled(definition, options);
        }
      },
    };
    const channels = new ChannelConfigRepository(new ChannelConfigWorkflow({
      configRepository,
      configProjection: new OpenClawChannelConfigProjection(),
      pluginProjection: channelPluginProjection,
      pluginProvisioner: channelProvisioner,
      clock,
    }));

    return new PrelaunchPluginMaintenanceService({
      runtimePlugins,
      channels,
      channelPluginProjection: new OpenClawChannelPluginProjection(),
      runtime: {
        getRuntimeDataRootDir: () => environment.getOpenClawConfigDir(),
        getRuntimeDistributionDir: () => environment.getOpenClawDirPath(),
        getWorkingDir: () => environment.getWorkingDir(),
      },
      cacheRepository: new PrelaunchMaintenanceCacheRepository({
        getRuntimeHostDataDir: () => environment.getRuntimeHostDataDir(),
      }, new PrelaunchMaintenanceCacheWorkflow({ fileSystem, clock })),
      fileSystem,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
  }

  it('启动期 managed 插件维护缓存命中时不会重复覆盖已安装插件', async () => {
    writeManagedPluginSource('browser-relay', '1.0.0', 'Source Browser Relay');
    writeCompanionSkillSource('browser-relay-skill');
    writeOpenClawConfig({
      plugins: {
        allow: ['browser-relay'],
        entries: {
          'browser-relay': { enabled: true },
        },
      },
    });

    const service = createMaintenanceService();
    await service.ensureConfiguredManagedPluginsForGatewayLaunch();

    const markerPath = join(configDir, 'extensions', 'browser-relay', 'marker.txt');
    writeFileSync(markerPath, 'keep-me', 'utf8');

    await service.ensureConfiguredManagedPluginsForGatewayLaunch();

    expect(readFileSync(markerPath, 'utf8')).toBe('keep-me');
  });

  it('启动期 managed 插件源内容变化时会重新覆盖同版本旧副本', async () => {
    writeManagedPluginSource('matchaclaw-media', '1.0.0', 'Media v1');
    writeOpenClawConfig({
      plugins: {
        allow: ['matchaclaw-media'],
        entries: {
          'matchaclaw-media': { enabled: true },
        },
      },
    });

    const service = createMaintenanceService();
    await service.ensureConfiguredManagedPluginsForGatewayLaunch();
    writeManagedPluginSource('matchaclaw-media', '1.0.0', 'Media v2');

    await service.ensureConfiguredManagedPluginsForGatewayLaunch();

    const installedManifest = JSON.parse(
      readFileSync(join(configDir, 'extensions', 'matchaclaw-media', 'openclaw.plugin.json'), 'utf8'),
    ) as {
      name: string;
      version: string;
    };
    expect(installedManifest).toMatchObject({
      name: 'Media v2',
      version: '1.0.0',
    });
  });

  it('启动期会在 runtime-host 侧清理仍是内置渠道的扩展旧副本', async () => {
    const discordDir = join(configDir, 'extensions', 'discord');
    const telegramDir = join(configDir, 'extensions', 'telegram');
    const externalDir = join(configDir, 'extensions', 'openclaw-weixin');
    mkdirSync(discordDir, { recursive: true });
    mkdirSync(telegramDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(discordDir, 'marker.txt'), 'keep', 'utf8');
    writeFileSync(join(telegramDir, 'marker.txt'), 'stale', 'utf8');
    writeFileSync(join(externalDir, 'marker.txt'), 'keep', 'utf8');

    const removed = await createMaintenanceService().cleanupStaleBuiltinExtensionsForGatewayLaunch();

    expect(removed).toEqual(['telegram']);
    expect(readFileSync(join(discordDir, 'marker.txt'), 'utf8')).toBe('keep');
    expect(() => readFileSync(join(telegramDir, 'marker.txt'), 'utf8')).toThrow();
    expect(readFileSync(join(externalDir, 'marker.txt'), 'utf8')).toBe('keep');
  });

  it('启动期 managed 插件源版本变化时会重新执行维护并升级插件', async () => {
    writeManagedPluginSource('browser-relay', '1.0.0', 'Browser Relay v1');
    writeCompanionSkillSource('browser-relay-skill');
    writeOpenClawConfig({
      plugins: {
        allow: ['browser-relay'],
        entries: {
          'browser-relay': { enabled: true },
        },
      },
    });

    const service = createMaintenanceService();
    await service.ensureConfiguredManagedPluginsForGatewayLaunch();
    writeManagedPluginSource('browser-relay', '1.1.0', 'Browser Relay v2');

    await service.ensureConfiguredManagedPluginsForGatewayLaunch();

    const installedManifest = JSON.parse(
      readFileSync(join(configDir, 'extensions', 'browser-relay', 'openclaw.plugin.json'), 'utf8'),
    ) as {
      name: string;
      version: string;
    };
    expect(installedManifest).toMatchObject({
      name: 'Browser Relay v2',
      version: '1.1.0',
    });
  });

  it('启动期渠道插件维护缓存命中时不会重复覆盖已安装插件', async () => {
    writeManagedPluginSource('openclaw-weixin', '1.0.0', 'Source Weixin');
    writeOpenClawConfig({
      channels: {
        'openclaw-weixin': {
          enabled: true,
          accounts: {
            default: {
              enabled: true,
            },
          },
        },
      },
      plugins: {
        allow: ['openclaw-weixin'],
        entries: {
          'openclaw-weixin': { enabled: true },
        },
      },
    });

    const service = createMaintenanceService();
    await service.reconcileConfiguredChannelPluginsForGatewayLaunch();

    const markerPath = join(configDir, 'extensions', 'openclaw-weixin', 'marker.txt');
    writeFileSync(markerPath, 'keep-channel-plugin', 'utf8');

    await service.reconcileConfiguredChannelPluginsForGatewayLaunch();

    expect(readFileSync(markerPath, 'utf8')).toBe('keep-channel-plugin');
  });
});
