import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('gateway config sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.runtimeHostRequestMock.mockResolvedValue({ status: 200, data: { success: true } });
  });

  it('gateway 启动前会通过 runtime-host 执行单一路径准备', async () => {
    const { prepareGatewayRuntimeBeforeLaunch } = await import('../../electron/gateway/config-sync');
    await prepareGatewayRuntimeBeforeLaunch({
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    } as Awaited<ReturnType<typeof import('../../electron/services/settings/settings-store').getAllSettings>>);

    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'POST',
      '/api/runtime-host/prepare-gateway-launch',
      {
        gatewayToken: 'matchaclaw-token-1',
        proxyEnabled: true,
        proxyServer: 'http://127.0.0.1:7890',
        proxyBypassRules: '<local>',
      },
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
    } as Awaited<ReturnType<typeof import('../../electron/services/settings/settings-store').getAllSettings>>)).rejects.toThrow('runtime-host offline');

    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'POST',
      '/api/runtime-host/prepare-gateway-launch',
      {
        gatewayToken: 'matchaclaw-token-1',
        proxyEnabled: true,
        proxyServer: 'http://127.0.0.1:7890',
        proxyBypassRules: '<local>',
      },
    );
  });
});
