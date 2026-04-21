import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  runtimeHostRequestMock: vi.fn(),
  syncGatewayConfigLocalFallbackMock: vi.fn(async () => ({ configuredChannels: [] })),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => 'C:\\temp'),
  },
}));

vi.mock('../../electron/services/settings/settings-store', () => ({
  getAllSettings: vi.fn(),
}));

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawDir: vi.fn(() => 'C:\\openclaw'),
  getOpenClawEntryPath: vi.fn(() => 'C:\\openclaw\\openclaw.mjs'),
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

vi.mock('../../runtime-host/application/runtime-host/bootstrap', () => ({
  syncGatewayConfigLocal: (...args: unknown[]) => hoisted.syncGatewayConfigLocalFallbackMock(...args),
}));

describe('gateway config sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.runtimeHostRequestMock.mockResolvedValue({ status: 200, data: { success: true } });
    hoisted.syncGatewayConfigLocalFallbackMock.mockResolvedValue({ configuredChannels: [] });
  });

  it('runtime-host 同步失败时会退回本地 gateway config 同步', async () => {
    hoisted.runtimeHostRequestMock.mockRejectedValueOnce(new Error('runtime-host offline'));

    const { syncGatewayConfigBeforeLaunch } = await import('../../electron/gateway/config-sync');
    await syncGatewayConfigBeforeLaunch({
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    } as Awaited<ReturnType<typeof import('../../electron/services/settings/settings-store').getAllSettings>>);

    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'POST',
      '/api/runtime-host/sync-gateway-config',
      {
        gatewayToken: 'matchaclaw-token-1',
        proxyEnabled: true,
        proxyServer: 'http://127.0.0.1:7890',
        proxyBypassRules: '<local>',
      },
    );
    expect(hoisted.syncGatewayConfigLocalFallbackMock).toHaveBeenCalledWith({
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    });
    expect(hoisted.loggerWarnMock).toHaveBeenCalledWith(
      'Failed to sync gateway bootstrap config through runtime-host:',
      expect.any(Error),
    );
    expect(hoisted.loggerInfoMock).toHaveBeenCalledWith('Applied gateway bootstrap config through local fallback sync');
  });

  it('runtime-host 同步成功时不会触发本地 fallback', async () => {
    const { syncGatewayConfigBeforeLaunch } = await import('../../electron/gateway/config-sync');
    await syncGatewayConfigBeforeLaunch({
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: '<local>',
    } as Awaited<ReturnType<typeof import('../../electron/services/settings/settings-store').getAllSettings>>);

    expect(hoisted.syncGatewayConfigLocalFallbackMock).not.toHaveBeenCalled();
  });
});
