import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const hoisted = vi.hoisted(() => {
  const processStateRef: {
    lifecycle: 'idle' | 'starting' | 'running' | 'stopped' | 'error';
    lastError?: string;
  } = {
    lifecycle: 'idle',
  };
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
      lifecycle: processStateRef.lifecycle,
      port: 3211,
      ...(processStateRef.lastError ? { lastError: processStateRef.lastError } : {}),
    })),
  }));
  const setSettingMock = vi.fn(async () => {});
  const shellOpenPathMock = vi.fn(async () => '');
  const getSettingMock = vi.fn(async () => undefined);
  const getOpenClawDirMock = vi.fn(() => 'E:\\code\\Matcha-claw\\node_modules\\openclaw');
  return {
    childRequestMock,
    childHealthMock,
    createRuntimeHostHttpClientMock,
    createRuntimeHostProcessManagerMock,
    setSettingMock,
    shellOpenPathMock,
    getSettingMock,
    getOpenClawDirMock,
    processStateRef,
  };
});

vi.mock('../../electron/main/runtime-host-client', () => {
  class RuntimeHostClientRequestError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly retryable: boolean;

    constructor(message: string, options: { status: number; code?: string; retryable?: boolean }) {
      super(message);
      this.status = options.status;
      this.code = options.code;
      this.retryable = options.retryable ?? false;
    }
  }

  return {
    RuntimeHostClientRequestError,
    createRuntimeHostHttpClient: hoisted.createRuntimeHostHttpClientMock,
  };
});

vi.mock('../../electron/main/runtime-host-process-manager', () => ({
  createRuntimeHostProcessManager: hoisted.createRuntimeHostProcessManagerMock,
}));

vi.mock('../../electron/services/settings/settings-store', () => ({
  getSetting: hoisted.getSettingMock,
  setSetting: hoisted.setSettingMock,
}));

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawDir: hoisted.getOpenClawDirMock,
}));

vi.mock('electron', () => ({
  shell: {
    openPath: (...args: unknown[]) => hoisted.shellOpenPathMock(...args),
  },
}));

