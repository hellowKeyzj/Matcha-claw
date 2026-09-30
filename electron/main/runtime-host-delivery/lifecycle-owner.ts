import { randomUUID } from 'node:crypto';
import { RuntimeHostControlError } from './control';
import type {
  RuntimeHostControlCommand,
  RuntimeHostControlCommandOptions,
  RuntimeHostControlOutcome,
  RuntimeHostSafeEvent,
} from './control';
import type {
  DirectRuntimeHost,
  DirectRuntimeHostExit,
} from './direct-host';

const GRACEFUL_STOP_TIMEOUT_MS = 5_000;

type SafeEventHandler = (event: RuntimeHostSafeEvent) => void;
type ExitHandler = (exit: DirectRuntimeHostExit) => void;
type DisconnectHandler = (error: RuntimeHostControlError) => void;

export type RuntimeHostRestart = Readonly<{
  readonly previousPid?: number;
  readonly pid?: number;
  readonly status: 'running';
  readonly recoveredAt: number;
}>;
export type RuntimeHostRestartAdmission =
  | Readonly<{ accepted: true; restartId: string }>
  | Readonly<{ accepted: false; error: 'Runtime Host is shutting down' }>;

export type RuntimeHostRestartStatus =
  | Readonly<{ restartId: string; status: 'running' }>
  | Readonly<{ restartId: string; status: 'succeeded'; result: RuntimeHostRestart }>
  | Readonly<{ restartId: string; status: 'failed' | 'unknown'; error: string }>;

type RestartHandler = (restart: RuntimeHostRestart) => void;

type ActiveRuntimeHost = {
  readonly host: DirectRuntimeHost;
  readonly epoch: number;
  stopSafeEventSubscription: () => void;
  stopDisconnectSubscription: () => void;
  stopExitSubscription: () => void;
};

export type RuntimeHostLifecycleLaunch = () => Promise<DirectRuntimeHost>;

export class RuntimeHostLifecycleUnavailableError extends Error {
  readonly code = 'UNAVAILABLE';

  constructor() {
    super('Runtime Host is unavailable.');
    this.name = 'RuntimeHostLifecycleUnavailableError';
  }
}

export type RuntimeHostLifecycle = DirectRuntimeHost & Readonly<{
  restart: () => Promise<void>;
  admitRestart: () => RuntimeHostRestartAdmission;
  readRestart: (restartId: string) => RuntimeHostRestartStatus | undefined;
  onRestart: (handler: RestartHandler) => () => void;
}>;

export class RuntimeHostLifecycleOwner implements RuntimeHostLifecycle {
  private activeRuntimeHost: ActiveRuntimeHost | undefined;
  private nextEpoch = 1;
  private replacingEpoch: number | undefined;
  private replacementExit: DirectRuntimeHostExit | undefined;
  private lastExit: DirectRuntimeHostExit | undefined;
  private disconnectError: RuntimeHostControlError | undefined;
  private restartInFlight: Promise<void> | undefined;
  private latestRestart: RuntimeHostRestartStatus | undefined;
  private closing = false;
  private forceKillInFlight: Promise<void> | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private readonly safeEventHandlers = new Set<SafeEventHandler>();
  private readonly exitHandlers = new Set<ExitHandler>();
  private readonly disconnectHandlers = new Set<DisconnectHandler>();
  private readonly restartHandlers = new Set<RestartHandler>();

  constructor(
    initialRuntimeHost: DirectRuntimeHost,
    private readonly launchReplacement: RuntimeHostLifecycleLaunch,
  ) {
    this.attachRuntimeHost(initialRuntimeHost);
  }

  command(
    command: RuntimeHostControlCommand,
    options?: RuntimeHostControlCommandOptions,
  ): Promise<RuntimeHostControlOutcome> {
    const activeRuntimeHost = this.activeRuntimeHost;
    if (!activeRuntimeHost) {
      return Promise.reject(new RuntimeHostLifecycleUnavailableError());
    }
    return activeRuntimeHost.host.command(command, options);
  }

  onSafeEvent(handler: SafeEventHandler): () => void {
    this.safeEventHandlers.add(handler);
    return () => this.safeEventHandlers.delete(handler);
  }

  onDisconnect(handler: DisconnectHandler): () => void {
    this.disconnectHandlers.add(handler);
    if (this.disconnectError) handler(this.disconnectError);
    return () => this.disconnectHandlers.delete(handler);
  }

