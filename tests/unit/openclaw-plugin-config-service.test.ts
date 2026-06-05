import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestPluginFileSystem } from './helpers/plugin-file-system';
import { createTestRuntimeLogger } from './helpers/runtime-logger';

function createConfigRepository(configDir: string, openclawDir: string) {
  return {
    read: async () => JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as Record<string, unknown>,
    write: async (config: Record<string, unknown>) => {
      writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify(config, null, 2), 'utf8');
    },
    updateDirty: async <T>(mutate: (config: Record<string, unknown>) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean }) => {
      const config = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as Record<string, unknown>;
      const update = await mutate(config);
      if (update.changed) {
        writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify(config, null, 2), 'utf8');
      }
      return update.result;
    },
    getConfigDir: () => configDir,
    getConfigFilePath: () => join(configDir, 'openclaw.json'),
    getOpenClawDirPath: () => openclawDir,
  };
}

async function createPluginConfigService(configDir: string, openclawDir: string) {
  const { OpenClawPluginConfigService } = await import('../../runtime-host/application/adapters/openclaw/projections/openclaw-plugin-config-service');
  const { OpenClawPluginConfigWorkflow } = await import('../../runtime-host/application/adapters/openclaw/workflows/openclaw-plugin/openclaw-plugin-config-workflow');
  return new OpenClawPluginConfigService(new OpenClawPluginConfigWorkflow({
    configRepository: createConfigRepository(configDir, openclawDir),
    pluginFileSystem: createTestPluginFileSystem(),
  }));
}

