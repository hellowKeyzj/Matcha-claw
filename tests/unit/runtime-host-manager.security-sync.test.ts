import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const childRequestMock = vi.fn();
  const childHealthMock = vi.fn(async () => ({
    version: 1 as const,
    ok: true,
    lifecycle: 'running' as const,
  }));
  const createRuntimeHostHttpClientMock = vi.fn(() => ({
    request: childRequestMock,
    checkHealth: childHealthMock,
  }));
  const createRuntimeHostProcessManagerMock = vi.fn(() => ({
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    checkHealth: vi.fn(async () => ({ ok: true, lifecycle: 'running' })),
    getState: vi.fn(() => ({
      lifecycle: 'running',
      port: 3211,
    })),
  }));
  const getSettingMock = vi.fn(async (key: string) => {
    if (key === 'pluginExecutionEnabled') return true;
    if (key === 'pluginEnabledIds') return ['security-core'];
    return undefined;
  });

  return {
    childRequestMock,
    childHealthMock,
    createRuntimeHostHttpClientMock,
    createRuntimeHostProcessManagerMock,
    getSettingMock,
  };
});

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

vi.mock('../../electron/services/providers/oauth/browser-oauth-manager', () => ({
  browserOAuthManager: {
    startFlow: vi.fn(async () => {}),
    stopFlow: vi.fn(async () => {}),
    submitManualCode: vi.fn(() => true),
  },
}));

vi.mock('../../electron/services/providers/oauth/device-oauth-manager', () => ({
  deviceOAuthManager: {
    startFlow: vi.fn(async () => {}),
    stopFlow: vi.fn(async () => {}),
  },
}));

vi.mock('../../electron/services/license/license-gate-service', () => ({
  waitForLicenseGateBootstrap: vi.fn(async () => {}),
  getLicenseGateSnapshot: vi.fn(() => ({})),
  getStoredLicenseKey: vi.fn(async () => null),
  validateLicenseKey: vi.fn(async () => ({ success: true })),
  forceRevalidateStoredLicense: vi.fn(async () => ({ success: true })),
  clearStoredLicenseData: vi.fn(async () => {}),
}));

const warn = vi.fn();

vi.mock('../../electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('runtime-host manager security sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.childRequestMock.mockReset();
  });

  it('通过 runtime-host 子进程路由触发安全策略同步', async () => {
    hoisted.childRequestMock.mockResolvedValueOnce({
      status: 200,
      data: { synced: true },
    });

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: { getStatus: () => ({ port: 18789, state: 'running' }) } as never,
    });

    const result = await manager.syncSecurityPolicyToGatewayIfRunning();

    expect(result).toBe(true);
    expect(hoisted.childRequestMock).toHaveBeenCalledWith('POST', '/api/security/sync-current-policy');
  });

  it('子进程同步失败时返回 false 并记录警告', async () => {
    hoisted.childRequestMock.mockRejectedValueOnce(new Error('child sync failed'));

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: { getStatus: () => ({ port: 18789, state: 'running' }) } as never,
    });

    const result = await manager.syncSecurityPolicyToGatewayIfRunning();

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith('Failed to sync security policy through runtime-host child: child sync failed');
  });
});