  onExit(handler: ExitHandler): () => void {
    this.exitHandlers.add(handler);
    if (!this.activeRuntimeHost && this.lastExit) {
      handler(this.lastExit);
    }
    return () => this.exitHandlers.delete(handler);
  }

  onRestart(handler: RestartHandler): () => void {
    this.restartHandlers.add(handler);
    return () => this.restartHandlers.delete(handler);
  }

  readE2ECronProviderTrace(): readonly string[] {
    return this.requireActiveRuntimeHost().host.readE2ECronProviderTrace();
  }

  stop(): Promise<void> {
    this.closing = true;
    return this.enqueueLifecycleOperation(async () => {
      await this.requireActiveRuntimeHost().host.stop();
    });
  }

  forceKill(): Promise<void> {
    this.closing = true;
    if (this.forceKillInFlight) return this.forceKillInFlight;
    const activeRuntimeHost = this.activeRuntimeHost;
    const forceKill = (async () => {
      await activeRuntimeHost?.host.forceKill();
      if (this.restartInFlight) {
        await this.restartInFlight.catch(() => undefined);
      }
      const replacement = this.activeRuntimeHost;
      if (replacement && replacement !== activeRuntimeHost) {
        await replacement.host.forceKill();
      }
    })();
    this.forceKillInFlight = forceKill;
    void forceKill.then(
      () => this.clearForceKillInFlight(forceKill),
      () => this.clearForceKillInFlight(forceKill),
    );
    return forceKill;
  }

  private clearForceKillInFlight(forceKill: Promise<void>): void {
    if (this.forceKillInFlight === forceKill) {
      this.forceKillInFlight = undefined;
    }
  }

  admitRestart(): RuntimeHostRestartAdmission {
    if (this.closing) {
      return { accepted: false, error: 'Runtime Host is shutting down' };
    }
    void this.restart();
    return { accepted: true, restartId: this.latestRestart!.restartId };
  }

  readRestart(restartId: string): RuntimeHostRestartStatus | undefined {
    return this.latestRestart?.restartId === restartId ? this.latestRestart : undefined;
  }

  restart(): Promise<void> {
    if (this.closing) return Promise.reject(new RuntimeHostLifecycleUnavailableError());
    if (this.restartInFlight) return this.restartInFlight;

    const restartId = randomUUID();
    this.latestRestart = { restartId, status: 'running' };
    const restart = this.enqueueLifecycleOperation(async () => {
      try {
        const result = await this.replaceRuntimeHost();
        this.latestRestart = { restartId, status: 'succeeded', result };
      } catch (error) {
        const unknown = error instanceof RuntimeHostLifecycleUnavailableError
          || error instanceof RuntimeHostControlError && error.delivery === 'unknown-delivery';
        this.latestRestart = {
          restartId,
          status: unknown ? 'unknown' : 'failed',
          error: unknown ? 'Runtime Host restart outcome is unknown' : 'Runtime Host restart failed',
        };
        throw error;
      }
    });
    this.restartInFlight = restart;
    void restart.then(
      () => this.clearRestartInFlight(restart),
      () => this.clearRestartInFlight(restart),
    );
    return restart;
  }

  private clearRestartInFlight(restart: Promise<void>): void {
    if (this.restartInFlight === restart) {
      this.restartInFlight = undefined;
    }
  }

  private enqueueLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  private async replaceRuntimeHost(): Promise<RuntimeHostRestart> {
    const previousRuntimeHost = this.activeRuntimeHost;
    let previousExit: DirectRuntimeHostExit | undefined;

    if (previousRuntimeHost) {
      this.replacingEpoch = previousRuntimeHost.epoch;
      this.replacementExit = undefined;
      try {
        await stopOrForceKillRuntimeHost(previousRuntimeHost.host);
      } catch (error) {
        const observedExit = this.replacementExit;
        this.replacingEpoch = undefined;
        this.replacementExit = undefined;
        if (observedExit) {
          this.detachRuntimeHost(previousRuntimeHost);
          this.publishExit(observedExit);
        }
        throw error;
      }

      previousExit = this.replacementExit;
      this.detachRuntimeHost(previousRuntimeHost);
      this.replacingEpoch = undefined;
      this.replacementExit = undefined;
    }

    let replacementLaunched = false;
    try {
      const replacementRuntimeHost = await this.launchReplacement();
      replacementLaunched = true;
      this.lastExit = undefined;
      const activeReplacement = this.attachRuntimeHost(replacementRuntimeHost);
      if (this.activeRuntimeHost !== activeReplacement) {
        throw new RuntimeHostLifecycleUnavailableError();
      }
      return this.publishRestart(previousRuntimeHost?.host.pid, replacementRuntimeHost.pid);
    } catch (error) {
      if (previousExit && !replacementLaunched) {
        this.publishExit(previousExit);
      }
      throw error;
    }
  }

