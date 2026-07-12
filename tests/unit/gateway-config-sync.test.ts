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

vi.mock('../../electron/main/runtime-host-client', () => ({
  createDefaultRuntimeHostHttpClient: vi.fn(() => ({
    request: (...args: unknown[]) => hoisted.runtimeHostRequestMock(...args),
  })),
}));

vi.mock('../../electron/main/process-runtime/openclaw-gateway/config-sync-env', () => ({
  stripSystemdSupervisorEnv: vi.fn((env: Record<string, string | undefined>) => env),
}));

const runtimeHostEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};

const runtimeHostScope = {
  kind: 'runtime-instance',
  endpoint: runtimeHostEndpoint,
};

function createFakeRuntimeHostManager() {
  let registeredHandler:
    | ((eventName: 'runtime-job:done' | 'runtime-job:progress', payload: unknown) => void)
    | null = null;
  return {
    request: hoisted.runtimeHostRequestMock,
    onRuntimeJobEvent: (
      handler: (eventName: 'runtime-job:done' | 'runtime-job:progress', payload: unknown) => void,
    ) => {
      registeredHandler = handler;
      return () => {
        registeredHandler = null;
      };
    },
    fireRuntimeJobEvent: (
      eventName: 'runtime-job:done' | 'runtime-job:progress',
      payload: unknown,
    ) => registeredHandler?.(eventName, payload),
  };
}

