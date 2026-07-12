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
    forceTerminate: vi.fn(async () => {}),
    checkHealth: vi.fn(async () => ({ ok: true, lifecycle: 'running' })),
    getState: vi.fn(() => ({
      lifecycle: 'running',
      port: 3211,
    })),
    onStateChange: vi.fn(() => () => {}),
  })),
  getOpenClawDirMock: vi.fn(() => 'E:\\code\\Matcha-claw\\node_modules\\openclaw'),
}));

vi.mock('../../electron/main/runtime-host-contract', () => ({
  DEFAULT_ENABLED_PLUGIN_IDS: ['security-core'],
  normalizePluginIds: (pluginIds: readonly string[]) => Array.from(new Set(pluginIds)),
}));

vi.mock('../../electron/main/runtime-host-client', () => ({
  createRuntimeHostHttpClient: hoisted.createRuntimeHostHttpClientMock,
}));

vi.mock('../../electron/main/process-runtime/runtime-host-process-manager', () => ({
  createRuntimeHostProcessManager: hoisted.createRuntimeHostProcessManagerMock,
}));

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawDir: hoisted.getOpenClawDirMock,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '0.0.0-test',
    getName: () => 'MatchaClaw',
    getPath: () => 'E:\\code\\Matcha-claw\\.tmp-test-user-data',
  },
  shell: {
    openPath: vi.fn(async () => ''),
  },
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

  it('OpenAI 走 browser OAuth，设备 OAuth provider 走 device OAuth', async () => {
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: { getStatus: () => ({ processState: 'running', port: 18789 }), debouncedRestart: vi.fn() } as never,
    });

    await manager.executeShellAction('provider_oauth_start', {
      provider: 'openai',
      flowId: 'flow-browser',
      accountId: 'acc-browser',
      label: 'Browser',
    });
    await manager.executeShellAction('provider_oauth_start', {
      provider: 'qwen-portal',
      region: 'cn',
      flowId: 'flow-device',
      accountId: 'acc-device',
      label: 'Device',
    });

    expect(hoisted.browserStartFlow).toHaveBeenCalledWith('openai', {
      flowId: 'flow-browser',
      accountId: 'acc-browser',
      label: 'Browser',
    });
    expect(hoisted.deviceStartFlow).toHaveBeenCalledWith('qwen-portal', 'cn', {
      flowId: 'flow-device',
      accountId: 'acc-device',
      label: 'Device',
    });
  });

  it('cancel/manual-code 只走匹配 flow/account/vendor 的主进程 OAuth manager', async () => {
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: { getStatus: () => ({ processState: 'running', port: 18789 }), debouncedRestart: vi.fn() } as never,
    });
    const binding = { flowId: 'flow-browser', accountId: 'acc-browser', vendorId: 'openai' };

    await manager.executeShellAction('provider_oauth_cancel', binding);
    await expect(
      manager.executeShellAction('provider_oauth_submit', { ...binding, code: '123456' }),
    ).resolves.toEqual({
      status: 200,
      data: { success: true },
    });

    expect(hoisted.deviceStopFlow).toHaveBeenCalledWith(binding);
    expect(hoisted.browserStopFlow).toHaveBeenCalledWith(binding);
    expect(hoisted.browserSubmitManualCode).toHaveBeenCalledWith({ ...binding, code: '123456' });
  });

  it('rejects cancel/manual-code without OAuth flow binding', async () => {
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: { getStatus: () => ({ processState: 'running', port: 18789 }), debouncedRestart: vi.fn() } as never,
    });

    await expect(manager.executeShellAction('provider_oauth_cancel')).resolves.toMatchObject({ status: 400 });
    await expect(manager.executeShellAction('provider_oauth_submit', { code: '123456' })).resolves.toMatchObject({ status: 400 });

    expect(hoisted.deviceStopFlow).not.toHaveBeenCalled();
    expect(hoisted.browserStopFlow).not.toHaveBeenCalled();
    expect(hoisted.browserSubmitManualCode).not.toHaveBeenCalled();
  });
});
