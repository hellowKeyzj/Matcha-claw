import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  function writeManagedPluginSource(pluginId: string, sourceDirName = pluginId): void {
    const sourceDir = join(workspaceDir, 'build', 'openclaw-plugins', sourceDirName);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'openclaw.plugin.json'), JSON.stringify({
      id: `${pluginId}-src`,
      name: pluginId,
      version: '1.0.0',
      category: 'runtime',
      configSchema: {
        type: 'object',
        additionalProperties: true,
      },
    }, null, 2));
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
      name: `@matchaclaw/${sourceDirName}`,
      version: '1.0.0',
    }, null, 2));
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

  it('已安装的托管插件在非 force 模式下不会重复覆盖', async () => {
    const sourceDir = join(workspaceDir, 'build', 'openclaw-plugins', 'browser-relay');
    const installedDir = join(configDir, 'extensions', 'browser-relay');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(join(sourceDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser-relay-src',
      name: 'Browser Relay',
      version: '1.0.0',
      category: 'runtime',
    }, null, 2));
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
      name: '@matchaclaw/browser-relay',
      version: '1.0.0',
    }, null, 2));
    writeFileSync(join(installedDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser-relay',
      name: 'Installed Browser Relay',
      version: '1.0.0',
      category: 'runtime',
    }, null, 2));

    const { ensureManagedPluginInstalled } = await import('../../runtime-host/application/plugins/runtime-plugin-service');

    await ensureManagedPluginInstalled('browser-relay');

    const installedManifest = JSON.parse(readFileSync(join(installedDir, 'openclaw.plugin.json'), 'utf8')) as {
      name: string;
    };
    expect(installedManifest.name).toBe('Installed Browser Relay');
  });

  it('首次启用 memory-lancedb-pro 时会补默认 memory slot 和 local MiniLM 配置', async () => {
    writeManagedPluginSource('memory-lancedb-pro');
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        entries: {
          'plugin-a': { enabled: true },
        },
      },
    }, null, 2));

    const { setRuntimeEnabledPluginIds } = await import('../../runtime-host/application/plugins/runtime-plugin-service');

    const enabledPluginIds = await setRuntimeEnabledPluginIds(['plugin-a', 'memory-lancedb-pro']);
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

    expect(enabledPluginIds).toEqual(['plugin-a', 'memory-lancedb-pro']);
    expect(nextConfig.plugins?.allow).toEqual(['plugin-a', 'memory-lancedb-pro']);
    expect(nextConfig.plugins?.slots?.memory).toBe('memory-lancedb-pro');
    expect(nextConfig.plugins?.entries?.['memory-lancedb-pro']).toMatchObject({
      enabled: true,
      config: {
        embedding: {
          provider: 'local-minilm',
          model: 'all-MiniLM-L6-v2',
        },
        autoCapture: true,
        autoRecall: true,
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
                model: 'all-MiniLM-L6-v2',
              },
            },
          },
        },
      },
    }, null, 2));

    const { setRuntimeEnabledPluginIds } = await import('../../runtime-host/application/plugins/runtime-plugin-service');

    const enabledPluginIds = await setRuntimeEnabledPluginIds([]);
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
          model: 'all-MiniLM-L6-v2',
        },
      },
    });
  });

  it('启用 memory-lancedb-pro 时不会覆盖用户已经手动设置的 embedding 配置', async () => {
    writeManagedPluginSource('memory-lancedb-pro');
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

    const { setRuntimeEnabledPluginIds } = await import('../../runtime-host/application/plugins/runtime-plugin-service');

    await setRuntimeEnabledPluginIds(['memory-lancedb-pro']);

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

  it('启动时会为已启用的 memory-lancedb-pro 补齐默认记忆配置', async () => {
    writeInstalledOpenClawPlugin('memory-lancedb-pro');
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

    const { ensureConfiguredManagedPluginsInstalled } = await import('../../runtime-host/application/plugins/runtime-plugin-service');

    const enabledPluginIds = await ensureConfiguredManagedPluginsInstalled();
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
          model: 'all-MiniLM-L6-v2',
        },
        autoCapture: true,
        autoRecall: true,
        smartExtraction: true,
        extractMinMessages: 5,
        extractMaxChars: 8000,
        sessionMemory: {
          enabled: false,
        },
      },
    });
  });
});