describe('gateway config sync', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    const openclawDir = path.join(process.cwd(), '.tmp', 'gateway-config-sync-openclaw');
    rmSync(openclawDir, { recursive: true, force: true });
    mkdirSync(openclawDir, { recursive: true });
    writeFileSync(path.join(openclawDir, 'openclaw.mjs'), '', 'utf8');
    hoisted.runtimeHostRequestMock.mockImplementation(async (_method: string, route: string, payload?: Record<string, unknown>) => {
      if (route === '/api/runtime-endpoints/list') {
        return {
          status: 200,
          data: {
            endpoints: [{
              ...runtimeHostEndpoint,
              capabilitySummaries: [{ id: 'runtime.host', availability: 'available' }],
            }],
          },
        };
      }
      if (route === '/api/capabilities/list') {
        return {
          status: 200,
          data: {
            capabilities: [{
              id: 'runtime.host',
              kind: 'runtime',
              scopeKind: 'runtime-instance',
              scope: runtimeHostScope,
              targetKinds: ['gateway-control'],
              supportLevel: 'native',
              availability: 'available',
              operations: [{ id: 'runtimeHost.prepareGatewayLaunch', title: 'Prepare gateway launch', targetKind: 'gateway-control' }],
              policyScope: 'runtime.host',
              ownerModuleId: 'runtime-host',
              routeOwnerId: 'runtime-host',
            }],
          },
        };
      }
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
      if (route === '/api/capabilities/execute' && payload?.operationId === 'runtimeHost.prepareGatewayLaunch') {
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
      if (route === '/api/capabilities/execute' && payload?.operationId === 'runtimeHost.jobGet') {
        return {
          status: 200,
          data: {
            success: true,
            job: {
              id: 'job-prelaunch-1',
              type: 'runtimeHost.gatewayPrelaunch',
              status: 'succeeded',
              result: {
                configuredChannels: [],
                launchPlan: {
                  gatewayToken: 'matchaclaw-token-1',
                  providerEnv: {},
                  loadedProviderKeyCount: 0,
                  skipChannels: true,
                  channelStartupSummary: 'skipped(no configured channels)',
                },
              },
            },
          },
        };
      }
      return { status: 200, data: { success: true } };
    });
  });

  it('gateway 启动前会通过 runtime-host 执行单一路径准备', async () => {
    const { prepareGatewayRuntimeBeforeLaunch } = await import('../../electron/main/process-runtime/openclaw-gateway/config-sync');
    const runtimeHost = createFakeRuntimeHostManager();
    await prepareGatewayRuntimeBeforeLaunch(runtimeHost as never, {
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    });

    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'GET',
      '/api/runtime-endpoints/list',
    );
    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'GET',
      '/api/capabilities/list',
    );
    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'POST',
      '/api/capabilities/execute',
      expect.objectContaining({
        id: 'runtime.host',
        operationId: 'runtimeHost.prepareGatewayLaunch',
        scope: runtimeHostScope,
        target: { kind: 'gateway-control' },
        input: {},
      }),
    );
    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'POST',
      '/api/capabilities/execute',
      expect.objectContaining({
        id: 'runtime.host',
        operationId: 'runtimeHost.jobGet',
        target: { kind: 'runtime-job', jobId: 'job-prelaunch-1' },
        input: { jobId: 'job-prelaunch-1' },
      }),
      { timeoutMs: 8000 },
    );
  });

  it('runtime-host 准备失败时不再执行本地 fallback', async () => {
    hoisted.runtimeHostRequestMock.mockRejectedValueOnce(new Error('runtime-host offline'));

    const { prepareGatewayRuntimeBeforeLaunch } = await import('../../electron/main/process-runtime/openclaw-gateway/config-sync');
    const runtimeHost = createFakeRuntimeHostManager();
    await expect(prepareGatewayRuntimeBeforeLaunch(runtimeHost as never, {
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    })).rejects.toThrow('runtime-host offline');

    expect(hoisted.runtimeHostRequestMock).toHaveBeenCalledWith(
      'GET',
      '/api/runtime-endpoints/list',
    );
    expect(hoisted.runtimeHostRequestMock).not.toHaveBeenCalledWith(
      'POST',
      '/api/capabilities/execute',
      expect.anything(),
    );
  });

  it('Gateway 启动准备不再由 Electron 删除 OpenClaw extensions', async () => {
    const staleDir = path.join(process.cwd(), '.tmp', 'gateway-config-sync-fake-openclaw', 'extensions', 'discord');
    mkdirSync(staleDir, { recursive: true });

    const { prepareGatewayRuntimeBeforeLaunch } = await import('../../electron/main/process-runtime/openclaw-gateway/config-sync');
    const runtimeHost = createFakeRuntimeHostManager();
    await prepareGatewayRuntimeBeforeLaunch(runtimeHost as never, {
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    });

    expect(existsSync(staleDir)).toBe(true);
    rmSync(staleDir, { recursive: true, force: true });
  });

  it('Gateway 启动上下文只消费预先计算的宿主设置和启动计划', async () => {
    const { createGatewayLaunchContext } = await import('../../electron/main/process-runtime/openclaw-gateway/config-sync');
    const precomputedLaunchPlan = {
      gatewayToken: 'matchaclaw-token-1',
      providerEnv: {},
      loadedProviderKeyCount: 0,
      skipChannels: true,
      channelStartupSummary: 'skipped(no configured channels)',
    };
    const hostBootstrapSettings = {
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
      gatewayAutoStart: true,
      launchAtStartup: false,
    };

    const context = await createGatewayLaunchContext(18789, precomputedLaunchPlan, hostBootstrapSettings);

    expect(context.gatewayArgs).toEqual([
      'gateway',
      '--port',
      '18789',
      '--token',
      'matchaclaw-token-1',
      '--allow-unconfigured',
    ]);
    expect(context.channelStartupSummary).toBe('skipped(no configured channels)');
    expect(context.loadedProviderKeyCount).toBe(0);
    expect(context.forkEnv.OPENCLAW_GATEWAY_PORT).toBe('18789');
    expect(context.forkEnv.OPENCLAW_GATEWAY_TOKEN).toBe('matchaclaw-token-1');
    expect(context.forkEnv.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT).toBe('18789');
    expect(context.forkEnv.MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN).toBe('matchaclaw-token-1');
    expect(context.forkEnv.OPENCLAW_SKIP_CHANNELS).toBe('1');
    expect(context.forkEnv.CLAWDBOT_SKIP_CHANNELS).toBe('1');
    expect(hoisted.runtimeHostRequestMock).not.toHaveBeenCalled();
  });
});
