import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalProcessAdapter,
  LocalProcessLifecycle,
  LocalProcessReadiness,
  LocalProcessRuntimeOptions,
  LocalProcessState,
} from '../../electron/main/process-runtime/contracts';

const localRuntimeMock = vi.hoisted(() => {
  const runtimeState: {
    lifecycle: LocalProcessLifecycle;
    pid?: number;
    lastError?: string;
  } = {
    lifecycle: 'idle',
  };
  const stateChangeHandlerRef: {
    current?: (state: LocalProcessState) => void;
  } = {};
  const readiness: LocalProcessReadiness = { status: 'ready', detail: 'running' };
  const unsubscribe = vi.fn();
  const runner = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    forceTerminate: vi.fn(async () => {}),
    checkReadiness: vi.fn(async () => readiness),
    getState: vi.fn((): LocalProcessState => ({
      id: 'runtime-host',
      displayName: 'runtime-host-child',
      lifecycle: runtimeState.lifecycle,
      ...(runtimeState.pid ? { pid: runtimeState.pid } : {}),
      ...(runtimeState.lastError ? { lastError: runtimeState.lastError } : {}),
    })),
    onStateChange: vi.fn((handler: (state: LocalProcessState) => void) => {
      stateChangeHandlerRef.current = handler;
      return unsubscribe;
    }),
  };

  return {
    runtimeState,
    stateChangeHandlerRef,
    unsubscribe,
    runner,
    createLocalProcessRuntime: vi.fn(() => runner),
  };
});

vi.mock('../../electron/main/process-runtime/local-process-runtime', () => ({
  createLocalProcessRuntime: localRuntimeMock.createLocalProcessRuntime,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => process.cwd()),
    isPackaged: false,
  },
}));

import { createMatchaAgentAppServerProcessManager } from '../../electron/main/process-runtime/matcha-agent-app-server-process-manager';
import { createRuntimeHostProcessManager } from '../../electron/main/process-runtime/runtime-host-process-manager';

const envBackup = { ...process.env };

function createManager(options: {
  port?: number;
  scriptPath?: string;
  childEnv?: () => Record<string, string>;
} = {}) {
  return createRuntimeHostProcessManager({
    ...options,
    parentApiBaseUrl: 'http://127.0.0.1:13210',
    parentDispatchToken: 'test-runtime-host-dispatch-token',
  });
}

function getCreatedAdapter(): LocalProcessAdapter {
  const runtimeOptions = localRuntimeMock.createLocalProcessRuntime.mock.calls[0]?.[0] as
    | LocalProcessRuntimeOptions
    | undefined;
  if (!runtimeOptions) {
    throw new Error('expected runtime-host manager to create local process runtime');
  }
  return runtimeOptions.adapter;
}

