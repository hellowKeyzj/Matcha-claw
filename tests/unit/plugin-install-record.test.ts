import { describe, expect, it } from 'vitest';
import { upsertPluginInstallRecord } from '@electron/utils/plugin-install-record';

describe('upsertPluginInstallRecord', () => {
  it('creates plugins.installs record for a managed local plugin', () => {
    const { nextConfig, changed } = upsertPluginInstallRecord(
      {},
      {
        pluginId: 'task-manager',
        source: 'path',
        installPath: 'C:\\Users\\tester\\.openclaw\\extensions\\task-manager',
        sourcePath: 'E:\\code\\Matcha-matchaclaw\\packages\\openclaw-task-manager-plugin',
        version: '1.2.3',
        now: () => '2026-03-07T00:00:00.000Z',
      },
    );

    expect(changed).toBe(true);
    expect(nextConfig).toMatchObject({
      plugins: {
        installs: {
          'task-manager': {
            source: 'path',
            installPath: 'C:\\Users\\tester\\.openclaw\\extensions\\task-manager',
            sourcePath: 'E:\\code\\Matcha-matchaclaw\\packages\\openclaw-task-manager-plugin',
            version: '1.2.3',
            installedAt: '2026-03-07T00:00:00.000Z',
            resolvedAt: '2026-03-07T00:00:00.000Z',
          },
        },
      },
    });
  });

  it('is a no-op when record already matches', () => {
    const input = {
      plugins: {
        installs: {
          'task-manager': {
            source: 'path',
            installPath: 'C:\\Users\\tester\\.openclaw\\extensions\\task-manager',
            sourcePath: 'E:\\code\\Matcha-matchaclaw\\packages\\openclaw-task-manager-plugin',
            version: '1.2.3',
            installedAt: '2026-03-07T00:00:00.000Z',
            resolvedAt: '2026-03-07T00:00:00.000Z',
          },
        },
      },
    };

    const { nextConfig, changed } = upsertPluginInstallRecord(
      input,
      {
        pluginId: 'task-manager',
        source: 'path',
        installPath: 'C:\\Users\\tester\\.openclaw\\extensions\\task-manager',
        sourcePath: 'E:\\code\\Matcha-matchaclaw\\packages\\openclaw-task-manager-plugin',
        version: '1.2.3',
      },
    );

    expect(changed).toBe(false);
    expect(nextConfig).toBe(input);
  });

  it('preserves existing install metadata while filling install path', () => {
    const input = {
      plugins: {
        installs: {
          dingtalk: {
            source: 'path',
            spec: '@openclaw/dingtalk-plugin@1.0.0',
            installedAt: '2026-03-01T10:00:00.000Z',
            resolvedAt: '2026-03-01T10:00:00.000Z',
          },
        },
      },
    };

    const { nextConfig, changed } = upsertPluginInstallRecord(
      input,
      {
        pluginId: 'dingtalk',
        source: 'path',
        installPath: 'C:\\Users\\tester\\.openclaw\\extensions\\dingtalk',
      },
    );

    expect(changed).toBe(true);
    expect(nextConfig).toMatchObject({
      plugins: {
        installs: {
          dingtalk: {
            source: 'path',
            spec: '@openclaw/dingtalk-plugin@1.0.0',
            installedAt: '2026-03-01T10:00:00.000Z',
            resolvedAt: '2026-03-01T10:00:00.000Z',
            installPath: 'C:\\Users\\tester\\.openclaw\\extensions\\dingtalk',
          },
        },
      },
    });
  });
});
