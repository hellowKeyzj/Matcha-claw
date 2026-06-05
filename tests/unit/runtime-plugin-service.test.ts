import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenClawConfigRepository } from '../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-repository';
import { createTestOpenClawEnvironmentRepository } from './helpers/runtime-system-environment';
import { OpenClawChannelPluginProjection } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-channel-config-projection';
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
import { createTestPluginFileSystem } from './helpers/plugin-file-system';

describe('runtime plugin service', () => {
  let configDir: string;
  let workspaceDir: string;
  let previousConfigDir: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    previousCwd = process.cwd();
    configDir = mkdtempSync(join(tmpdir(), 'runtime-plugin-service-config-'));
    workspaceDir = mkdtempSync(join(tmpdir(), 'runtime-plugin-service-workspace-'));
    process.env.OPENCLAW_CONFIG_DIR = configDir;
    process.chdir(workspaceDir);
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCLAW_CONFIG_DIR;
    } else {
      process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
    }
    process.chdir(previousCwd);
    rmSync(configDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeManagedPluginSource(pluginId: string, sourceDirName = pluginId, version = '1.0.0'): void {
    const sourceDir = join(workspaceDir, 'build', 'openclaw-plugins', sourceDirName);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'openclaw.plugin.json'), JSON.stringify({
      id: `${pluginId}-src`,
      name: pluginId,
      version,
      category: 'runtime',
      configSchema: {
        type: 'object',
        additionalProperties: true,
      },
    }, null, 2));
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
      name: `@matchaclaw/${sourceDirName}`,
      version,
    }, null, 2));
  }

  function writeCompanionSkillSource(skillSlug: string): void {
    const sourceDir = join(workspaceDir, 'resources', 'skills', 'plugin-companion-skills', skillSlug);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'SKILL.md'), `# ${skillSlug}\n`, 'utf8');
  }

  function writeInstalledOpenClawPlugin(pluginId: string): void {
    const installedDir = join(configDir, 'extensions', pluginId);
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(join(installedDir, 'openclaw.plugin.json'), JSON.stringify({
      id: pluginId,
      name: pluginId,
      version: '1.0.0',
      category: 'runtime',
      configSchema: {
        type: 'object',
        additionalProperties: true,
      },
    }, null, 2));
  }

  function createRuntimePluginRepository(): RuntimePluginRepository {
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
    const configProjection: RuntimePluginConfigProjectionPort = {
      readManuallyManagedPluginIds: async (config) => await readManuallyManagedPluginIdsFromConfig(configRepository, pluginFileSystem, config),
      applyManuallyManagedPluginIds: async (config, manualPluginIds) => await applyManuallyManagedPluginIdsToOpenClawConfig(
        configRepository,
        pluginFileSystem,
        config,
        manualPluginIds,
      ),
      resolveEffectivePluginIds: (config, manualPluginIds) => resolveEffectivePluginIdsForConfig(config, manualPluginIds),
    };
    const catalogProjection = new OpenClawChannelPluginProjection();
    const installer = new OpenClawManagedPluginInstaller({
      getManagedPluginRegistryRootCandidates: () => environmentRepository.getManagedPluginRegistryRootCandidates(),
      getExtensionsRootDir: () => join(configRepository.getConfigDir(), 'extensions'),
    }, pluginFileSystem, catalog);
    const lifecycleRunner = new RuntimePluginLifecycleRunner(companionSkills);
    const lifecycleWorkflow = new RuntimePluginLifecycleWorkflow({
      configRepository,
      configProjection,
      catalogProjection,
      installer,
      managedPluginCatalog: catalog,
      lifecycleRunner,
    });
    return new RuntimePluginRepository(lifecycleWorkflow);
  }

  it('已安装的托管插件版本一致时在非 force 模式下不会重复覆盖', async () => {
    const installedDir = join(configDir, 'extensions', 'browser-relay');
    writeManagedPluginSource('browser-relay');
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(join(installedDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser-relay',
      name: 'Installed Browser Relay',
      version: '1.0.0',
      category: 'runtime',
    }, null, 2));

    await createRuntimePluginRepository().ensureManagedPluginInstalled('browser-relay');

    const installedManifest = JSON.parse(readFileSync(join(installedDir, 'openclaw.plugin.json'), 'utf8')) as {
      name: string;
    };
    expect(installedManifest.name).toBe('Installed Browser Relay');
  });

  it('已安装的托管插件版本落后时会升级到随包版本', async () => {
    const installedDir = join(configDir, 'extensions', 'browser-relay');
    writeManagedPluginSource('browser-relay', 'browser-relay', '1.1.0');
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(join(installedDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser-relay',
      name: 'Old Browser Relay',
      version: '1.0.0',
      category: 'runtime',
    }, null, 2));

    await createRuntimePluginRepository().ensureManagedPluginInstalled('browser-relay');

    const installedManifest = JSON.parse(readFileSync(join(installedDir, 'openclaw.plugin.json'), 'utf8')) as {
      id: string;
      name: string;
      version: string;
    };
    const installedPackage = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(installedManifest).toMatchObject({
      id: 'browser-relay',
      name: 'browser-relay',
      version: '1.1.0',
    });
    expect(installedPackage.version).toBe('1.1.0');
  });

  it('渠道插件不能通过插件中心安装入口安装', async () => {
    writeManagedPluginSource('openclaw-lark');

    await expect(createRuntimePluginRepository().ensureManagedPluginInstalled('openclaw-lark')).rejects.toThrow(
      'not managed by the MatchaClaw plugin center',
    );
  });

  it('首次启用 memory-lancedb-pro 时会补默认 memory slot 和 local MiniLM 配置', async () => {
    writeManagedPluginSource('memory-lancedb-pro');
    writeCompanionSkillSource('memory-lancedb-pro-skill');
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        entries: {
          'plugin-a': { enabled: true },
        },
      },
    }, null, 2));

    const enabledPluginIds = await createRuntimePluginRepository().setEnabledPluginIds(['plugin-a', 'memory-lancedb-pro']);
    const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
      plugins?: {
        allow?: string[];
        slots?: { memory?: string };
        entries?: Record<string, {
          enabled?: boolean;
          config?: {
            embedding?: {
              provider?: string;
              model?: string;
            };
          };
        }>;
      };
    };

    expect(enabledPluginIds).toEqual(['memory-lancedb-pro']);
    expect(nextConfig.plugins?.allow).toEqual(['memory-lancedb-pro', 'plugin-a']);
    expect(nextConfig.plugins?.slots?.memory).toBe('memory-lancedb-pro');
    expect(nextConfig.plugins?.entries?.['memory-lancedb-pro']).toMatchObject({
      enabled: true,
      config: {
        embedding: {
          provider: 'local-minilm',
          model: 'Xenova/all-MiniLM-L6-v2',
        },
        autoCapture: true,
        autoRecall: true,
        autoRecallMinLength: 5,
        smartExtraction: true,
        extractMinMessages: 5,
        extractMaxChars: 8000,
        sessionMemory: {
          enabled: false,
        },
      },
    });
  });

  it('禁用 memory-lancedb-pro 时会释放它占用的 memory slot，但保留插件私有配置', async () => {
    writeInstalledOpenClawPlugin('memory-lancedb-pro');
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        slots: {
          memory: 'memory-lancedb-pro',
        },
        allow: ['memory-lancedb-pro'],
        entries: {
          'memory-lancedb-pro': {
            enabled: true,
            config: {
              embedding: {
                provider: 'local-minilm',
                model: 'Xenova/all-MiniLM-L6-v2',
              },
            },
          },
        },
      },
    }, null, 2));

    const enabledPluginIds = await createRuntimePluginRepository().setEnabledPluginIds([]);
    const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
      plugins?: {
        allow?: string[];
        slots?: { memory?: string };
        entries?: Record<string, {
          enabled?: boolean;
          config?: {
            embedding?: {
              provider?: string;
              model?: string;
            };
          };
        }>;
      };
    };

    expect(enabledPluginIds).toEqual([]);
    expect(nextConfig.plugins?.allow).toBeUndefined();
    expect(nextConfig.plugins?.slots?.memory).toBeUndefined();
    expect(nextConfig.plugins?.entries?.['memory-lancedb-pro']).toMatchObject({
      enabled: false,
      config: {
        embedding: {
          provider: 'local-minilm',
          model: 'Xenova/all-MiniLM-L6-v2',
        },
      },
    });
  });

  it('启用 memory-lancedb-pro 时不会覆盖用户已经手动设置的 embedding 配置', async () => {
    writeManagedPluginSource('memory-lancedb-pro');
    writeCompanionSkillSource('memory-lancedb-pro-skill');
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        entries: {
          'memory-lancedb-pro': {
            enabled: false,
            config: {
              embedding: {
                provider: 'openai-compatible',
                model: 'text-embedding-3-small',
              },
            },
          },
        },
      },
    }, null, 2));

    await createRuntimePluginRepository().setEnabledPluginIds(['memory-lancedb-pro']);

    const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
      plugins?: {
        slots?: { memory?: string };
        entries?: Record<string, {
          config?: {
            embedding?: {
              provider?: string;
              model?: string;
            };
          };
        }>;
      };
    };

    expect(nextConfig.plugins?.slots?.memory).toBe('memory-lancedb-pro');
    expect(nextConfig.plugins?.entries?.['memory-lancedb-pro']?.config?.embedding).toEqual({
      provider: 'openai-compatible',
      model: 'text-embedding-3-small',
    });
  });

  it('启用 memory-lancedb-pro 时不会覆盖用户已经手动设置的 autoRecallMinLength', async () => {
    writeManagedPluginSource('memory-lancedb-pro');
    writeCompanionSkillSource('memory-lancedb-pro-skill');
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        entries: {
          'memory-lancedb-pro': {
            enabled: false,
            config: {
              autoRecallMinLength: 9,
            },
          },
        },
      },
    }, null, 2));

    await createRuntimePluginRepository().setEnabledPluginIds(['memory-lancedb-pro']);

    const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
      plugins?: {
        entries?: Record<string, {
          config?: {
            autoRecallMinLength?: number;
          };
        }>;
      };
    };

    expect(nextConfig.plugins?.entries?.['memory-lancedb-pro']?.config?.autoRecallMinLength).toBe(9);
  });

  it('启动时会为已启用的 memory-lancedb-pro 补齐默认记忆配置', async () => {
    writeInstalledOpenClawPlugin('memory-lancedb-pro');
    writeCompanionSkillSource('memory-lancedb-pro-skill');
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['memory-lancedb-pro'],
        entries: {
          'memory-lancedb-pro': {
            enabled: true,
          },
        },
      },
    }, null, 2));

    const enabledPluginIds = await createRuntimePluginRepository().ensureConfiguredManagedPluginsInstalled();
    const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
      plugins?: {
        slots?: { memory?: string };
        entries?: Record<string, {
          enabled?: boolean;
          config?: {
            embedding?: {
              provider?: string;
              model?: string;
            };
          };
        }>;
      };
    };

    expect(enabledPluginIds).toEqual(['memory-lancedb-pro']);
    expect(nextConfig.plugins?.slots?.memory).toBe('memory-lancedb-pro');
    expect(nextConfig.plugins?.entries?.['memory-lancedb-pro']).toMatchObject({
      enabled: true,
      config: {
        embedding: {
          provider: 'local-minilm',
          model: 'Xenova/all-MiniLM-L6-v2',
        },
        autoCapture: true,
        autoRecall: true,
        autoRecallMinLength: 5,
        smartExtraction: true,
        extractMinMessages: 5,
        extractMaxChars: 8000,
        sessionMemory: {
          enabled: false,
        },
      },
    });
  });

  it('插件中心目录只返回 MatchaClaw 管理的能力插件，不展示 OpenClaw bundled 运行态插件', async () => {
    writeManagedPluginSource('task-manager', 'task-manager', '1.1.0');

    const bundledCoreDir = join(workspaceDir, 'plugins', '@openclaw-image-generation-core');
    mkdirSync(bundledCoreDir, { recursive: true });
    writeFileSync(join(bundledCoreDir, 'openclaw.plugin.json'), JSON.stringify({
      id: '@openclaw/image-generation-core',
      name: '@openclaw/image-generation-core',
      version: '2026.4.20',
      category: 'general',
      description: 'OpenClaw image generation runtime package',
    }, null, 2));

    const catalog = await createRuntimePluginRepository().listRuntimePluginCatalog();

    expect(catalog.map((plugin) => plugin.id)).toEqual(['task-manager']);
    expect(catalog.some((plugin) => plugin.id.startsWith('@openclaw/'))).toBe(false);
  });
});
