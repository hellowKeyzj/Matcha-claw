import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimeHostControlCommand,
  RuntimeHostControlCommandOptions,
  RuntimeHostControlOutcome,
  RuntimeHostSafeEvent,
} from '../../electron/main/runtime-host-delivery/control';
import type {
  DirectRuntimeHost,
  DirectRuntimeHostExit,
} from '../../electron/main/runtime-host-delivery/direct-host';
import {
  RuntimeHostLifecycleOwner,
  RuntimeHostLifecycleUnavailableError,
} from '../../electron/main/runtime-host-delivery/lifecycle-owner';

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
};

type TestRuntimeHost = DirectRuntimeHost & {
  readonly command: ReturnType<typeof vi.fn<DirectRuntimeHost['command']>>;
  readonly stop: ReturnType<typeof vi.fn<DirectRuntimeHost['stop']>>;
  readonly forceKill: ReturnType<typeof vi.fn<DirectRuntimeHost['forceKill']>>;
  emitSafeEvent: (event: RuntimeHostSafeEvent) => void;
  emitExit: (exit: DirectRuntimeHostExit) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRuntimeHost(name: string): TestRuntimeHost {
  const safeEventHandlers = new Set<(event: RuntimeHostSafeEvent) => void>();
  const exitHandlers = new Set<(exit: DirectRuntimeHostExit) => void>();
  return {
    pid: name === 'first' ? 1 : 2,
    command: vi.fn(async (_command: RuntimeHostControlCommand, _options?: RuntimeHostControlCommandOptions) => ({
      kind: 'succeeded',
      result: { host: name },
    })),
    onSafeEvent: (handler) => {
      safeEventHandlers.add(handler);
      return () => safeEventHandlers.delete(handler);
    },
    onExit: (handler) => {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    readE2ECronProviderTrace: () => [name],
    stop: vi.fn(async () => undefined),
    forceKill: vi.fn(async () => undefined),
    emitSafeEvent: (event) => {
      for (const handler of [...safeEventHandlers]) {
        handler(event);
      }
    },
    emitExit: (exit) => {
      for (const handler of [...exitHandlers]) {
        handler(exit);
      }
    },
  };
}

function lifecycleEvent(sequence: number): RuntimeHostSafeEvent {
  return {
    type: 'openclaw.lifecycle',
    sequence,
    hasRun: true,
    hasMessage: false,
    hasSessionActivity: false,
  };
}

describe('RuntimeHostLifecycleOwner', () => {
  it('keeps the direct host surface stable while delegating commands and traces', async () => {
    const initialRuntimeHost = createRuntimeHost('first');
    const owner = new RuntimeHostLifecycleOwner(initialRuntimeHost, async () => createRuntimeHost('second'));

    await expect(owner.command({ name: 'host.health' })).resolves.toEqual({
      kind: 'succeeded',
      result: { host: 'first' },
    } satisfies RuntimeHostControlOutcome);
    expect(owner.readE2ECronProviderTrace()).toEqual(['first']);
    expect('request' in owner).toBe(false);
    expect('child' in owner).toBe(false);
    expect('manager' in owner).toBe(false);
  });

  it('delegates a normal stop, forwards its clean exit, and rejects later commands', async () => {
    const initialRuntimeHost = createRuntimeHost('first');
    const stopped = createDeferred<void>();
    initialRuntimeHost.stop.mockReturnValueOnce(stopped.promise);
    const owner = new RuntimeHostLifecycleOwner(initialRuntimeHost, async () => createRuntimeHost('second'));
    const exits = vi.fn();
    owner.onExit(exits);

    const stopping = owner.stop();
    await vi.waitFor(() => {
      expect(initialRuntimeHost.stop).toHaveBeenCalledOnce();
    });
    initialRuntimeHost.emitExit({ kind: 'exited', code: 0, signal: null });
    stopped.resolve();

    await expect(stopping).resolves.toBeUndefined();
    expect(exits).toHaveBeenCalledOnce();
    expect(exits).toHaveBeenCalledWith({ kind: 'exited', code: 0, signal: null });
    await expect(owner.command({ name: 'host.health' })).rejects.toBeInstanceOf(
      RuntimeHostLifecycleUnavailableError,
    );
  });

  it('shares concurrent restart callers, replaces only after the new host is ready, and rebinds subscriptions', async () => {
    const initialRuntimeHost = createRuntimeHost('first');
    const replacement = createDeferred<DirectRuntimeHost>();
    const launchReplacement = vi.fn(() => replacement.promise);
    const owner = new RuntimeHostLifecycleOwner(initialRuntimeHost, launchReplacement);
    const safeEvents = vi.fn();
    const exits = vi.fn();
    owner.onSafeEvent(safeEvents);
    owner.onExit(exits);

    const firstRestart = owner.restart();
    const secondRestart = owner.restart();

    expect(secondRestart).toBe(firstRestart);
    await vi.waitFor(() => {
      expect(initialRuntimeHost.stop).toHaveBeenCalledOnce();
    });
    initialRuntimeHost.emitSafeEvent(lifecycleEvent(1));
    initialRuntimeHost.emitExit({ kind: 'exited', code: 0, signal: null });
    expect(safeEvents).not.toHaveBeenCalled();
    expect(exits).not.toHaveBeenCalled();

    const nextRuntimeHost = createRuntimeHost('second');
    replacement.resolve(nextRuntimeHost);
    await expect(firstRestart).resolves.toBeUndefined();

    expect(launchReplacement).toHaveBeenCalledOnce();
    await expect(owner.command({ name: 'host.health' })).resolves.toEqual({
      kind: 'succeeded',
      result: { host: 'second' },
    } satisfies RuntimeHostControlOutcome);
    expect(owner.readE2ECronProviderTrace()).toEqual(['second']);

    nextRuntimeHost.emitSafeEvent(lifecycleEvent(2));
    expect(safeEvents).toHaveBeenCalledOnce();
    expect(safeEvents).toHaveBeenCalledWith(lifecycleEvent(2));
    expect(exits).not.toHaveBeenCalled();
  });

  it('force-kills the old child after graceful stop failure before launching its replacement', async () => {
    const initialRuntimeHost = createRuntimeHost('first');
    initialRuntimeHost.stop.mockRejectedValueOnce(new Error('stop failed'));
    const nextRuntimeHost = createRuntimeHost('second');
    const launchReplacement = vi.fn(async () => nextRuntimeHost);
    const owner = new RuntimeHostLifecycleOwner(initialRuntimeHost, launchReplacement);

    await owner.restart();

    expect(initialRuntimeHost.stop).toHaveBeenCalledOnce();
    expect(initialRuntimeHost.forceKill).toHaveBeenCalledOnce();
    expect(launchReplacement).toHaveBeenCalledOnce();
    await expect(owner.command({ name: 'host.health' })).resolves.toEqual({
      kind: 'succeeded',
      result: { host: 'second' },
    } satisfies RuntimeHostControlOutcome);
  });

  it('retains an alive old child when graceful stop and force kill both fail', async () => {
    const initialRuntimeHost = createRuntimeHost('first');
    initialRuntimeHost.stop.mockRejectedValueOnce(new Error('stop failed'));
    const forceKillFailure = new Error('force kill failed');
    initialRuntimeHost.forceKill.mockRejectedValueOnce(forceKillFailure);
    const launchReplacement = vi.fn(async () => createRuntimeHost('second'));
    const owner = new RuntimeHostLifecycleOwner(initialRuntimeHost, launchReplacement);

    await expect(owner.restart()).rejects.toBe(forceKillFailure);
    expect(launchReplacement).not.toHaveBeenCalled();
    await expect(owner.command({ name: 'host.health' })).resolves.toEqual({
      kind: 'succeeded',
      result: { host: 'first' },
    } satisfies RuntimeHostControlOutcome);
  });

  it('publishes the stopped old child exit and becomes unavailable when replacement launch fails', async () => {
    const initialRuntimeHost = createRuntimeHost('first');
    const stopped = createDeferred<void>();
    initialRuntimeHost.stop.mockReturnValueOnce(stopped.promise);
    const launchFailure = new Error('launch failed');
    const owner = new RuntimeHostLifecycleOwner(initialRuntimeHost, async () => {
      throw launchFailure;
    });
    const exits = vi.fn();
    owner.onExit(exits);

    const restarting = owner.restart();
    await vi.waitFor(() => {
      expect(initialRuntimeHost.stop).toHaveBeenCalledOnce();
    });
    initialRuntimeHost.emitExit({ kind: 'exited', code: 0, signal: null });
    stopped.resolve();

    await expect(restarting).rejects.toBe(launchFailure);
    expect(exits).toHaveBeenCalledOnce();
    expect(exits).toHaveBeenCalledWith({ kind: 'exited', code: 0, signal: null });
    await expect(owner.command({ name: 'host.health' })).rejects.toBeInstanceOf(
      RuntimeHostLifecycleUnavailableError,
    );
    expect(() => owner.readE2ECronProviderTrace()).toThrow(RuntimeHostLifecycleUnavailableError);

    const lateExit = vi.fn();
    owner.onExit(lateExit);
    expect(lateExit).toHaveBeenCalledWith({ kind: 'exited', code: 0, signal: null });
  });

  it('forwards an unexpected active child crash and becomes unavailable', async () => {
    const initialRuntimeHost = createRuntimeHost('first');
    const owner = new RuntimeHostLifecycleOwner(initialRuntimeHost, async () => createRuntimeHost('second'));
    const exits = vi.fn();
    owner.onExit(exits);

    initialRuntimeHost.emitExit({ kind: 'failed' });

    expect(exits).toHaveBeenCalledOnce();
    expect(exits).toHaveBeenCalledWith({ kind: 'failed' });
    await expect(owner.command({ name: 'host.health' })).rejects.toBeInstanceOf(
      RuntimeHostLifecycleUnavailableError,
    );
  });

  it('force-kills after the graceful stop deadline before launching its replacement', async () => {
    vi.useFakeTimers();
    try {
      const initialRuntimeHost = createRuntimeHost('first');
      initialRuntimeHost.stop.mockReturnValueOnce(new Promise(() => undefined));
      const nextRuntimeHost = createRuntimeHost('second');
      const launchReplacement = vi.fn(async () => nextRuntimeHost);
      const owner = new RuntimeHostLifecycleOwner(initialRuntimeHost, launchReplacement);

      const restarting = owner.restart();
      await vi.waitFor(() => {
        expect(initialRuntimeHost.stop).toHaveBeenCalledOnce();
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await restarting;

      expect(initialRuntimeHost.forceKill).toHaveBeenCalledOnce();
      expect(launchReplacement).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes stop behind an in-flight restart and applies it to the replacement child', async () => {
    const initialRuntimeHost = createRuntimeHost('first');
    const replacement = createDeferred<DirectRuntimeHost>();
    const owner = new RuntimeHostLifecycleOwner(initialRuntimeHost, () => replacement.promise);

    const restarting = owner.restart();
    const stopping = owner.stop();
    await vi.waitFor(() => {
      expect(initialRuntimeHost.stop).toHaveBeenCalledOnce();
    });

    const nextRuntimeHost = createRuntimeHost('second');
    replacement.resolve(nextRuntimeHost);
    await restarting;
    await stopping;

    expect(initialRuntimeHost.stop).toHaveBeenCalledOnce();
    expect(nextRuntimeHost.stop).toHaveBeenCalledOnce();
  });

  it('drops stale child notifications after replacement', async () => {
    const initialRuntimeHost = createRuntimeHost('first');
    const nextRuntimeHost = createRuntimeHost('second');
    const owner = new RuntimeHostLifecycleOwner(initialRuntimeHost, async () => nextRuntimeHost);
    const safeEvents = vi.fn();
    const exits = vi.fn();
    owner.onSafeEvent(safeEvents);
    owner.onExit(exits);

    await owner.restart();
    initialRuntimeHost.emitSafeEvent(lifecycleEvent(1));
    initialRuntimeHost.emitExit({ kind: 'failed' });
    expect(safeEvents).not.toHaveBeenCalled();
    expect(exits).not.toHaveBeenCalled();

    nextRuntimeHost.emitExit({ kind: 'failed' });
    expect(exits).toHaveBeenCalledOnce();
    expect(exits).toHaveBeenCalledWith({ kind: 'failed' });
  });
});
