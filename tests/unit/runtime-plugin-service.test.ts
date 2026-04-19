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
});
