import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

    const { ensureConfiguredManagedPluginsForGatewayLaunch } = await import('../../runtime-host/application/runtime-host/prelaunch-plugin-maintenance');
    await ensureConfiguredManagedPluginsForGatewayLaunch();

    const markerPath = join(configDir, 'extensions', 'browser-relay', 'marker.txt');
    writeFileSync(markerPath, 'keep-me', 'utf8');

    await ensureConfiguredManagedPluginsForGatewayLaunch();

    expect(readFileSync(markerPath, 'utf8')).toBe('keep-me');
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

    const { ensureConfiguredManagedPluginsForGatewayLaunch } = await import('../../runtime-host/application/runtime-host/prelaunch-plugin-maintenance');
    await ensureConfiguredManagedPluginsForGatewayLaunch();
    writeManagedPluginSource('browser-relay', '1.1.0', 'Browser Relay v2');

    await ensureConfiguredManagedPluginsForGatewayLaunch();

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

    const { reconcileConfiguredChannelPluginsForGatewayLaunch } = await import('../../runtime-host/application/runtime-host/prelaunch-plugin-maintenance');
    await reconcileConfiguredChannelPluginsForGatewayLaunch();

    const markerPath = join(configDir, 'extensions', 'openclaw-weixin', 'marker.txt');
    writeFileSync(markerPath, 'keep-channel-plugin', 'utf8');

    await reconcileConfiguredChannelPluginsForGatewayLaunch();

    expect(readFileSync(markerPath, 'utf8')).toBe('keep-channel-plugin');
  });
});
