import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DirectRuntimeHostDeliveryError,
  launchDirectRuntimeHost,
  type DirectRuntimeHostChild,
  type DirectRuntimeHostLaunch,
  type DirectRuntimeHostSpawner,
} from '../../electron/main/runtime-host-delivery/direct-host';

class FakeControlOutput {
  private readonly emitter = new EventEmitter();

  readonly on = vi.fn((event: string, listener: (...arguments_: readonly unknown[]) => void) => {
    this.emitter.on(event, listener);
    return this;
  });
  readonly removeListener = vi.fn((event: string, listener: (...arguments_: readonly unknown[]) => void) => {
    this.emitter.removeListener(event, listener);
    return this;
  });

  emitData(chunk: unknown): void {
    this.emitter.emit('data', chunk);
  }

  emitEnd(): void {
    this.emitter.emit('end');
  }

  emitClose(): void {
    this.emitter.emit('close');
  }
}

function createLaunch(overrides: Partial<DirectRuntimeHostLaunch> = {}): DirectRuntimeHostLaunch {
  return {
    executablePath: 'E:/matcha/runtime-host/runtime-host.exe',
    workingDirectory: 'E:/matcha/runtime-host',
    bootstrapBytes: new Uint8Array([0x7b, 0x7d]),
    environment: {
      MATCHA_RUNTIME_HOST_PORT: '51234',
      MATCHA_RUNTIME_HOST_MODE: 'delivery',
    },
    ...overrides,
  };
}

function createChild(pid = 42_424): DirectRuntimeHostChild & {
  readonly stdout: FakeControlOutput;
  readonly stderr: FakeControlOutput;
  readonly write: ReturnType<typeof vi.fn<DirectRuntimeHostChild['stdin']['write']>>;
  readonly end: ReturnType<typeof vi.fn<() => void>>;
  readonly kill: ReturnType<typeof vi.fn<(signal: NodeJS.Signals) => boolean>>;
  readonly emitExit: (code?: number | null, signal?: NodeJS.Signals | null) => void;
  readonly emitError: (error?: Error) => void;
} {
  const events = new EventEmitter();
  const stdout = new FakeControlOutput();
  const stderr = new FakeControlOutput();
  const write = vi.fn<DirectRuntimeHostChild['stdin']['write']>((_chunk, callback) => {
    callback(null);
    return true;
  });
  const end = vi.fn<() => void>();
  const emitExit = (code: number | null = 0, signal: NodeJS.Signals | null = null): void => {
    events.emit('exit', code, signal);
  };
  const emitError = (error = new Error('child failed')): void => {
    events.emit('error', error);
  };
  const kill = vi.fn<(signal: NodeJS.Signals) => boolean>((signal) => {
    queueMicrotask(() => emitExit(null, signal));
    return true;
  });
  return {
    pid,
    stdin: { write, end },
    stdout,
    stderr,
    kill,
    once: events.once.bind(events) as DirectRuntimeHostChild['once'],
    write,
    end,
    emitExit,
    emitError,
  };
}

