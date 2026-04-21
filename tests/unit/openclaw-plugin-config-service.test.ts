import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  it('从 openclaw.json 读取真实启用插件列表', async () => {
    const browserPluginDir = join(openclawDir, 'dist', 'extensions', 'browser');
    const pluginADir = join(configDir, 'extensions', 'plugin-a');
    const pluginBDir = join(configDir, 'extensions', 'plugin-b');
    const pluginCDir = join(configDir, 'extensions', 'plugin-c');
    mkdirSync(browserPluginDir, { recursive: true });
    mkdirSync(pluginADir, { recursive: true });
    mkdirSync(pluginBDir, { recursive: true });
    mkdirSync(pluginCDir, { recursive: true });
    writeFileSync(join(browserPluginDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser',
      enabledByDefault: true,
    }, null, 2));
    writeFileSync(join(pluginADir, 'openclaw.plugin.json'), JSON.stringify({ id: 'plugin-a' }, null, 2));
    writeFileSync(join(pluginBDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'plugin-b' }, null, 2));
    writeFileSync(join(pluginCDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'plugin-c' }, null, 2));

    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['plugin-a', 'plugin-b', 'plugin-c'],
        entries: {
          'plugin-a': { enabled: true },
          'plugin-b': { enabled: false },
        },
      },
    }, null, 2));

    const { readEnabledPluginIdsFromOpenClawConfig } = await import('../../runtime-host/application/openclaw/openclaw-plugin-config-service');

    expect(readEnabledPluginIdsFromOpenClawConfig()).toEqual(['plugin-a', 'plugin-c']);
  });

  it('bundled enabledByDefault 插件在没有 allowlist 时也会判定为启用', async () => {
    const browserPluginDir = join(openclawDir, 'dist', 'extensions', 'browser');
    mkdirSync(browserPluginDir, { recursive: true });
    writeFileSync(join(browserPluginDir, 'openclaw.plugin.json'), JSON.stringify({
      id: 'browser',
      enabledByDefault: true,
    }, null, 2));

    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({}, null, 2));

    const { readEnabledPluginIdsFromOpenClawConfig } = await import('../../runtime-host/application/openclaw/openclaw-plugin-config-service');

    expect(readEnabledPluginIdsFromOpenClawConfig()).toEqual(['browser']);
  });

  it('bundled enabledByDefault 插件显式禁用后不会再返回启用列表', async () => {
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

    const { readEnabledPluginIdsFromOpenClawConfig } = await import('../../runtime-host/application/openclaw/openclaw-plugin-config-service');

    expect(readEnabledPluginIdsFromOpenClawConfig()).toEqual([]);
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

    const { syncEnabledPluginIdsToOpenClawConfig } = await import('../../runtime-host/application/openclaw/openclaw-plugin-config-service');

    await syncEnabledPluginIdsToOpenClawConfig(['plugin-b', 'unit-test-plugin']);

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

    expect(nextConfig.plugins.allow).toEqual(['plugin-b', 'unit-test-plugin']);
    expect(nextConfig.plugins.entries['plugin-a']).toMatchObject({
      enabled: false,
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

    const { syncEnabledPluginIdsToOpenClawConfig } = await import('../../runtime-host/application/openclaw/openclaw-plugin-config-service');

    const effectivePluginIds = await syncEnabledPluginIdsToOpenClawConfig(['task-manager']);

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

  it('同步 browserMode=relay 时会关闭 bundled browser 并启用 browser-relay', async () => {
    const browserPluginDir = join(openclawDir, 'dist', 'extensions', 'browser');
    const relaySourceDir = join(workspaceDir, 'build', 'openclaw-plugins', 'browser-relay');
    mkdirSync(browserPluginDir, { recursive: true });
    mkdirSync(relaySourceDir, { recursive: true });
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
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      browser: {
        enabled: true,
        defaultProfile: 'openclaw',
      },
      plugins: {
        allow: ['browser'],
        entries: {
          browser: { enabled: true },
        },
      },
    }, null, 2));

    const { syncBrowserModeToOpenClaw } = await import('../../runtime-host/application/openclaw/openclaw-provider-config-service');

    await syncBrowserModeToOpenClaw('relay');

    const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
      browser: { enabled?: boolean; defaultProfile?: string };
      plugins: {
        allow: string[];
        entries: Record<string, { enabled?: boolean }>;
      };
    };

    expect(nextConfig.browser).toEqual({ enabled: true });
    expect(nextConfig.plugins.allow).toContain('browser-relay');
    expect(nextConfig.plugins.allow).not.toContain('browser');
    expect(nextConfig.plugins.entries.browser).toMatchObject({ enabled: false });
    expect(nextConfig.plugins.entries['browser-relay']).toMatchObject({ enabled: true });
    expect(readFileSync(join(configDir, 'extensions', 'browser-relay', 'openclaw.plugin.json'), 'utf8')).toContain('"id": "browser-relay"');
  });
});