  private attachRuntimeHost(host: DirectRuntimeHost): ActiveRuntimeHost {
    const activeRuntimeHost: ActiveRuntimeHost = {
      host,
      epoch: this.nextEpoch,
      stopSafeEventSubscription: () => {},
      stopDisconnectSubscription: () => {},
      stopExitSubscription: () => {},
    };
    this.nextEpoch += 1;
    this.disconnectError = undefined;
    this.activeRuntimeHost = activeRuntimeHost;

    const stopSafeEventSubscription = host.onSafeEvent((event) => {
      this.forwardSafeEvent(activeRuntimeHost, event);
    });
    if (this.activeRuntimeHost === activeRuntimeHost) {
      activeRuntimeHost.stopSafeEventSubscription = stopSafeEventSubscription;
    } else {
      stopSafeEventSubscription();
    }

    const stopDisconnectSubscription = host.onDisconnect((error) => {
      this.observeDisconnect(activeRuntimeHost, error);
    });
    if (this.activeRuntimeHost === activeRuntimeHost) {
      activeRuntimeHost.stopDisconnectSubscription = stopDisconnectSubscription;
    } else {
      stopDisconnectSubscription();
    }

    const stopExitSubscription = host.onExit((exit) => {
      this.observeExit(activeRuntimeHost, exit);
    });
    if (this.activeRuntimeHost === activeRuntimeHost) {
      activeRuntimeHost.stopExitSubscription = stopExitSubscription;
    } else {
      stopExitSubscription();
    }

    return activeRuntimeHost;
  }

  private detachRuntimeHost(activeRuntimeHost: ActiveRuntimeHost): void {
    if (this.activeRuntimeHost !== activeRuntimeHost) return;

    this.activeRuntimeHost = undefined;
    activeRuntimeHost.stopSafeEventSubscription();
    activeRuntimeHost.stopDisconnectSubscription();
    activeRuntimeHost.stopExitSubscription();
  }

  private forwardSafeEvent(activeRuntimeHost: ActiveRuntimeHost, event: RuntimeHostSafeEvent): void {
    if (this.activeRuntimeHost !== activeRuntimeHost
      || this.replacingEpoch === activeRuntimeHost.epoch) {
      return;
    }
    for (const handler of [...this.safeEventHandlers]) {
      handler(event);
    }
  }

  private observeDisconnect(activeRuntimeHost: ActiveRuntimeHost, error: RuntimeHostControlError): void {
    if (this.activeRuntimeHost !== activeRuntimeHost || this.disconnectError) return;

    // Replacement suppresses old business events, not loss of observation.
    this.disconnectError = error;
    for (const handler of [...this.disconnectHandlers]) {
      handler(error);
    }
  }

  private observeExit(activeRuntimeHost: ActiveRuntimeHost, exit: DirectRuntimeHostExit): void {
    if (this.activeRuntimeHost !== activeRuntimeHost) return;

    if (this.replacingEpoch === activeRuntimeHost.epoch) {
      this.replacementExit ??= exit;
      return;
    }

    this.detachRuntimeHost(activeRuntimeHost);
    this.publishExit(exit);
  }

  private publishExit(exit: DirectRuntimeHostExit): void {
    this.lastExit = exit;
    for (const handler of [...this.exitHandlers]) {
      handler(exit);
    }
  }

  private publishRestart(previousPid: number | undefined, pid: number | undefined): RuntimeHostRestart {
    const restart: RuntimeHostRestart = {
      ...(previousPid === undefined ? {} : { previousPid }),
      ...(pid === undefined ? {} : { pid }),
      status: 'running',
      recoveredAt: Date.now(),
    };
    for (const handler of [...this.restartHandlers]) {
      handler(restart);
    }
    return restart;
  }

  private requireActiveRuntimeHost(): ActiveRuntimeHost {
    if (!this.activeRuntimeHost) {
      throw new RuntimeHostLifecycleUnavailableError();
    }
    return this.activeRuntimeHost;
  }
}

export async function stopOrForceKillRuntimeHost(runtimeHost: DirectRuntimeHost): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    Promise.resolve().then(() => runtimeHost.stop()).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), GRACEFUL_STOP_TIMEOUT_MS);
      timeout.unref?.();
    }),
  ]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  if (!stopped) {
    await runtimeHost.forceKill();
  }
}
