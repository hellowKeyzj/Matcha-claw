import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

const childProcessMock = vi.hoisted(() => ({
  exec: vi.fn(),
  fork: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  default: childProcessMock,
  exec: childProcessMock.exec,
  fork: childProcessMock.fork,
  spawn: childProcessMock.spawn,
}));

const hoisted = vi.hoisted(() => {
  const processStateRef: {
    lifecycle: 'idle' | 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';
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
  const runtimeHostProcessStartMock = vi.fn(async () => {});
  const runtimeHostProcessStopMock = vi.fn(async () => {});
  const runtimeHostProcessForceTerminateMock = vi.fn(async () => {});
  const runtimeHostProcessStateChangeHandlerRef: { current: (() => void) | null } = {
    current: null,
  };
  const createRuntimeHostProcessManagerMock = vi.fn(() => ({
    start: runtimeHostProcessStartMock,
    stop: runtimeHostProcessStopMock,
    restart: vi.fn(async () => {}),
    forceTerminate: runtimeHostProcessForceTerminateMock,
    checkHealth: vi.fn(async () => ({ ok: true, lifecycle: 'running' })),
    getState: vi.fn(() => ({
      lifecycle: processStateRef.lifecycle,
      port: 3211,
      ...(processStateRef.lastError ? { lastError: processStateRef.lastError } : {}),
    })),
    onStateChange: vi.fn((handler: () => void) => {
      runtimeHostProcessStateChangeHandlerRef.current = handler;
      return () => {
        runtimeHostProcessStateChangeHandlerRef.current = null;
      };
    }),
  }));
  const matchaAgentAppServerManagerMock = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    forceTerminate: vi.fn(async () => {}),
    checkReadiness: vi.fn(async () => ({ status: 'ready' as const })),
    getState: vi.fn(() => ({ lifecycle: 'running' as const, port: 3212 })),
    getEndpointSnapshot: vi.fn(() => ({
      enabled: true as const,
      url: 'http://127.0.0.1:3212',
      token: 'matcha-agent-token',
      port: 3212,
      storageRoot: 'E:\\code\\Matcha-claw\\.tmp-test-user-data\\matcha-agent\\app-server',
    })),
    onStateChange: vi.fn(() => () => {}),
  };
  const shellOpenPathMock = vi.fn(async () => '');
  const getOpenClawDirMock = vi.fn(() => 'E:\\code\\Matcha-claw\\node_modules\\openclaw');
  const gatewayStatusMock = vi.fn(() => ({ processState: 'running', port: 18789 }));
  return {
    childRequestMock,
    childHealthMock,
    createRuntimeHostHttpClientMock,
    createRuntimeHostProcessManagerMock,
    runtimeHostProcessStartMock,
    runtimeHostProcessStopMock,
    runtimeHostProcessForceTerminateMock,
    runtimeHostProcessStateChangeHandlerRef,
    shellOpenPathMock,
    getOpenClawDirMock,
    gatewayStatusMock,
    matchaAgentAppServerManagerMock,
    processStateRef,
  };
});

function createGatewayManagerMock() {
  return {
    getStatus: hoisted.gatewayStatusMock,
    debouncedRestart: vi.fn(),
  } as never;
}

class RuntimeHostChildProcessMock extends EventEmitter {
  readonly pid = 7321;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

function serializeObservedValues(values: readonly unknown[]): string {
  return values
    .map((value) => value instanceof Error
      ? `${value.message}\n${value.stack ?? ''}`
      : typeof value === 'string'
        ? value
        : JSON.stringify(value))
    .join('\n');
}

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
    getPath: (name: string) => name === 'userData' ? 'E:\\code\\Matcha-claw\\.tmp-test-user-data' : '',
  },
  shell: {
    openPath: (...args: unknown[]) => hoisted.shellOpenPathMock(...args),
  },
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


