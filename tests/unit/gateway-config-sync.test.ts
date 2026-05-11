import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({
  runtimeHostRequestMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => 'C:\\temp'),
  },
}));

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawDir: vi.fn(() => path.join(process.cwd(), '.tmp', 'gateway-config-sync-openclaw')),
  getOpenClawEntryPath: vi.fn(() => path.join(process.cwd(), '.tmp', 'gateway-config-sync-openclaw', 'openclaw.mjs')),
  isOpenClawPresent: vi.fn(() => true),
}));

vi.mock('../../electron/utils/uv-env', () => ({
  getUvMirrorEnv: vi.fn(async () => ({})),
}));

vi.mock('../../electron/utils/proxy', () => ({
  buildProxyEnv: vi.fn(() => ({})),
  resolveProxySettings: vi.fn(() => ({
    httpProxy: '',
    httpsProxy: '',
    allProxy: '',
  })),
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: {
    info: (...args: unknown[]) => hoisted.loggerInfoMock(...args),
    warn: (...args: unknown[]) => hoisted.loggerWarnMock(...args),
  },
}));

vi.mock('../../electron/utils/env-path', () => ({
  prependPathEntry: vi.fn((env: Record<string, string | undefined>) => ({ env })),
}));

vi.mock('../../electron/utils/fs-path', () => ({
  fsPath: (value: string) => value,
}));

vi.mock('../../electron/gateway/bundled-plugins-mirror', () => ({
  ensureBundledPluginsMirrorDir: vi.fn(async () => undefined),
}));

vi.mock('../../electron/main/runtime-host-client', () => ({
  createDefaultRuntimeHostHttpClient: vi.fn(() => ({
    request: (...args: unknown[]) => hoisted.runtimeHostRequestMock(...args),
  })),
}));

vi.mock('../../electron/gateway/config-sync-env', () => ({
  stripSystemdSupervisorEnv: vi.fn((env: Record<string, string | undefined>) => env),
}));

describe('gateway config sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const openclawDir = path.join(process.cwd(), '.tmp', 'gateway-config-sync-openclaw');
    rmSync(openclawDir, { recursive: true, force: true });
    mkdirSync(openclawDir, { recursive: true });
    writeFileSync(path.join(openclawDir, 'openclaw.mjs'), '', 'utf8');
    hoisted.runtimeHostRequestMock.mockImplementation(async (_method: string, route: string) => {
      if (route === '/api/runtime-host/host-bootstrap-settings') {
        return {
          status: 200,
          data: {
            success: true,
            settings: {
              gatewayToken: 'matchaclaw-token-1',
              proxyEnabled: true,
              proxyServer: 'http://127.0.0.1:7890',
              proxyBypassRules: '<local>',
              gatewayAutoStart: true,
              launchAtStartup: false,
            },
          },
        };
      }
      if (route === '/api/runtime-host/gateway-launch-plan') {
        return {
          status: 200,
          data: {
            success: true,
            plan: {
              gatewayToken: 'matchaclaw-token-1',
              providerEnv: {},
              loadedProviderKeyCount: 0,
              skipChannels: true,
              channelStartupSummary: 'skipped(no configured channels)',
            },
          },
        };
      }
      if (route === '/api/runtime-host/prepare-gateway-launch') {
        return {
          status: 202,
          data: {
            success: true,
            job: {
              id: 'job-prelaunch-1',
              type: 'runtimeHost.gatewayPrelaunch',
              status: 'queued',
            },
          },
        };
      }
      if (route === '/api/runtime-host/jobs/get') {
        return {
          status: 200,
          data: {
            success: true,
            job: {
              id: 'job-prelaunch-1',
              type: 'runtimeHost.gatewayPrelaunch',
              status: 'succeeded',
            },
          },
        };
      }
      return { status: 200, data: { success: true } };
    });
  });

  it('gateway 启动前会通过 runtime-host 执行单一路径准备', async () => {
    const { prepareGatewayRuntimeBeforeLaunch } = await import('../../electron/gateway/config-sync');
    await prepareGatewayRuntimeBeforeLaunch({
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    });

    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'POST',
      '/api/runtime-host/prepare-gateway-launch',
    );
    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'POST',
      '/api/runtime-host/jobs/get',
      { jobId: 'job-prelaunch-1' },
      { timeoutMs: 8000 },
    );
  });

  it('runtime-host 准备失败时不再执行本地 fallback', async () => {
    hoisted.runtimeHostRequestMock.mockRejectedValueOnce(new Error('runtime-host offline'));

    const { prepareGatewayRuntimeBeforeLaunch } = await import('../../electron/gateway/config-sync');
    await expect(prepareGatewayRuntimeBeforeLaunch({
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    })).rejects.toThrow('runtime-host offline');

    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'POST',
      '/api/runtime-host/prepare-gateway-launch',
    );
  });

  it('Gateway 启动准备不再由 Electron 删除 OpenClaw extensions', async () => {
    const staleDir = path.join(process.cwd(), '.tmp', 'gateway-config-sync-fake-openclaw', 'extensions', 'discord');
    mkdirSync(staleDir, { recursive: true });

    const { prepareGatewayRuntimeBeforeLaunch } = await import('../../electron/gateway/config-sync');
    await prepareGatewayRuntimeBeforeLaunch({
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    });

    expect(existsSync(staleDir)).toBe(true);
    rmSync(staleDir, { recursive: true, force: true });
  });

  it('Gateway 启动上下文只消费 runtime-host 输出的宿主设置和启动计划', async () => {
    const { prepareGatewayLaunchContext } = await import('../../electron/gateway/config-sync');

    const context = await prepareGatewayLaunchContext(18789);

    expect(context.gatewayArgs).toEqual([
      'gateway',
      '--port',
      '18789',
      '--token',
      'matchaclaw-token-1',
      '--allow-unconfigured',
    ]);
    expect(context.channelStartupSummary).toBe('skipped(no configured channels)');
    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'GET',
      '/api/runtime-host/host-bootstrap-settings',
    );
    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'GET',
      '/api/runtime-host/gateway-launch-plan',
    );
  });
});