function controlFrame(value: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function readyFrame(): Uint8Array {
  return controlFrame({ version: 1, type: 'ready' });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

async function readyHost(child = createChild()) {
  const hostPromise = launchDirectRuntimeHost(createLaunch(), { spawn: () => child });
  await Promise.resolve();
  child.stdout.emitData(readyFrame());
  return { child, host: await hostPromise };
}

describe('launchDirectRuntimeHost', () => {
  it('spawns with inherited delivery environment, frames bootstrap first, and becomes ready only from child stdout', async () => {
    vi.stubEnv('PATH', 'E:/parent/bin');
    vi.stubEnv('APPDATA', 'E:/parent/appdata');
    const launch = createLaunch({
      environment: {
        PATH: 'E:/runtime/bin',
        MATCHA_RUNTIME_HOST_PORT: '51234',
        MATCHA_RUNTIME_HOST_MODE: 'delivery',
      },
    });
    const child = createChild();
    const spawn = vi.fn<DirectRuntimeHostSpawner>(() => child);
    const hostPromise = launchDirectRuntimeHost(launch, { spawn });
    let hasResolved = false;
    void hostPromise.then(() => {
      hasResolved = true;
    });

    await Promise.resolve();

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(launch.executablePath, [], {
      cwd: launch.workingDirectory,
      env: expect.objectContaining({
        PATH: 'E:/runtime/bin',
        APPDATA: 'E:/parent/appdata',
        MATCHA_RUNTIME_HOST_PORT: '51234',
        MATCHA_RUNTIME_HOST_MODE: 'delivery',
      }),
      shell: false,
      stdio: 'pipe',
    });
    expect(child.write).toHaveBeenCalledOnce();
    expect(child.write).toHaveBeenCalledWith(new Uint8Array([0, 0, 0, 2, 0x7b, 0x7d]), expect.any(Function));
    expect(child.stdout.on).toHaveBeenCalledTimes(4);
    expect(child.stdout.on).toHaveBeenCalledWith('data', expect.any(Function));
    expect(child.stdout.on).toHaveBeenCalledWith('end', expect.any(Function));
    expect(child.stdout.on).toHaveBeenCalledWith('close', expect.any(Function));
    expect(child.stdout.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(hasResolved).toBe(false);

    child.stdout.emitData(readyFrame());

    await expect(hostPromise).resolves.toMatchObject({ pid: child.pid });
  });

  it('writes the exact bootstrap bytes after its big-endian length prefix before stdout readiness', async () => {
    const child = createChild();
    const launch = createLaunch({ bootstrapBytes: new Uint8Array([0xff, 0x00, 0x7f]) });
    const hostPromise = launchDirectRuntimeHost(launch, { spawn: () => child });

    await Promise.resolve();

    expect(child.write).toHaveBeenCalledWith(
      new Uint8Array([0, 0, 0, 3, 0xff, 0x00, 0x7f]),
      expect.any(Function),
    );
    child.stdout.emitData(readyFrame());
    await hostPromise;
  });

  it.each([
    ['stdout ends', (child: ReturnType<typeof createChild>) => child.stdout.emitEnd()],
    ['stdout closes', (child: ReturnType<typeof createChild>) => child.stdout.emitClose()],
    ['stdout carries an invalid control frame', (child: ReturnType<typeof createChild>) => child.stdout.emitData(new Uint8Array([0, 0, 0, 0]))],
  ])('reaps the child and classifies a control failure before ready when %s', async (_scenario, terminate) => {
    const child = createChild();
    const hostPromise = launchDirectRuntimeHost(createLaunch(), { spawn: () => child });

    terminate(child);

    await expect(hostPromise).rejects.toMatchObject({
      name: 'DirectRuntimeHostDeliveryError',
      code: 'CHILD_FAILED',
      diagnostic: { kind: 'child-failed', stderr: '' },
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('retains redacted stderr when control readiness disconnects before child exit', async () => {
    const child = createChild();
    const hostPromise = launchDirectRuntimeHost(createLaunch(), { spawn: () => child });

    child.stderr.emitData('runtime-host: authorization=private-value failed');
    child.stdout.emitEnd();

    await expect(hostPromise).rejects.toMatchObject({
      name: 'DirectRuntimeHostDeliveryError',
      code: 'CHILD_FAILED',
      diagnostic: {
        kind: 'child-failed',
        stderr: 'runtime-host: authorization=[REDACTED] failed',
      },
    });
  });

  it('rejects with a bounded error when spawning the child fails', async () => {
    await expect(launchDirectRuntimeHost(createLaunch(), {
      spawn: () => {
        throw new Error('runtime executable unavailable');
      },
    })).rejects.toMatchObject({
      name: 'DirectRuntimeHostDeliveryError',
      code: 'SPAWN_FAILED',
    } satisfies Partial<DirectRuntimeHostDeliveryError>);
  });

  it('retains bounded redacted stderr only on the private child-exit error', async () => {
    const child = createChild();
    const hostPromise = launchDirectRuntimeHost(createLaunch(), { spawn: () => child });

    child.stderr.emitData('runtime-host: token=super-secret failed\n');
    child.stderr.emitData('x'.repeat(8_192));
    child.emitExit(1);

    await expect(hostPromise).rejects.toMatchObject({
      name: 'DirectRuntimeHostDeliveryError',
      code: 'CHILD_EXITED',
      diagnostic: {
        kind: 'child-exited',
        stderr: expect.stringContaining('token=[REDACTED]'),
      },
    });
  });

  it.each([
    ['exits', (child: ReturnType<typeof createChild>) => child.emitExit(1), 'CHILD_EXITED'],
    ['fails', (child: ReturnType<typeof createChild>) => child.emitError(), 'CHILD_FAILED'],
  ])('rejects readiness with the direct child terminal fact when it %s first', async (_scenario, finish, code) => {
    const child = createChild();
    const hostPromise = launchDirectRuntimeHost(createLaunch(), { spawn: () => child });

    finish(child);

    await expect(hostPromise).rejects.toMatchObject({
      name: 'DirectRuntimeHostDeliveryError',
      code,
    } satisfies Partial<DirectRuntimeHostDeliveryError>);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reaps a child when bootstrap frame writing fails before control readiness', async () => {
    const child = createChild();
    child.write.mockImplementationOnce((_chunk, callback) => {
      callback(new Error('stdin unavailable'));
      return false;
    });

    await expect(launchDirectRuntimeHost(createLaunch(), { spawn: () => child })).rejects.toMatchObject({
      name: 'DirectRuntimeHostDeliveryError',
      code: 'CHILD_FAILED',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('uses a cold-start ready timeout that covers native runtime and peer startup', async () => {
    vi.useFakeTimers();
    const child = createChild();
    const hostPromise = launchDirectRuntimeHost(createLaunch(), { spawn: () => child });

    await vi.advanceTimersByTimeAsync(119_999);
    child.stdout.emitData(readyFrame());

    await expect(hostPromise).resolves.toMatchObject({ pid: child.pid });
    expect(child.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('times out while waiting for readiness and reaps the child', async () => {
    vi.useFakeTimers();
    const child = createChild();
    const hostPromise = launchDirectRuntimeHost(createLaunch(), {
      spawn: () => child,
      readyTimeoutMs: 1,
    });
    child.stderr.emitData('[DEBUG-bootstrap] stage=host_start\n');

    const rejection = expect(hostPromise).rejects.toMatchObject({
      name: 'DirectRuntimeHostDeliveryError',
      code: 'READY_TIMEOUT',
      diagnostic: {
        kind: 'child-failed',
        stderr: '[DEBUG-bootstrap] stage=host_start\n',
      },
    });
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });

  it('rejects ready timeouts beyond the Node timer limit before spawning', async () => {
    const spawn = vi.fn<DirectRuntimeHostSpawner>(() => createChild());

    await expect(launchDirectRuntimeHost(createLaunch(), {
      spawn,
      readyTimeoutMs: 2_147_483_648,
    })).rejects.toThrow('readyTimeoutMs must be a positive safe integer no greater than 2147483647');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('exposes only semantic commands and safe event subscriptions', async () => {
    const { child, host } = await readyHost();
    expect(typeof host.command).toBe('function');
    expect('request' in host).toBe(false);
    expect('sessions' in host).toBe(false);
    const handler = vi.fn();
    const unsubscribe = host.onSafeEvent(handler);

    child.stdout.emitData(controlFrame({
      version: 1,
      type: 'event',
      event: {
        type: 'openclaw.lifecycle',
        sequence: 3,
        hasRun: true,
        hasMessage: false,
        hasSessionActivity: true,
      },
    }));

    expect(handler).toHaveBeenCalledWith({
      type: 'openclaw.lifecycle',
      sequence: 3,
      hasRun: true,
      hasMessage: false,
      hasSessionActivity: true,
    });
    unsubscribe();
  });

  it('sends lifecycle controls through command frames without changing direct host EOF stop', async () => {
    const { child, host } = await readyHost();
    const command = host.command({ name: 'openclaw.lifecycle.stop' });
    const frame = child.write.mock.calls[1][0] as Uint8Array;
    const request = JSON.parse(Buffer.from(frame.subarray(4)).toString('utf8')) as {
      readonly id: string;
      readonly command: unknown;
    };

    expect(request.command).toEqual({ name: 'openclaw.lifecycle.stop' });
    expect(child.end).not.toHaveBeenCalled();
    child.stdout.emitData(controlFrame({
      version: 1,
      type: 'outcome',
      id: request.id,
      outcome: { kind: 'succeeded', result: {} },
    }));
    await expect(command).resolves.toEqual({ kind: 'succeeded', result: {} });

    const stopping = host.stop();
    expect(child.end).toHaveBeenCalledOnce();
    child.emitExit();
    await expect(stopping).resolves.toBeUndefined();
  });

  it('waits for a clean graceful child exit after closing stdin', async () => {
    const { child, host } = await readyHost();
    const stopping = host.stop();
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(child.end).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    child.emitExit();
    await expect(stopping).resolves.toBeUndefined();
  });

  it('rejects graceful shutdown when the direct child exits unsuccessfully', async () => {
    const { child, host } = await readyHost();
    const stopping = host.stop();
    child.emitExit(1);

    await expect(stopping).rejects.toMatchObject({
      name: 'DirectRuntimeHostDeliveryError',
      code: 'STOP_FAILED',
    });
  });

  it('force kills only the direct child handle and waits for its exit', async () => {
    const { child, host } = await readyHost();

    await expect(host.forceKill()).resolves.toBeUndefined();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.end).not.toHaveBeenCalled();
  });

  it('waits for a pending exit when force kill races with process completion', async () => {
    const { child, host } = await readyHost();
    child.kill.mockImplementationOnce(() => false);
    const termination = host.forceKill();
    let settled = false;
    void termination.then(() => {
      settled = true;
    });

    await Promise.resolve();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);
    child.emitExit(null, 'SIGKILL');
    await expect(termination).resolves.toBeUndefined();
  });

  it('projects unexpected child exit without exposing the child handle', async () => {
    const { child, host } = await readyHost();
    const handler = vi.fn();
    const unsubscribe = host.onExit(handler);

    child.emitExit(1);

    expect(handler).toHaveBeenCalledWith({ kind: 'exited', code: 1, signal: null });
    unsubscribe();
  });

  it('reports a child failure once and retains the terminal fact for late desktop observers', async () => {
    const { child, host } = await readyHost();
    const handler = vi.fn();
    host.onExit(handler);

    child.emitError();
    child.emitExit(1);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ kind: 'failed' });

    const lateHandler = vi.fn();
    host.onExit(lateHandler);

    expect(lateHandler).toHaveBeenCalledOnce();
    expect(lateHandler).toHaveBeenCalledWith({ kind: 'failed' });
  });
});