vi.mock('../../electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('runtime-host process known-secret log policy', () => {
  const parentDispatchToken = 'parent-dispatch-secret-exact-value';
  const matchaAgentAppServerToken = 'matcha-agent-app-server-secret-exact-value';

  beforeEach(() => {
    childProcessMock.exec.mockReset();
    childProcessMock.fork.mockReset();
    childProcessMock.spawn.mockReset();
    childProcessMock.exec.mockImplementation((_command, _options, callback) => {
      const child = childProcessMock.fork.mock.results.at(-1)?.value as RuntimeHostChildProcessMock | undefined;
      if (child) {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      }
      callback(null, '', '');
      return {} as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['parent dispatch token', 'stdout', parentDispatchToken, 'info'],
    ['parent dispatch token', 'stderr', parentDispatchToken, 'warn'],
    ['matcha-agent app-server token', 'stdout', matchaAgentAppServerToken, 'info'],
    ['matcha-agent app-server token', 'stderr', matchaAgentAppServerToken, 'warn'],
  ] as const)('redacts %s from child %s without dropping surrounding context', async (
    _tokenName,
    stream,
    secret,
    loggerLevel,
  ) => {
    const child = new RuntimeHostChildProcessMock();
    childProcessMock.fork.mockReturnValueOnce(child);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, lifecycle: 'running' }),
    } as Response);
    const logger = {
      debug: vi.fn<(message: string) => void>(),
      info: vi.fn<(message: string) => void>(),
      warn: vi.fn<(message: string, error?: unknown) => void>(),
      error: vi.fn<(message: string, error?: unknown) => void>(),
    };
    const stateEvents: unknown[] = [];
    const { createRuntimeHostProcessManager } = await vi.importActual<
      typeof import('../../electron/main/process-runtime/runtime-host-process-manager')
    >('../../electron/main/process-runtime/runtime-host-process-manager');
    const manager = createRuntimeHostProcessManager({
      scriptPath: join(process.cwd(), 'runtime-host', 'host-process.cjs'),
      port: 43211,
      parentApiBaseUrl: 'http://127.0.0.1:3210',
      parentDispatchToken,
      childEnv: () => ({
        MATCHACLAW_MATCHA_AGENT_APP_SERVER_TOKEN: matchaAgentAppServerToken,
      }),
      logger,
    });
    manager.onStateChange((state) => stateEvents.push(state));

    try {
      await manager.start();
      logger.debug.mockClear();
      logger.info.mockClear();
      logger.warn.mockClear();
      logger.error.mockClear();
      stateEvents.length = 0;

      child[stream].write(`context-before ${secret} context-after\n`);

      const expectedPrefix = stream === 'stderr'
        ? '[runtime-host-child:stderr]'
        : '[runtime-host-child]';
      expect(logger[loggerLevel]).toHaveBeenCalledWith(
        `${expectedPrefix} context-before <redacted> context-after`,
      );
      const observedOutput = serializeObservedValues([
        ...logger.debug.mock.calls.flat(),
        ...logger.info.mock.calls.flat(),
        ...logger.warn.mock.calls.flat(),
        ...logger.error.mock.calls.flat(),
        ...stateEvents,
        manager.getState(),
      ]);
      expect(observedOutput).toContain('context-before');
      expect(observedOutput).toContain('context-after');
      expect(observedOutput).toContain('<redacted>');
      expect(observedOutput).not.toContain(secret);
    } finally {
      await manager.stop();
    }
  });
});

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
    hoisted.childRequestMock.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        execution: { enabledPluginIds: ['security-core'] },
      },
    });
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
    hoisted.gatewayStatusMock.mockReset();
    hoisted.gatewayStatusMock.mockReturnValue({ processState: 'running', port: 18789 });
    hoisted.runtimeHostProcessStartMock.mockReset();
    hoisted.runtimeHostProcessStartMock.mockResolvedValue(undefined);
    hoisted.runtimeHostProcessStopMock.mockReset();
    hoisted.runtimeHostProcessStopMock.mockResolvedValue(undefined);
    hoisted.runtimeHostProcessStateChangeHandlerRef.current = null;
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
      gatewayManager: createGatewayManagerMock(),
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
      gatewayManager: createGatewayManagerMock(),
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
      gatewayManager: createGatewayManagerMock(),
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
      gatewayManager: createGatewayManagerMock(),
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
      gatewayManager: createGatewayManagerMock(),
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

  it.each([
    ['starting', 'starting'],
    ['restarting', 'restarting'],
    ['stopping', 'stopping'],
    ['idle', 'stopped'],
  ] as const)('getState.runtimeLifecycle maps process %s to %s', async (
    processLifecycle,
    runtimeLifecycle,
  ) => {
    hoisted.processStateRef.lifecycle = processLifecycle;

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: createGatewayManagerMock(),
    });

    expect(manager.getState().runtimeLifecycle).toBe(runtimeLifecycle);
  });

  it('does not let an aborted start overwrite a completed stop', async () => {
    let rejectStart!: (reason: unknown) => void;
    hoisted.runtimeHostProcessStartMock.mockReturnValueOnce(new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    }));
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: createGatewayManagerMock(),
    });

    const startPromise = manager.start().catch((error: unknown) => error);
    await Promise.resolve();
    await manager.stop();
    rejectStart(new Error('Local process start operation aborted'));
    await startPromise;

    expect(manager.getState().lifecycle).toBe('stopped');
  });

  it('stop failure preserves the process error lifecycle and rejects the caller', async () => {
    const stopError = new Error('runtime-host process termination failed');
    hoisted.processStateRef.lifecycle = 'running';
    hoisted.runtimeHostProcessStopMock.mockImplementationOnce(async () => {
      hoisted.processStateRef.lifecycle = 'error';
      hoisted.processStateRef.lastError = stopError.message;
      hoisted.runtimeHostProcessStateChangeHandlerRef.current?.();
      throw stopError;
    });

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: createGatewayManagerMock(),
    });
    await manager.start();
    const states: ReturnType<typeof manager.getState>[] = [];
    manager.onStateChange((state) => states.push(state));

    await expect(manager.stop()).rejects.toBe(stopError);

    expect(manager.getState()).toMatchObject({
      lifecycle: 'error',
      runtimeLifecycle: 'error',
      lastError: stopError.message,
    });
    expect(states).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lifecycle: 'stopping',
        runtimeLifecycle: 'running',
      }),
      expect.objectContaining({
        lifecycle: 'error',
        runtimeLifecycle: 'error',
        lastError: stopError.message,
      }),
    ]));
    expect(states.at(-1)).toMatchObject({
      lifecycle: 'error',
      runtimeLifecycle: 'error',
      lastError: stopError.message,
    });
  });

  it('forceTerminate delegates to the runtime-host process owner', async () => {
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: createGatewayManagerMock(),
    });

    await manager.forceTerminate();

    expect(hoisted.runtimeHostProcessForceTerminateMock).toHaveBeenCalledTimes(1);
  });

  it('启动时 gateway 端口仅来自 gatewayManager，不再读取 settings.gatewayPort', async () => {
    const gatewayManager = {
      getStatus: vi.fn(() => ({ processState: 'running', port: 19876 })),
    } as never;

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({ gatewayManager });

    await manager.start();

    const processManagerOptions = hoisted.createRuntimeHostProcessManagerMock.mock.calls[0]?.[0] as
      | { childEnv?: () => Record<string, string> }
      | undefined;
    const childEnv = processManagerOptions?.childEnv?.() ?? {};
    expect(childEnv.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT).toBe('19876');
    expect(childEnv.MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN).toBeUndefined();
    expect(childEnv.MATCHACLAW_OPENCLAW_DIR).toBe('E:\\code\\Matcha-claw\\node_modules\\openclaw');
  });

  it('启动时把已启动的 matcha-agent app-server endpoint 注入 runtime-host env', async () => {
    const gatewayManager = {
      getStatus: vi.fn(() => ({ processState: 'running', port: 19876 })),
    } as never;

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager,
      matchaAgentAppServerManager: hoisted.matchaAgentAppServerManagerMock,
    });

    await manager.start();

    const processManagerOptions = hoisted.createRuntimeHostProcessManagerMock.mock.calls[0]?.[0] as
      | { childEnv?: () => Record<string, string> }
      | undefined;
    const childEnv = processManagerOptions?.childEnv?.() ?? {};
    expect(childEnv.MATCHACLAW_MATCHA_AGENT_APP_SERVER_ENABLED).toBe('1');
    expect(childEnv.MATCHACLAW_MATCHA_AGENT_APP_SERVER_URL).toBe('http://127.0.0.1:3212');
    expect(childEnv.MATCHACLAW_MATCHA_AGENT_APP_SERVER_TOKEN).toBe('matcha-agent-token');
  });

  it('gatewayManager 返回非法端口时 start 直接失败，不再回退默认端口', async () => {
    const gatewayManager = {
      getStatus: vi.fn(() => ({ processState: 'running', port: 0 })),
    } as never;

    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({ gatewayManager });

    await expect(manager.start()).rejects.toThrow('Invalid gateway port from gateway manager: 0');
  });

  it('executeShellAction(shell_open_path) 通过主进程 shell.openPath 打开目录', async () => {
    hoisted.shellOpenPathMock.mockResolvedValueOnce('');
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: createGatewayManagerMock(),
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
      gatewayManager: createGatewayManagerMock(),
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
        getStatus: () => ({ processState: 'running', port: 19876 }),
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

  it('executeShellAction(host_diagnostics_snapshot) 只返回宿主诊断上下文', async () => {
    hoisted.gatewayStatusMock.mockReturnValueOnce({ processState: 'running', port: 19876, pid: 1234 });
    const { createRuntimeHostManager } = await import('../../electron/main/runtime-host-manager');
    const manager = createRuntimeHostManager({
      gatewayManager: {
        getStatus: hoisted.gatewayStatusMock,
        debouncedRestart: vi.fn(),
      } as never,
    });

    const result = await manager.executeShellAction('host_diagnostics_snapshot');

    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        snapshot: {
          userDataDir: 'E:\\code\\Matcha-claw\\.tmp-test-user-data',
          appInfo: {
            name: 'MatchaClaw',
            version: '0.0.0-test',
            isPackaged: false,
            platform: process.platform,
            arch: process.arch,
            electron: process.versions.electron,
            node: process.versions.node,
          },
          gatewayStatus: { processState: 'running', port: 19876, pid: 1234 },
        },
      },
    });
  });
});