describe('openclaw plugin config service', () => {
  let configDir: string;
  let openclawDir: string;
  let workspaceDir: string;
  let previousConfigDir: string | undefined;
  let previousOpenClawDir: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    previousOpenClawDir = process.env.MATCHACLAW_OPENCLAW_DIR;
    previousCwd = process.cwd();
    configDir = mkdtempSync(join(tmpdir(), 'openclaw-plugin-config-'));
    openclawDir = mkdtempSync(join(tmpdir(), 'openclaw-bundled-plugins-'));
    workspaceDir = mkdtempSync(join(tmpdir(), 'openclaw-workspace-'));
    process.env.OPENCLAW_CONFIG_DIR = configDir;
    process.env.MATCHACLAW_OPENCLAW_DIR = openclawDir;
    process.chdir(workspaceDir);
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCLAW_CONFIG_DIR;
    } else {
      process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
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

  it('插件中心只从 openclaw.json 读取 MatchaClaw 能力插件启用列表', async () => {
    const pluginADir = join(configDir, 'extensions', 'task-manager');
    const pluginBDir = join(configDir, 'extensions', 'security-core');
    const pluginCDir = join(configDir, 'extensions', 'custom-plugin');
    const browserPluginDir = join(openclawDir, 'dist', 'extensions', 'browser');
    mkdirSync(pluginADir, { recursive: true });
    mkdirSync(pluginBDir, { recursive: true });
    mkdirSync(pluginCDir, { recursive: true });
    mkdirSync(browserPluginDir, { recursive: true });
    writeFileSync(join(browserPluginDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser',
      enabledByDefault: true,
    }, null, 2));
    writeFileSync(join(pluginADir, 'openclaw.plugin.json'), JSON.stringify({ id: 'task-manager' }, null, 2));
    writeFileSync(join(pluginBDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'security-core' }, null, 2));
    writeFileSync(join(pluginCDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'custom-plugin' }, null, 2));

    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['task-manager', 'security-core', 'custom-plugin', 'browser'],
        entries: {
          'task-manager': { enabled: true },
          'security-core': { enabled: false },
          'custom-plugin': { enabled: true },
          browser: { enabled: true },
        },
      },
    }, null, 2));

    const service = await createPluginConfigService(configDir, openclawDir);

    await expect(service.readEnabledPluginIds()).resolves.toEqual(['task-manager']);
  });

  it('bundled enabledByDefault 插件不会进入插件中心启用列表', async () => {
    const browserPluginDir = join(openclawDir, 'dist', 'extensions', 'browser');
    mkdirSync(browserPluginDir, { recursive: true });
    writeFileSync(join(browserPluginDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser',
      enabledByDefault: true,
    }, null, 2));

    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({}, null, 2));

    const service = await createPluginConfigService(configDir, openclawDir);

    await expect(service.readEnabledPluginIds()).resolves.toEqual([]);
  });

  it('bundled enabledByDefault 插件显式禁用后也不会进入插件中心启用列表', async () => {
    const browserPluginDir = join(openclawDir, 'dist', 'extensions', 'browser');
    mkdirSync(browserPluginDir, { recursive: true });
    writeFileSync(join(browserPluginDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser',
      enabledByDefault: true,
    }, null, 2));

    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        entries: {
          browser: { enabled: false },
        },
      },
    }, null, 2));

    const service = await createPluginConfigService(configDir, openclawDir);

    await expect(service.readEnabledPluginIds()).resolves.toEqual([]);
  });

  it('同步启用插件列表时会更新 allow/entries 并保留安装元数据', async () => {
    const pluginRoot = join(configDir, 'extensions', 'unit-test-plugin');
    mkdirSync(join(pluginRoot, 'skills', 'unit-skill'), { recursive: true });
    writeFileSync(join(pluginRoot, 'openclaw.plugin.json'), JSON.stringify({
      id: 'unit-test-plugin',
      skills: ['./skills'],
    }, null, 2));
    writeFileSync(join(pluginRoot, 'skills', 'unit-skill', 'SKILL.md'), '# unit skill\n', 'utf8');
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['plugin-a'],
        entries: {
          'plugin-a': { enabled: true, source: 'path' },
          'plugin-b': { enabled: true, source: 'npm' },
          'unit-test-plugin': { enabled: false, source: 'path' },
        },
        load: {
          paths: ['/tmp/existing-plugin-path'],
        },
        installs: {
          'plugin-a': { installPath: '/tmp/plugin-a' },
        },
      },
      skills: {
        entries: {
          'unit-skill': { enabled: false, env: { sample: '1' } },
        },
      },
    }, null, 2));

    const service = await createPluginConfigService(configDir, openclawDir);

    await service.syncEnabledPluginIds(['plugin-b', 'unit-test-plugin']);

    const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
      plugins: {
        allow: string[];
        entries: Record<string, { enabled?: boolean; source?: string }>;
        load?: { paths: string[] };
        installs: Record<string, { installPath?: string }>;
      };
      skills: {
        entries: Record<string, { enabled?: boolean; env?: Record<string, string> }>;
      };
    };

    expect(nextConfig.plugins.allow).toEqual(['plugin-a', 'plugin-b', 'unit-test-plugin']);
    expect(nextConfig.plugins.entries['plugin-a']).toMatchObject({
      enabled: true,
      source: 'path',
    });
    expect(nextConfig.plugins.entries['plugin-b']).toMatchObject({
      enabled: true,
      source: 'npm',
    });
    expect(nextConfig.plugins.installs['plugin-a']).toMatchObject({
      installPath: '/tmp/plugin-a',
    });
    expect(nextConfig.plugins.load?.paths).toEqual(['/tmp/existing-plugin-path']);
    expect(nextConfig.skills.entries['unit-skill']).toMatchObject({
      enabled: true,
      env: { sample: '1' },
    });
  });

  it('同步启用插件列表时保留已有 bundled allowlist，但不会新增 bundled provider 插件', async () => {
    const openaiPluginDir = join(openclawDir, 'dist', 'extensions', 'openai');
    const acpxPluginDir = join(openclawDir, 'dist', 'extensions', 'acpx');
    mkdirSync(openaiPluginDir, { recursive: true });
    mkdirSync(acpxPluginDir, { recursive: true });
    writeFileSync(join(openaiPluginDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'openai',
      enabledByDefault: true,
      providers: ['openai'],
    }, null, 2));
    writeFileSync(join(acpxPluginDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'acpx',
      enabledByDefault: true,
    }, null, 2));
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['task-manager', 'acpx'],
        entries: {
          'task-manager': { enabled: true },
          acpx: { enabled: true },
          openai: { enabled: true },
        },
      },
    }, null, 2));

    const service = await createPluginConfigService(configDir, openclawDir);

    await service.syncEnabledPluginIds(['task-manager', 'openai']);

    const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
      plugins: {
        allow: string[];
        entries: Record<string, { enabled?: boolean }>;
      };
    };

    expect(nextConfig.plugins.allow).toEqual(['acpx', 'task-manager']);
    expect(nextConfig.plugins.allow).not.toContain('openai');
    expect(nextConfig.plugins.entries.acpx).toMatchObject({ enabled: true });
    expect(nextConfig.plugins.entries.openai).toMatchObject({ enabled: true });
  });

  it('手动插件列表同步时会保留由渠道配置派生的插件启用状态', async () => {
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            default: {
              appId: 'cli_xxx',
              appSecret: 'secret',
              enabled: true,
            },
          },
        },
      },
      plugins: {
        allow: ['openclaw-lark'],
        entries: {
          'openclaw-lark': { enabled: true },
        },
      },
    }, null, 2));

    const service = await createPluginConfigService(configDir, openclawDir);

    const effectivePluginIds = await service.syncEnabledPluginIds(['task-manager']);

    const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
      plugins: {
        allow: string[];
        entries: Record<string, { enabled?: boolean }>;
      };
    };

    expect(effectivePluginIds).toEqual(['task-manager', 'openclaw-lark']);
    expect(nextConfig.plugins.allow).toEqual(['task-manager', 'openclaw-lark']);
    expect(nextConfig.plugins.entries['task-manager']).toMatchObject({ enabled: true });
    expect(nextConfig.plugins.entries['openclaw-lark']).toMatchObject({ enabled: true });
  });

  it('启用 openclaw-lark 时即使原配置没有 entries.feishu 也会显式禁用 built-in feishu', async () => {
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            default: {
              appId: 'cli_xxx',
              appSecret: 'secret',
              enabled: true,
            },
          },
        },
      },
      plugins: {
        allow: ['openclaw-lark'],
        entries: {
          'openclaw-lark': { enabled: true },
        },
      },
    }, null, 2));

    const service = await createPluginConfigService(configDir, openclawDir);

    await service.syncEnabledPluginIds(['task-manager']);

    const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
      plugins: {
        entries: Record<string, { enabled?: boolean }>;
      };
    };

    expect(nextConfig.plugins.entries.feishu).toMatchObject({ enabled: false });
    expect(nextConfig.plugins.entries['openclaw-lark']).toMatchObject({ enabled: true });
  });

  it('同步手动插件列表时会清理未配置渠道残留的外部插件目录', async () => {
    const feishuPluginDir = join(configDir, 'extensions', 'openclaw-lark');
    const taskManagerDir = join(configDir, 'extensions', 'task-manager');
    mkdirSync(feishuPluginDir, { recursive: true });
    mkdirSync(taskManagerDir, { recursive: true });
    writeFileSync(join(feishuPluginDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'openclaw-lark' }, null, 2));
    writeFileSync(join(taskManagerDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'task-manager' }, null, 2));
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['task-manager'],
        entries: {
          'task-manager': { enabled: true },
          'openclaw-lark': { enabled: false },
        },
      },
    }, null, 2));

    const service = await createPluginConfigService(configDir, openclawDir);

    await service.syncEnabledPluginIds(['task-manager']);

    expect(() => readFileSync(join(taskManagerDir, 'openclaw.plugin.json'), 'utf8')).not.toThrow();
    expect(() => readFileSync(join(feishuPluginDir, 'openclaw.plugin.json'), 'utf8')).toThrow();
  });

  it('已配置渠道对应的外部插件目录不会被清理', async () => {
    const feishuPluginDir = join(configDir, 'extensions', 'openclaw-lark');
    mkdirSync(feishuPluginDir, { recursive: true });
    writeFileSync(join(feishuPluginDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'openclaw-lark' }, null, 2));
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            default: {
              appId: 'cli_xxx',
              appSecret: 'secret',
              enabled: true,
            },
          },
        },
      },
      plugins: {
        allow: ['openclaw-lark'],
        entries: {
          'openclaw-lark': { enabled: true },
        },
      },
    }, null, 2));

    const service = await createPluginConfigService(configDir, openclawDir);

    await service.syncEnabledPluginIds(['task-manager']);

    expect(readFileSync(join(feishuPluginDir, 'openclaw.plugin.json'), 'utf8')).toContain('"openclaw-lark"');
  });

  it('同步 browserMode=relay 时会关闭 bundled browser 并启用 browser-relay', async () => {
    const browserPluginDir = join(openclawDir, 'dist', 'extensions', 'browser');
    const relaySourceDir = join(workspaceDir, 'build', 'openclaw-plugins', 'browser-relay');
    const taskManagerSourceDir = join(workspaceDir, 'build', 'openclaw-plugins', 'task-manager');
    mkdirSync(browserPluginDir, { recursive: true });
    mkdirSync(relaySourceDir, { recursive: true });
    mkdirSync(taskManagerSourceDir, { recursive: true });
    writeFileSync(join(browserPluginDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser',
      enabledByDefault: true,
    }, null, 2));
    writeFileSync(join(relaySourceDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser-relay-src',
      name: 'Browser Relay',
      version: '1.0.0',
      category: 'runtime',
    }, null, 2));
    writeFileSync(join(relaySourceDir, 'package.json'), JSON.stringify({
      name: '@matchaclaw/browser-relay',
      version: '1.0.0',
    }, null, 2));
    writeFileSync(join(taskManagerSourceDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'task-manager',
      name: 'Task Manager',
      version: '1.0.0',
      category: 'automation',
    }, null, 2));
    writeFileSync(join(taskManagerSourceDir, 'package.json'), JSON.stringify({
      name: '@matchaclaw/task-manager',
      version: '1.0.0',
    }, null, 2));
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      browser: {
        enabled: true,
        defaultProfile: 'openclaw',
      },
      plugins: {
        allow: ['browser', 'task-manager'],
        entries: {
          browser: { enabled: true },
          'task-manager': { enabled: true },
        },
      },
    }, null, 2));

    const { syncBrowserModeToOpenClaw } = await import('../../runtime-host/application/adapters/openclaw/projections/openclaw-runtime-config-sync');

    await syncBrowserModeToOpenClaw(
      createConfigRepository(configDir, openclawDir),
      createTestPluginFileSystem(),
      'relay',
      createTestRuntimeLogger('openclaw-plugin-config-test'),
    );

    const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
      browser: { enabled?: boolean; defaultProfile?: string };
      plugins: {
        allow: string[];
        deny: string[];
        entries: Record<string, { enabled?: boolean }>;
      };
    };

    expect(nextConfig.browser).toEqual({
      enabled: false,
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect(nextConfig.plugins.allow).toContain('browser-relay');
    expect(nextConfig.plugins.allow).toContain('task-manager');
    expect(nextConfig.plugins.allow).not.toContain('browser');
    expect(nextConfig.plugins.deny).toContain('browser');
    expect(nextConfig.plugins.entries.browser).toMatchObject({ enabled: false });
    expect(nextConfig.plugins.entries['browser-relay']).toMatchObject({ enabled: true });
    expect(nextConfig.plugins.entries['task-manager']).toMatchObject({ enabled: true });
  });

  it('同步 browserMode=native 时会恢复 bundled browser 并移除官方 browser deny', async () => {
    const browserPluginDir = join(openclawDir, 'dist', 'extensions', 'browser');
    mkdirSync(browserPluginDir, { recursive: true });
    writeFileSync(join(browserPluginDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser',
      enabledByDefault: true,
    }, null, 2));
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      browser: {
        enabled: false,
      },
      plugins: {
        allow: ['browser-relay', 'task-manager'],
        deny: ['browser', 'unit-disabled'],
        entries: {
          browser: { enabled: false },
          'browser-relay': { enabled: true },
          'task-manager': { enabled: true },
        },
      },
    }, null, 2));

    const { syncBrowserModeToOpenClaw } = await import('../../runtime-host/application/adapters/openclaw/projections/openclaw-runtime-config-sync');

    await syncBrowserModeToOpenClaw(
      createConfigRepository(configDir, openclawDir),
      createTestPluginFileSystem(),
      'native',
      createTestRuntimeLogger('openclaw-plugin-config-test'),
    );

    const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
      browser: { enabled?: boolean; defaultProfile?: string };
      plugins: {
        allow: string[];
        deny: string[];
        entries: Record<string, { enabled?: boolean }>;
      };
    };

    expect(nextConfig.browser).toEqual({
      enabled: true,
      defaultProfile: 'openclaw',
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect(nextConfig.plugins.allow).toContain('task-manager');
    expect(nextConfig.plugins.allow).not.toContain('browser');
    expect(nextConfig.plugins.allow).not.toContain('browser-relay');
    expect(nextConfig.plugins.deny).toEqual(['unit-disabled']);
    expect(nextConfig.plugins.entries.browser).toMatchObject({ enabled: true });
    expect(nextConfig.plugins.entries['browser-relay']).toMatchObject({ enabled: false });
    expect(nextConfig.plugins.entries['task-manager']).toMatchObject({ enabled: true });
  });

  it('同步 browserMode=relay 只更新配置，不负责覆盖 browser-relay 插件目录', async () => {
    const relaySourceDir = join(workspaceDir, 'build', 'openclaw-plugins', 'browser-relay');
    const relayTargetDir = join(configDir, 'extensions', 'browser-relay');
    mkdirSync(relaySourceDir, { recursive: true });
    mkdirSync(relayTargetDir, { recursive: true });
    writeFileSync(join(relaySourceDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser-relay',
      name: 'Source Browser Relay',
      version: '1.0.0',
      category: 'runtime',
    }, null, 2));
    writeFileSync(join(relaySourceDir, 'package.json'), JSON.stringify({
      name: '@matchaclaw/browser-relay',
      version: '1.0.0',
    }, null, 2));
    writeFileSync(join(relayTargetDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser-relay',
      name: 'Installed Browser Relay',
      version: '1.0.0',
      category: 'runtime',
    }, null, 2));
    writeFileSync(join(relayTargetDir, 'package.json'), JSON.stringify({
      name: '@matchaclaw/browser-relay',
      version: '1.0.0',
    }, null, 2));
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      browser: {
        enabled: true,
      },
      plugins: {
        allow: ['browser-relay'],
        entries: {
          browser: { enabled: false },
          'browser-relay': { enabled: true },
        },
      },
    }, null, 2));

    const { syncBrowserModeToOpenClaw } = await import('../../runtime-host/application/adapters/openclaw/projections/openclaw-runtime-config-sync');

    await syncBrowserModeToOpenClaw(
      createConfigRepository(configDir, openclawDir),
      createTestPluginFileSystem(),
      'relay',
      createTestRuntimeLogger('openclaw-plugin-config-test'),
    );

    const installedManifest = JSON.parse(readFileSync(join(relayTargetDir, 'openclaw.plugin.json'), 'utf8')) as {
      name: string;
    };
    expect(installedManifest.name).toBe('Installed Browser Relay');
  });
});


