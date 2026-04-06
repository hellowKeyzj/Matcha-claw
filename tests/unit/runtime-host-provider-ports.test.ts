import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  browserStartFlow: vi.fn(async () => undefined),
  browserStopFlow: vi.fn(async () => undefined),
  browserSubmitManualCode: vi.fn(() => true),
  deviceStartFlow: vi.fn(async () => undefined),
  deviceStopFlow: vi.fn(async () => undefined),
  createRuntimeHostHttpClientMock: vi.fn(() => ({
    request: vi.fn(),
    checkHealth: vi.fn(async () => ({
      version: 1 as const,
      ok: true,
      lifecycle: 'running' as const,
    })),
  })),
  createRuntimeHostProcessManagerMock: vi.fn(() => ({
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    checkHealth: vi.fn(async () => ({ ok: true, lifecycle: 'running' })),
    getState: vi.fn(() => ({
      lifecycle: 'running',
      port: 3211,
    })),
  })),
  getSettingMock: vi.fn(async (key: string) => {
    if (key === 'pluginExecutionEnabled') return true;
    if (key === 'pluginEnabledIds') return ['security-core'];
    return undefined;
  }),
}));

vi.mock('../../electron/main/runtime-host-contract', () => ({
  DEFAULT_ENABLED_PLUGIN_IDS: ['security-core'],
  DEFAULT_PLUGIN_EXECUTION_ENABLED: true,
  normalizePluginIds: (pluginIds: readonly string[]) => Array.from(new Set(pluginIds)),
}));

vi.mock('../../electron/main/runtime-host-client', () => ({
  createRuntimeHostHttpClient: hoisted.createRuntimeHostHttpClientMock,
}));

vi.mock('../../electron/main/runtime-host-process-manager', () => ({
  createRuntimeHostProcessManager: hoisted.createRuntimeHostProcessManagerMock,
}));

vi.mock('../../electron/services/settings/settings-store', () => ({
  getSetting: hoisted.getSettingMock,
  setSetting: vi.fn(async () => {}),
}));

vi.mock('../../electron/services/channels/channel-runtime-service', () => ({
  createChannelRuntimeService: vi.fn(() => ({
    startWhatsApp: vi.fn(async () => {}),
    cancelWhatsApp: vi.fn(async () => {}),
    startOpenClawWeixin: vi.fn(async () => ({ queued: true, sessionKey: 'default' })),
    cancelOpenClawWeixin: vi.fn(async () => {}),
  })),
}));

vi.mock('../../electron/services/license/license-gate-service', () => ({
  waitForLicenseGateBootstrap: vi.fn(async () => {}),
  getLicenseGateSnapshot: vi.fn(() => ({})),
  getStoredLicenseKey: vi.fn(async () => null),
  validateLicenseKey: vi.fn(async () => ({ success: true })),
  forceRevalidateStoredLicense: vi.fn(async () => ({ success: true })),
  clearStoredLicenseData: vi.fn(async () => {}),
}));

vi.mock('../../electron/services/providers/oauth/browser-oauth-manager', () => ({
  browserOAuthManager: {
    startFlow: hoisted.browserStartFlow,
    stopFlow: hoisted.browserStopFlow,
    submitManualCode: hoisted.browserSubmitManualCode,
  },
}));

vi.mock('../../electron/services/providers/oauth/device-oauth-manager', () => ({
  deviceOAuthManager: {
    startFlow: hoisted.deviceStartFlow,
    stopFlow: hoisted.deviceStopFlow,
  },
}));

describe('runtime-host manager provider oauth action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('按 provider 类型分流 browser/device OAuth', async () => {
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: { getStatus: () => ({ state: 'running', port: 18789 }), debouncedRestart: vi.fn() } as never,
    });

    await manager.executeShellAction('provider_oauth_start', {
      provider: 'google',
      accountId: 'acc-browser',
      label: 'Browser',
    });
    await manager.executeShellAction('provider_oauth_start', {
      provider: 'qwen-portal',
      region: 'cn',
      accountId: 'acc-device',
      label: 'Device',
    });

    expect(hoisted.browserStartFlow).toHaveBeenCalledWith('google', {
      accountId: 'acc-browser',
      label: 'Browser',
    });
    expect(hoisted.deviceStartFlow).toHaveBeenCalledWith('qwen-portal', 'cn', {
      accountId: 'acc-device',
      label: 'Device',
    });
  });

  it('cancel/manual-code 只走主进程 OAuth manager', async () => {
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: { getStatus: () => ({ state: 'running', port: 18789 }), debouncedRestart: vi.fn() } as never,
    });

    await manager.executeShellAction('provider_oauth_cancel');
    await expect(
      manager.executeShellAction('provider_oauth_submit', { code: '123456' }),
    ).resolves.toEqual({
      status: 200,
      data: { success: true },
    });

    expect(hoisted.deviceStopFlow).toHaveBeenCalledTimes(1);
    expect(hoisted.browserStopFlow).toHaveBeenCalledTimes(1);
    expect(hoisted.browserSubmitManualCode).toHaveBeenCalledWith('123456');
  });
});