describe('runtime-host process manager compatibility', () => {
  beforeEach(() => {
    process.env = { ...envBackup };
    delete process.env.MATCHACLAW_RUNTIME_HOST_PORT;
    localRuntimeMock.runtimeState.lifecycle = 'idle';
    delete localRuntimeMock.runtimeState.pid;
    delete localRuntimeMock.runtimeState.lastError;
    localRuntimeMock.stateChangeHandlerRef.current = undefined;
    localRuntimeMock.unsubscribe.mockClear();
    localRuntimeMock.createLocalProcessRuntime.mockClear();
    Object.values(localRuntimeMock.runner).forEach((value) => {
      if (typeof value === 'function' && 'mockClear' in value) {
        value.mockClear();
      }
    });
  });

  it('preserves local runtime lifecycles in the process-manager state', () => {
    const manager = createManager({ port: 45670 });
    const lifecycles: LocalProcessLifecycle[] = [
      'idle',
      'starting',
      'restarting',
      'stopping',
      'running',
      'error',
      'stopped',
    ];

    for (const lifecycle of lifecycles) {
      localRuntimeMock.runtimeState.lifecycle = lifecycle;
      expect(manager.getState().lifecycle).toBe(lifecycle);
    }
  });

  it('exposes the configured port and lets explicit port override env-derived port', () => {
    process.env.MATCHACLAW_RUNTIME_HOST_PORT = '45671';

    expect(createManager().getState().port).toBe(45671);
    expect(createManager({ port: 45672 }).getState().port).toBe(45672);
  });

  it('passes the runtime-host process policy defaults to the local process runtime', () => {
    createManager();

    const runtimeOptions = localRuntimeMock.createLocalProcessRuntime.mock.calls[0]?.[0];
    expect(runtimeOptions?.startTimeoutMs).toBe(15_000);
    expect(runtimeOptions?.stopTimeoutMs).toBe(1_200);
    expect(runtimeOptions?.autoRestartBaseDelayMs).toBe(300);
    expect(runtimeOptions?.autoRestartMaxDelayMs).toBe(5_000);
    expect(runtimeOptions?.autoRestartWindowMs).toBe(60_000);
    expect(runtimeOptions?.autoRestartMaxAttempts).toBe(6);
  });

  it('exposes force termination and delegates it to the local process runtime', async () => {
    const manager = createManager();

    expect(manager.forceTerminate).toEqual(expect.any(Function));
    await manager.forceTerminate();

    expect(localRuntimeMock.runner.forceTerminate).toHaveBeenCalledTimes(1);
    expect(localRuntimeMock.runner.stop).not.toHaveBeenCalled();
  });

  it('delegates matcha-agent app-server force termination to the local process runtime', async () => {
    const manager = createMatchaAgentAppServerProcessManager();

    await manager.forceTerminate();

    expect(localRuntimeMock.runner.forceTerminate).toHaveBeenCalledTimes(1);
    expect(localRuntimeMock.runner.stop).not.toHaveBeenCalled();
  });

  it('only exposes the matcha-agent app-server endpoint while the process is running', async () => {
    const manager = createMatchaAgentAppServerProcessManager();
    await getCreatedAdapter().prepareLaunch({ nowMs: () => 0, attempt: 1 });

    localRuntimeMock.runtimeState.lifecycle = 'error';
    expect(manager.getEndpointSnapshot()).toBeUndefined();

    localRuntimeMock.runtimeState.lifecycle = 'running';
    expect(manager.getEndpointSnapshot()).toEqual(expect.objectContaining({
      enabled: true,
      token: expect.any(String),
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
    }));
  });

  it('creates a runtime-host launch plan that terminates the process tree', async () => {
    createManager({ port: 45674, scriptPath: process.execPath });

    const plan = await getCreatedAdapter().prepareLaunch({ nowMs: () => 0, attempt: 1 });

    expect(plan.kind).toBe('node-child');
    expect(plan.gracefulShutdownMessage).toEqual({ type: 'matchaclaw:shutdown' });
    expect(plan.terminateProcessTree).toBe(true);
    expect(plan.env?.MATCHACLAW_RUNTIME_HOST_PARENT_DISPATCH_TOKEN).toBeTruthy();
  });

  it('redacts known launch secrets from stdout and stderr logs', async () => {
    const parentToken = 'test-runtime-host-dispatch-token';
    const appServerToken = 'test-matcha-agent-app-server-token';
    const childEnv = vi.fn(() => ({
      MATCHACLAW_MATCHA_AGENT_APP_SERVER_TOKEN: appServerToken,
    }));
    createManager({
      scriptPath: process.execPath,
      childEnv,
    });
    const adapter = getCreatedAdapter();
    await adapter.prepareLaunch({ nowMs: () => 0, attempt: 1 });
    expect(childEnv).toHaveBeenCalledTimes(1);

    const stdout = adapter.classifyLog?.(
      `parent=${parentToken} appServer=${appServerToken}`,
      'stdout',
    );
    const stderr = adapter.classifyLog?.(
      `appServer=${appServerToken} parent=${parentToken}`,
      'stderr',
    );

    expect(stdout).toEqual({
      level: 'info',
      message: 'parent=<redacted> appServer=<redacted>',
    });
    expect(stderr).toEqual({
      level: 'warn',
      message: 'appServer=<redacted> parent=<redacted>',
    });
    expect(JSON.stringify([stdout, stderr])).not.toContain(parentToken);
    expect(JSON.stringify([stdout, stderr])).not.toContain(appServerToken);
  });

  it('maps state listener updates through the full lifecycle projection', () => {
    const manager = createManager({ port: 45673 });
    const listener = vi.fn();

    const unsubscribe = manager.onStateChange(listener);
    localRuntimeMock.runtimeState.lifecycle = 'restarting';
    localRuntimeMock.runtimeState.pid = 1234;
    localRuntimeMock.runtimeState.lastError = 'restart pending';
    localRuntimeMock.stateChangeHandlerRef.current?.({
      id: 'runtime-host',
      displayName: 'runtime-host-child',
      lifecycle: 'restarting',
      pid: 1234,
      lastError: 'restart pending',
    });

    expect(listener).toHaveBeenCalledWith({
      lifecycle: 'restarting',
      port: 45673,
      pid: 1234,
      lastError: 'restart pending',
    });

    unsubscribe();
    expect(localRuntimeMock.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
