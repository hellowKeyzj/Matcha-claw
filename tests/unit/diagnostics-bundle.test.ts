import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectDiagnosticsBundle } from '@electron/utils/diagnostics-bundle';

async function createFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

describe('collectDiagnosticsBundle', () => {
  it('collects multi-source diagnostics and redacts sensitive JSON fields', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'matchaclaw-diag-test-'));
    const userDataDir = path.join(root, 'userData');
    const openclawConfigDir = path.join(root, 'openclaw');
    const inspectDir = path.join(root, 'inspect');

    try {
      await createFile(path.join(userDataDir, 'logs', 'app.log'), 'line-1');
      await createFile(path.join(userDataDir, 'settings.json'), JSON.stringify({
        proxyServer: 'http://secret.local',
        apiKey: 'sk-hidden',
        gatewayToken: 'gw-hidden',
        safeValue: 'ok',
      }, null, 2));

      await createFile(path.join(openclawConfigDir, 'logs', 'gateway.log'), 'line-2');
      await createFile(path.join(openclawConfigDir, 'openclaw.json'), JSON.stringify({
        gateway: { token: 'gw-secret' },
        auth: { key: 'auth-secret' },
        normal: 'safe',
      }, null, 2));
      await createFile(path.join(openclawConfigDir, 'agents', 'main', 'sessions', 'sessions.json'), '{"items":[]}');
      await createFile(path.join(openclawConfigDir, 'agents', 'main', 'sessions', 'main.jsonl'), '{"type":"assistant"}\n');
      await createFile(path.join(openclawConfigDir, 'workspace', 'AGENTS.md'), '# AGENTS');
      await createFile(path.join(openclawConfigDir, 'workspace-subagents', 'USER.md'), '# USER');
      await createFile(path.join(openclawConfigDir, 'extensions', 'task-manager', 'openclaw.plugin.json'), '{"id":"task-manager"}');

      const result = await collectDiagnosticsBundle({
        userDataDir,
        openclawConfigDir,
        appInfo: {
          name: 'MatchaClaw',
          version: '0.0.0-test',
          isPackaged: false,
          platform: process.platform,
          arch: process.arch,
          electron: 'test',
          node: process.versions.node,
        },
        gateway: {
          status: { state: 'running', port: 18789 },
          runtimePaths: { configDir: openclawConfigDir, workspaceDir: path.join(openclawConfigDir, 'workspace') },
        },
        license: {
          gateSnapshot: { state: 'granted', hasStoredKey: true },
        },
        compressor: async (stagingDir, outputZipPath) => {
          await rm(inspectDir, { recursive: true, force: true });
          await cp(stagingDir, inspectDir, { recursive: true });
          await writeFile(outputZipPath, 'fake-zip', 'utf8');
        },
      });

      expect(result.zipPath.endsWith('.zip')).toBe(true);
      expect(result.fileCount).toBeGreaterThanOrEqual(4);
      expect(result.counts.userDataLogs).toBeGreaterThanOrEqual(1);
      expect(result.counts.openclawLogs).toBeGreaterThanOrEqual(1);
      expect(result.counts.openclawJson).toBe(1);
      expect(result.counts.settingsJson).toBe(1);

      const maskedSettings = JSON.parse(await readFile(path.join(inspectDir, 'userdata', 'settings.json'), 'utf8')) as Record<string, unknown>;
      expect(maskedSettings.proxyServer).toBe('***');
      expect(maskedSettings.apiKey).toBe('***');
      expect(maskedSettings.gatewayToken).toBe('***');
      expect(maskedSettings.safeValue).toBe('ok');

      const maskedOpenClaw = JSON.parse(await readFile(path.join(inspectDir, 'openclaw', 'openclaw.json'), 'utf8')) as Record<string, unknown>;
      expect((maskedOpenClaw.gateway as Record<string, unknown>).token).toBe('***');
      expect((maskedOpenClaw.auth as Record<string, unknown>).key).toBe('***');
      expect(maskedOpenClaw.normal).toBe('safe');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