vi.mock('../../electron/services/channels/channel-runtime-service', () => ({
  createChannelRuntimeService: vi.fn(() => ({
    startChannelSession: vi.fn(async () => ({ queued: true, sessionKey: 'default' })),
    cancelChannelSession: vi.fn(async () => {}),
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

vi.mock('../../electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('runtime-host manager request transport policy', () => {
  let configDir = '';
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'runtime-host-manager-config-'));
    process.env.OPENCLAW_CONFIG_DIR = configDir;
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['security-core'],
        entries: {
          'security-core': { enabled: true },
        },
      },
    }, null, 2));
    vi.clearAllMocks();
    hoisted.childRequestMock.mockReset();
    hoisted.childHealthMock.mockReset();
    hoisted.childHealthMock.mockResolvedValue({
      version: 1,
      ok: true,
      lifecycle: 'running',
    });
    hoisted.createRuntimeHostHttpClientMock.mockImplementation(() => ({
      request: hoisted.childRequestMock,
      checkHealth: hoisted.childHealthMock,
    }));
    hoisted.shellOpenPathMock.mockReset();
    hoisted.shellOpenPathMock.mockResolvedValue('');
    hoisted.processStateRef.lifecycle = 'idle';
    delete hoisted.processStateRef.lastError;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCLAW_CONFIG_DIR;
    } else {
      process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
    }
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('子进程成功时走 child request', async () => {
    hoisted.childRequestMock.mockResolvedValueOnce({
      status: 200,
      data: { source: 'child' },
    });

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: {} as never,
    });

    const result = await manager.request<{ source: string }>('GET', '/api/workbench/bootstrap');
    expect(result).toEqual({ status: 200, data: { source: 'child' } });
    expect(hoisted.childRequestMock).toHaveBeenCalledWith('GET', '/api/workbench/bootstrap', undefined, undefined);
  });

  it('默认总是走子进程 transport', async () => {
    hoisted.childRequestMock.mockResolvedValueOnce({
      status: 200,
      data: { source: 'child-always-on' },
    });

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: {} as never,
    });

    const result = await manager.request<{ source: string }>('GET', '/api/workbench/bootstrap');
    expect(result).toEqual({ status: 200, data: { source: 'child-always-on' } });
    expect(hoisted.childRequestMock).toHaveBeenCalledWith('GET', '/api/workbench/bootstrap', undefined, undefined);
  });

  it('child 返回 501 时直接抛错，不再回退', async () => {
    const { RuntimeHostClientRequestError } = await import('../../electron/main/runtime-host-client');
    hoisted.childRequestMock.mockRejectedValueOnce(
      new RuntimeHostClientRequestError('not implemented', {
        status: 501,
        code: 'NOT_IMPLEMENTED',
      }),
    );

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: {} as never,
    });

    await expect(
      manager.request<{ source: string }>('GET', '/api/workbench/bootstrap'),
    ).rejects.toMatchObject({
      status: 501,
      code: 'NOT_IMPLEMENTED',
    });
  });

  it('不会暴露 transport disabled 分支', async () => {
    hoisted.childRequestMock.mockResolvedValueOnce({
      status: 200,
      data: { source: 'child' },
    });
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: {} as never,
    });

    const result = await manager.request<{ source: string }>('GET', '/api/workbench/bootstrap');
    expect(result).toEqual({ status: 200, data: { source: 'child' } });
    expect(hoisted.childRequestMock).toHaveBeenCalledTimes(1);
  });

  it('checkHealth 通过 child dispatch 返回 health', async () => {
    hoisted.childRequestMock.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        health: {
          ok: true,
          lifecycle: 'running',
          activePluginCount: 7,
          degradedPlugins: ['plugin-a'],
        },
      },
    });

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: {} as never,
    });

    const health = await manager.checkHealth();
    expect(hoisted.childRequestMock).toHaveBeenCalledWith('GET', '/api/runtime-host/health');
    expect(health).toEqual({
      ok: true,
      lifecycle: 'running',
      activePluginCount: 7,
      degradedPlugins: ['plugin-a'],
    });
  });

  it('getState.runtimeLifecycle 跟随子进程 lifecycle 映射', async () => {
    hoisted.processStateRef.lifecycle = 'starting';

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: {} as never,
    });

    const state = manager.getState();
    expect(state.runtimeLifecycle).toBe('booting');
  });

  it('启动时 gateway 端口仅来自 gatewayManager，不再读取 settings.gatewayPort', async () => {
    const gatewayManager = {
      getStatus: vi.fn(() => ({ state: 'running', port: 19876 })),
    } as never;

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({ gatewayManager });

    await manager.start();

    const processManagerOptions = hoisted.createRuntimeHostProcessManagerMock.mock.calls[0]?.[0] as
      | { childEnv?: () => Record<string, string> }
      | undefined;
    const childEnv = processManagerOptions?.childEnv?.() ?? {};
    expect(childEnv.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT).toBe('19876');
    expect(childEnv.MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN).toBe('');
    expect(childEnv.MATCHACLAW_OPENCLAW_DIR).toBe('E:\\code\\Matcha-claw\\node_modules\\openclaw');
    expect(hoisted.getSettingMock.mock.calls.some((args) => args[0] === 'gatewayPort')).toBe(false);
  });

  it('gatewayManager 返回非法端口时 start 直接失败，不再回退默认端口', async () => {
    const gatewayManager = {
      getStatus: vi.fn(() => ({ state: 'running', port: 0 })),
    } as never;

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({ gatewayManager });

    await expect(manager.start()).rejects.toThrow('Invalid gateway port from gateway manager: 0');
  });

  it('setEnabledPluginIds 在运行态只持久化 execution state，不直接重启 runtime-host 子进程', async () => {
    const gatewayManager = {
      getStatus: vi.fn(() => ({ state: 'running', port: 19876 })),
    } as never;

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({ gatewayManager });

    await manager.start();
    const processManager = hoisted.createRuntimeHostProcessManagerMock.mock.results[0]?.value as
      | { restart: ReturnType<typeof vi.fn> }
      | undefined;

    const result = await manager.setEnabledPluginIds(['task-manager']);

    expect(result).toEqual({
      enabledPluginIds: ['task-manager'],
    });
    expect(processManager?.restart).not.toHaveBeenCalled();
  });

  it('executeShellAction(shell_open_path) 通过主进程 shell.openPath 打开目录', async () => {
    hoisted.shellOpenPathMock.mockResolvedValueOnce('');
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: {} as never,
    });

    const result = await manager.executeShellAction('shell_open_path', {
      path: 'C:\\Users\\Mr.Key\\.openclaw\\skills\\docx',
    });

    expect(hoisted.shellOpenPathMock).toHaveBeenCalledWith('C:\\Users\\Mr.Key\\.openclaw\\skills\\docx');
    expect(result).toEqual({
      status: 200,
      data: { success: true },
    });
  });

  it('executeShellAction(shell_open_path) 在 shell 返回错误时返回失败', async () => {
    hoisted.shellOpenPathMock.mockResolvedValueOnce('Access is denied');
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: {} as never,
    });

    const result = await manager.executeShellAction('shell_open_path', {
      path: 'C:\\Users\\Mr.Key\\.openclaw\\skills\\docx',
    });

    expect(result).toEqual({
      status: 500,
      data: { success: false, error: 'Access is denied' },
    });
  });

  it('executeShellAction(gateway_restart) 会调度 gateway 重启', async () => {
    const debouncedRestart = vi.fn();
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: {
        getStatus: () => ({ state: 'running', port: 19876 }),
        debouncedRestart,
      } as never,
    });

    const result = await manager.executeShellAction('gateway_restart');

    expect(debouncedRestart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 200,
      data: { success: true },
    });
  });
});
