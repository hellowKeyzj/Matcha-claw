import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('openclaw plugin config service', () => {
  let configDir: string;
  let previousConfigDir: string | undefined;
  let pluginDiscoveryRoot: string;
  let previousTaskPluginSourceDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    previousTaskPluginSourceDir = process.env.MATCHACLAW_RUNTIME_HOST_TASK_PLUGIN_SOURCE_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'openclaw-plugin-config-'));
    pluginDiscoveryRoot = mkdtempSync(join(tmpdir(), 'openclaw-plugin-root-'));
    process.env.OPENCLAW_CONFIG_DIR = configDir;
    process.env.MATCHACLAW_RUNTIME_HOST_TASK_PLUGIN_SOURCE_DIR = join(pluginDiscoveryRoot, 'placeholder');
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCLAW_CONFIG_DIR;
    } else {
      process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
    }
    if (previousTaskPluginSourceDir === undefined) {
      delete process.env.MATCHACLAW_RUNTIME_HOST_TASK_PLUGIN_SOURCE_DIR;
    } else {
      process.env.MATCHACLAW_RUNTIME_HOST_TASK_PLUGIN_SOURCE_DIR = previousTaskPluginSourceDir;
    }
    rmSync(pluginDiscoveryRoot, { recursive: true, force: true });
  });

  it('从 openclaw.json 读取真实启用插件列表', async () => {
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

  it('同步启用插件列表时会更新 allow/entries 并保留安装元数据', async () => {
    const pluginRoot = join(pluginDiscoveryRoot, 'unit-test-plugin');
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
    expect(nextConfig.skills.entries['unit-skill']).toMatchObject({
      enabled: true,
      env: { sample: '1' },
    });
  });
});
