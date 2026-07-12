import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createServer: vi.fn(),
  exec: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
  utilityProcess: {
    fork: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  exec: hoisted.exec,
}));

vi.mock('net', () => ({
  createServer: hoisted.createServer,
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: hoisted.logger,
}));

vi.mock('../../electron/utils/uv-setup', () => ({
  isPythonReady: vi.fn(async () => true),
  setupManagedPython: vi.fn(async () => undefined),
}));

vi.mock('../../electron/utils/uv-env', () => ({
  getUvMirrorEnv: vi.fn(async () => ({})),
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalProcessKill = process.kill;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    ...originalPlatformDescriptor,
    value: platform,
    configurable: true,
  });
}

function restorePlatform(): void {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
}

function mockExecStdout(stdout: string): void {
  hoisted.exec.mockImplementation((_command: string, _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    callback(null, stdout);
  });
}

function noSuchProcessError(): NodeJS.ErrnoException {
  const error = new Error('No such process') as NodeJS.ErrnoException;
  error.code = 'ESRCH';
  return error;
}

function mockProcessExitAfterSignal(exitSignal: NodeJS.Signals): void {
  let exited = false;
  process.kill = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === exitSignal) {
      exited = true;
      return true;
    }
    if (signal === 0 && exited) {
      throw noSuchProcessError();
    }
    return true;
  }) as typeof process.kill;
}

function mockPortAvailable(): void {
  hoisted.createServer.mockImplementation(() => {
    const handlers = new Map<string, () => void>();
    const server = {
      once: vi.fn((event: string, handler: () => void) => {
        handlers.set(event, handler);
        return server;
      }),
      listen: vi.fn(() => {
        handlers.get('listening')?.();
        return server;
      }),
      close: vi.fn((callback: () => void) => callback()),
    };
    return server;
  });
}

describe('openclaw gateway supervisor listener ownership', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPlatform('linux');
    process.kill = vi.fn(() => true) as typeof process.kill;
    mockPortAvailable();
  });

  afterEach(() => {
    process.kill = originalProcessKill;
    restorePlatform();
    vi.useRealTimers();
  });

  it('returns an owned listener without terminating it', async () => {
    mockExecStdout('1234\n');
    const { findExistingGatewayProcess } = await import(
      '../../electron/main/process-runtime/openclaw-gateway/supervisor'
    );

    await expect(findExistingGatewayProcess({ port: 18789, ownedPid: 1234 })).resolves.toEqual({
      port: 18789,
    });

    expect(process.kill).not.toHaveBeenCalled();
  });

  it('terminates a mismatched listener as an orphan while checking for an attachable gateway', async () => {
    vi.useFakeTimers();
    mockExecStdout('5678\n');
    mockProcessExitAfterSignal('SIGKILL');
    const { findExistingGatewayProcess } = await import(
      '../../electron/main/process-runtime/openclaw-gateway/supervisor'
    );

    const resultPromise = findExistingGatewayProcess({ port: 18789, ownedPid: 1234 });
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toBeNull();
    expect(process.kill).toHaveBeenCalledWith(5678, 'SIGTERM');
    expect(process.kill).toHaveBeenCalledWith(5678, 0);
    expect(process.kill).toHaveBeenCalledWith(5678, 'SIGKILL');
  });

  it('terminates orphaned listeners only when no owned listener is present', async () => {
    vi.useFakeTimers();
    mockExecStdout('5678\n');
    mockProcessExitAfterSignal('SIGKILL');
    const { findExistingGatewayProcess } = await import(
      '../../electron/main/process-runtime/openclaw-gateway/supervisor'
    );

    const resultPromise = findExistingGatewayProcess({ port: 18789 });
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toBeNull();
    expect(process.kill).toHaveBeenCalledWith(5678, 'SIGTERM');
    expect(process.kill).toHaveBeenCalledWith(5678, 0);
    expect(process.kill).toHaveBeenCalledWith(5678, 'SIGKILL');
  });

  it('does not terminate listeners after a cancelled startup probe', async () => {
    const controller = new AbortController();
    hoisted.exec.mockImplementation((_command: string, _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      controller.abort(new Error('startup superseded'));
      callback(null, '5678\n');
    });
    const { findExistingGatewayProcess } = await import(
      '../../electron/main/process-runtime/openclaw-gateway/supervisor'
    );

    await expect(findExistingGatewayProcess({
      port: 18789,
      signal: controller.signal,
      assertActive: () => {
        if (controller.signal.aborted) {
          throw controller.signal.reason;
        }
      },
    })).rejects.toThrow('startup superseded');

    expect(process.kill).not.toHaveBeenCalled();
  });

  it('rejects when Windows taskkill fails and the process is still running', async () => {
    setPlatform('win32');
    const taskkillError = new Error('access denied');
    hoisted.exec.mockImplementation((_command: string, _options: unknown, callback: (error: Error | null) => void) => {
      callback(taskkillError);
    });
    const { terminateGatewayProcessIds } = await import(
      '../../electron/main/process-runtime/openclaw-gateway/supervisor'
    );

    await expect(terminateGatewayProcessIds({
      port: 18789,
      pids: ['5678'],
      reason: 'owned attached gateway',
    })).rejects.toThrow(
      'Failed to terminate owned attached gateway process 5678 on port 18789: taskkill failed while the process was still running',
    );
  });

  it('treats a Windows taskkill error as success when the process already exited', async () => {
    setPlatform('win32');
    hoisted.exec.mockImplementation((_command: string, _options: unknown, callback: (error: Error | null) => void) => {
      callback(new Error('process not found'));
    });
    process.kill = vi.fn(() => {
      throw noSuchProcessError();
    }) as typeof process.kill;
    const { terminateGatewayProcessIds } = await import(
      '../../electron/main/process-runtime/openclaw-gateway/supervisor'
    );

    await expect(terminateGatewayProcessIds({
      port: 18789,
      pids: ['5678'],
      reason: 'owned attached gateway',
    })).resolves.toBeUndefined();
  });

  it('rejects when a POSIX process remains alive after SIGTERM and SIGKILL', async () => {
    vi.useFakeTimers();
    const { terminateGatewayProcessIds } = await import(
      '../../electron/main/process-runtime/openclaw-gateway/supervisor'
    );

    const terminationPromise = terminateGatewayProcessIds({
      port: 18789,
      pids: ['5678'],
      reason: 'owned attached gateway',
    });
    const rejection = expect(terminationPromise).rejects.toThrow(
      'Failed to terminate owned attached gateway process 5678 on port 18789: process was still running 1000ms after SIGKILL',
    );
    await vi.runAllTimersAsync();

    await rejection;
    expect(process.kill).toHaveBeenCalledWith(5678, 'SIGTERM');
    expect(process.kill).toHaveBeenCalledWith(5678, 'SIGKILL');
  });

  it('propagates orphan physical termination failure', async () => {
    vi.useFakeTimers();
    mockExecStdout('5678\n');
    const { findExistingGatewayProcess } = await import(
      '../../electron/main/process-runtime/openclaw-gateway/supervisor'
    );

    const cleanupPromise = findExistingGatewayProcess({ port: 18789 });
    const rejection = expect(cleanupPromise).rejects.toThrow(
      'Failed to terminate orphaned gateway process 5678 on port 18789',
    );
    await vi.runAllTimersAsync();

    await rejection;
  });
});
