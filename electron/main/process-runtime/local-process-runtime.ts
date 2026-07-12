import { exec, fork, spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type {
  LocalProcessAdapter,
  LocalProcessCrashEvent,
  LocalProcessLaunchPlan,
  LocalProcessLifecycle,
  LocalProcessLogger,
  LocalProcessReadiness,
  LocalProcessStartFailureContext,
  LocalProcessRunner,
  LocalProcessRuntimeOptions,
  LocalProcessState,
  LocalProcessLogStream,
  LocalProcessUtilityForkOptions,
  LocalProcessUtilityLauncher,
  LocalProcessUtilityProcess,
} from './contracts';
import { createProcessOutputLineBuffer, formatProcessLogPrefix, type ProcessOutputLineBuffer } from './log-tail';
import { waitForLocalProcessReadiness } from './readiness';
import { getLocalProcessRestartDecision } from './restart-policy';

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 1_200;
const DEFAULT_AUTO_RESTART_BASE_DELAY_MS = 300;
const DEFAULT_AUTO_RESTART_MAX_DELAY_MS = 5_000;
const DEFAULT_AUTO_RESTART_WINDOW_MS = 60_000;
const DEFAULT_AUTO_RESTART_MAX_ATTEMPTS = 6;

type LocalProcessExitEvent = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

type LocalProcessErrorEvent = {
  readonly message: string;
  readonly rawError?: unknown;
};

type LocalProcessHandle = {
  readonly pid?: number;
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
  readonly send?: (message: unknown) => boolean;
  readonly kill: (signal?: NodeJS.Signals) => boolean;
  readonly onceExit: (listener: (event: LocalProcessExitEvent) => void) => void;
  readonly onceError: (listener: (event: LocalProcessErrorEvent) => void) => void;
  readonly isAlive: () => boolean;
};

type ElectronUtilityModule = {
  readonly utilityProcess: LocalProcessUtilityLauncher;
};

type StartLaunchResult = {
  readonly child: LocalProcessHandle | null;
};

type StopMode = {
  readonly keepAlive: boolean;
};

type LifecycleOperationKind = 'start' | 'stop' | 'restart';

type LifecycleOperationContext = {
  readonly kind: LifecycleOperationKind;
  readonly epoch: number;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  startAttempt: number;
};

type LaunchFailure = {
  readonly epoch: number;
  readonly error: Error;
};

class LocalProcessLifecycleAbortError extends Error {
  constructor(kind: LifecycleOperationKind) {
    super(`Local process ${kind} operation aborted`);
    this.name = 'AbortError';
  }
}

export class LocalProcessRuntime implements LocalProcessRunner {
  private readonly adapter: LocalProcessAdapter;
  private readonly logger?: LocalProcessLogger;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly autoRestartOnCrash: boolean;
  private readonly autoRestartBaseDelayMs: number;
  private readonly autoRestartMaxDelayMs: number;
  private readonly autoRestartWindowMs: number;
  private readonly autoRestartMaxAttempts: number;
  private readonly utilityLauncher?: LocalProcessUtilityLauncher;
  private readonly stateChangeEmitter = new EventEmitter();
  private readonly readinessControllers = new Set<AbortController>();

  private lifecycle: LocalProcessLifecycle = 'idle';
  private child: LocalProcessHandle | null = null;
  private launchPlan: LocalProcessLaunchPlan | null = null;
  private lastError: string | undefined;
  private shouldKeepAlive = false;
  private autoRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private crashTimestamps: readonly number[] = [];
  private activeOperation: LifecycleOperationContext | null = null;
  private startInflight: Promise<void> | null = null;
  private startInflightOperation: LifecycleOperationContext | null = null;
  private restartInflight: Promise<void> | null = null;
  private restartInflightOperation: LifecycleOperationContext | null = null;
  private stopInflight: Promise<void> | null = null;
  private lifecycleEpoch = 0;
  private launchFailure: LaunchFailure | null = null;

  constructor(options: LocalProcessRuntimeOptions) {
    this.adapter = options.adapter;
    this.logger = options.logger;
    this.startTimeoutMs = positiveNumberOrDefault(options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS);
    this.stopTimeoutMs = positiveNumberOrDefault(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
    this.autoRestartOnCrash = options.autoRestartOnCrash !== false;
    this.autoRestartBaseDelayMs = positiveNumberOrDefault(
      options.autoRestartBaseDelayMs,
      DEFAULT_AUTO_RESTART_BASE_DELAY_MS,
    );
    this.autoRestartMaxDelayMs = positiveNumberOrDefault(
      options.autoRestartMaxDelayMs,
      DEFAULT_AUTO_RESTART_MAX_DELAY_MS,
    );
    this.autoRestartWindowMs = positiveNumberOrDefault(
      options.autoRestartWindowMs,
      DEFAULT_AUTO_RESTART_WINDOW_MS,
    );
    this.autoRestartMaxAttempts = positiveNumberOrDefault(
      options.autoRestartMaxAttempts,
      DEFAULT_AUTO_RESTART_MAX_ATTEMPTS,
    );
    this.utilityLauncher = options.utilityLauncher;
  }

  async start(): Promise<void> {
    if (this.restartInflight && !this.restartInflightBelongsToAbortedOperation()) {
      return await this.restartInflight;
    }
    if (this.stopInflight) {
      await this.stopInflight;
    }
    if (this.startInflight && !this.startInflightBelongsToAbortedOperation()) {
      return await this.startInflight;
    }
    if (this.lifecycle === 'running') {
      return;
    }

    const operation = this.beginLifecycleOperation('start');
    const task = this.startInternal(operation);
    this.startInflight = task;
    this.startInflightOperation = operation;
    try {
      await task;
    } finally {
      if (this.startInflight === task) {
        this.startInflight = null;
        this.startInflightOperation = null;
      }
      this.finishLifecycleOperation(operation);
    }
  }

  async stop(): Promise<void> {
    if (this.stopInflight) {
      return await this.stopInflight;
    }
    const operation = this.beginLifecycleOperation('stop');
    const task = this.stopInternal({ keepAlive: false }, operation);
    this.stopInflight = task;
    try {
      await task;
    } catch (error) {
      if (!isAbortError(error)) {
        throw error;
      }
    } finally {
      if (this.stopInflight === task) {
        this.stopInflight = null;
      }
      this.finishLifecycleOperation(operation);
    }
  }

  async restart(): Promise<void> {
    if (this.restartInflight && !this.restartInflightBelongsToAbortedOperation()) {
      return await this.restartInflight;
    }
    if (this.stopInflight) {
      await this.stopInflight;
    }

    const operation = this.beginLifecycleOperation('restart');
    const task = this.restartInternal(operation);
    this.restartInflight = task;
    this.restartInflightOperation = operation;
    try {
      await task;
    } finally {
      if (this.restartInflight === task) {
        this.restartInflight = null;
        this.restartInflightOperation = null;
      }
      this.finishLifecycleOperation(operation);
    }
  }

  async forceTerminate(): Promise<void> {
    const operation = this.beginLifecycleOperation('stop');
    try {
      this.shouldKeepAlive = false;
      this.clearAutoRestartTimer();
      this.abortReadinessControllers(operation.signal.reason);

      const previousPlan = this.launchPlan;
      const previousChild = this.child;
      if (previousPlan?.kind === 'external') {
        await this.adapter.externalController?.stop?.();
      } else if (previousChild) {
        await forceTerminateChildProcess(
          previousChild,
          previousPlan,
          this.stopTimeoutMs,
          this.logger,
          this.adapter.displayName,
        );
      }

      if (this.child === previousChild) {
        this.child = null;
      }
      if (this.launchPlan === previousPlan) {
        this.launchPlan = null;
      }
      this.lifecycle = 'stopped';
      this.lastError = undefined;
      this.launchFailure = null;
      this.emitStateChange();
      await this.adapter.onStopped?.(this.getState());
    } finally {
      this.finishLifecycleOperation(operation);
    }
  }

  async checkReadiness(): Promise<LocalProcessReadiness> {
    if (!this.launchPlan) {
      return { status: 'not-ready', detail: 'process has not been launched' };
    }
    const controller = this.registerReadinessController();
    const timeout = setTimeout(() => controller.abort(new Error('readiness check timed out')), 800);
    try {
      const readiness = await this.adapter.probeReadiness(this.launchPlan, {
        nowMs: () => Date.now(),
        signal: controller.signal,
      });
      return controller.signal.aborted
        ? { status: 'error', error: 'readiness check aborted' }
        : readiness;
    } catch (error) {
      if (controller.signal.aborted) {
        return { status: 'error', error: 'readiness check aborted' };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.readinessControllers.delete(controller);
    }
  }

  getState(): LocalProcessState {
    const pid = this.child?.pid ?? this.launchPlan?.pid;
    return {
      id: this.adapter.id,
      displayName: this.adapter.displayName,
      lifecycle: this.lifecycle,
      ...(pid ? { pid } : {}),
      ...(this.launchPlan?.port ? { port: this.launchPlan.port } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  onStateChange(handler: (state: LocalProcessState) => void): () => void {
    this.stateChangeEmitter.on('change', handler);
    return () => {
      this.stateChangeEmitter.off('change', handler);
    };
  }

  private async restartInternal(operation: LifecycleOperationContext): Promise<void> {
    this.assertOperationActive(operation);
    this.lifecycle = 'restarting';
    this.lastError = undefined;
    this.emitStateChange();

    try {
      if (this.adapter.externalController?.restart && this.launchPlan?.kind === 'external') {
        await this.adapter.externalController.restart();
        this.assertOperationActive(operation);
        await this.waitUntilReady(this.launchPlan, operation);
        this.assertOperationActive(operation);
        this.lifecycle = 'running';
        this.emitStateChange();
        await this.adapter.onStarted?.(this.getState());
        return;
      }

      await this.stopInternal({ keepAlive: true }, operation);
      this.assertOperationActive(operation);
      await this.startInternal(operation);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      const normalizedError = toError(error);
      this.shouldKeepAlive = false;
      this.clearAutoRestartTimer();
      this.markError(normalizedError.message);
      throw normalizedError;
    }
  }

  private async startInternal(operation: LifecycleOperationContext): Promise<void> {
    this.shouldKeepAlive = true;
    this.clearAutoRestartTimer();
    if (this.lifecycle === 'running') {
      return;
    }

    this.lifecycle = 'starting';
    this.lastError = undefined;
    this.emitStateChange();

    let plan: LocalProcessLaunchPlan | undefined;
    let shouldReuseCurrentLaunch = false;

    while (true) {
      this.assertOperationActive(operation);
      operation.startAttempt += 1;
      try {
        if (!shouldReuseCurrentLaunch) {
          plan = await this.adapter.prepareLaunch({
            nowMs: () => Date.now(),
            attempt: operation.startAttempt,
            signal: operation.signal,
            assertActive: () => this.assertOperationActive(operation),
          });
          this.assertOperationActive(operation);
          this.launchPlan = plan;

          if (!this.canReuseCurrentLaunch(plan)) {
            const launch = await this.startLaunchPlan(plan, operation);
            this.assertOperationActive(operation);
            if (launch.child) {
              this.child = launch.child;
              this.bindChildProcess(this.child, plan, operation.epoch);
            }
            await this.adapter.onLaunched?.(this.getState());
          }
        }

        await this.waitUntilReady(plan!, operation);
        this.assertOperationActive(operation);
        this.lifecycle = 'running';
        this.lastError = undefined;
        this.crashTimestamps = [];
        this.launchFailure = null;
        this.emitStateChange();
        await this.adapter.onStarted?.(this.getState());
        return;
      } catch (error) {
        let normalizedError = toError(error);
        if (!operation.signal.aborted) {
          normalizedError = this.takeLaunchFailure(operation) ?? normalizedError;
        }
        if (isAbortError(normalizedError) || operation.signal.aborted) {
          if (this.activeOperation === operation) {
            await this.stopInternal({ keepAlive: false }, operation);
          }
          throw normalizedError;
        }

        this.clearAutoRestartTimer();
        this.assertOperationActive(operation);
        const recovery = await this.resolveStartFailureRecovery({
          error: normalizedError,
          attempt: operation.startAttempt,
          ...(plan ? { plan } : {}),
          nowMs: () => Date.now(),
          signal: operation.signal,
        });
        this.assertOperationActive(operation);
        if (recovery.cleanup === 'stop-current') {
          await this.stopInternal({ keepAlive: true }, operation);
          this.assertOperationActive(operation);
        }
        if (recovery.action === 'retry') {
          shouldReuseCurrentLaunch = recovery.cleanup === 'keep-current'
            && this.canRetryCurrentLaunch(plan);
          this.lifecycle = 'starting';
          this.lastError = undefined;
          this.emitStateChange();
          continue;
        }

        this.shouldKeepAlive = false;
        this.clearAutoRestartTimer();
        this.markError(normalizedError.message);
        throw normalizedError;
      }
    }
  }

  private async startLaunchPlan(
    plan: LocalProcessLaunchPlan,
    operation: LifecycleOperationContext,
  ): Promise<StartLaunchResult> {
    this.assertOperationActive(operation);
    if (plan.kind === 'external') {
      await this.adapter.externalController?.start?.();
      this.assertOperationActive(operation);
      return { child: null };
    }

    if (!plan.command) {
      throw new Error(`${this.adapter.displayName} launch plan is missing command`);
    }

    if (plan.kind === 'node-child') {
      const child = createChildProcessHandle(fork(plan.command, [...(plan.args ?? [])], {
        cwd: plan.cwd,
        env: plan.env,
        stdio: buildStdio(plan.stdio ?? 'pipe', true),
        detached: shouldCreateProcessGroup(plan),
      }));
      try {
        this.assertOperationActive(operation);
      } catch (error) {
        await terminateChildProcess(child, this.stopTimeoutMs, plan);
        throw error;
      }
      this.logger?.info?.(
        `[${this.adapter.displayName}] start requested (script="${plan.command}", port=${String(plan.port ?? 'n/a')})`,
      );
      return { child };
    }

    if (plan.kind === 'spawn') {
      const child = createChildProcessHandle(spawn(plan.command, [...(plan.args ?? [])], {
        cwd: plan.cwd,
        env: plan.env,
        stdio: buildStdio(plan.stdio ?? 'pipe', plan.ipc === true),
        shell: false,
        detached: shouldCreateProcessGroup(plan),
      }));
      try {
        this.assertOperationActive(operation);
      } catch (error) {
        await terminateChildProcess(child, this.stopTimeoutMs, plan);
        throw error;
      }
      this.logger?.info?.(
        `[${this.adapter.displayName}] start requested (command="${plan.command}", port=${String(plan.port ?? 'n/a')})`,
      );
      return { child };
    }

    if (plan.kind === 'utility') {
      const child = await this.launchUtilityProcess(plan.command, plan);
      try {
        this.assertOperationActive(operation);
      } catch (error) {
        await terminateChildProcess(child, this.stopTimeoutMs, plan);
        throw error;
      }
      this.logger?.info?.(
        `[${this.adapter.displayName}] utility start requested (module="${plan.command}", port=${String(plan.port ?? 'n/a')})`,
      );
      return { child };
    }

    throw new Error(`${this.adapter.displayName} launch kind "${plan.kind}" is not supported yet`);
  }

  private async launchUtilityProcess(modulePath: string, plan: LocalProcessLaunchPlan): Promise<LocalProcessHandle> {
    const launcher = this.utilityLauncher ?? await loadElectronUtilityLauncher();
    const options = buildUtilityForkOptions(plan);
    const utilityProcess = await launcher.fork(modulePath, [...(plan.args ?? [])], options);
    return createUtilityProcessHandle(utilityProcess);
  }

  private async waitUntilReady(
    plan: LocalProcessLaunchPlan,
    operation: LifecycleOperationContext,
  ): Promise<void> {
    this.assertOperationActive(operation);
    const readinessController = this.registerReadinessController(operation);
    try {
      const readiness = await waitForLocalProcessReadiness({
        adapter: this.adapter,
        plan,
        timeoutMs: this.startTimeoutMs,
        nowMs: () => Date.now(),
        signal: readinessController.signal,
      });
      this.throwLaunchFailure(operation);
      this.assertOperationActive(operation);
      if (readiness.status !== 'ready') {
        throw new Error(readiness.status === 'error'
          ? readiness.error
          : readiness.detail ?? `${this.adapter.displayName} readiness check failed`);
      }
      this.throwLaunchFailure(operation);
    } finally {
      this.readinessControllers.delete(readinessController);
    }
  }

  private async stopInternal(
    mode: StopMode,
    operation: LifecycleOperationContext,
  ): Promise<void> {
    this.shouldKeepAlive = mode.keepAlive;
    if (!mode.keepAlive) {
      this.clearAutoRestartTimer();
    }
    this.abortReadinessControllers(operation.signal.reason);

    const previousPlan = this.launchPlan;
    const previousChild = this.child;
    if (!previousChild && previousPlan?.kind !== 'external') {
      this.lifecycle = mode.keepAlive ? 'idle' : 'stopped';
      if (!mode.keepAlive) {
        this.launchPlan = null;
      }
      this.emitStateChange();
      await this.adapter.onStopped?.(this.getState());
      return;
    }

    this.lifecycle = 'stopping';
    this.emitStateChange();

    try {
      if (previousPlan?.kind === 'external') {
        await this.adapter.externalController?.stop?.();
        this.assertOperationActive(operation);
        if (this.launchPlan === previousPlan) {
          this.launchPlan = mode.keepAlive ? this.launchPlan : null;
        }
        this.child = null;
        this.lifecycle = mode.keepAlive ? 'idle' : 'stopped';
        this.emitStateChange();
        await this.adapter.onStopped?.(this.getState());
        return;
      }

      if (previousChild) {
        await terminateChildProcess(previousChild, this.stopTimeoutMs, previousPlan);
        this.assertOperationActive(operation);
        if (this.child === previousChild) {
          this.child = null;
        }
      }

      this.assertOperationActive(operation);
      if (this.launchPlan === previousPlan && !mode.keepAlive) {
        this.launchPlan = null;
      }
      this.lifecycle = mode.keepAlive ? 'idle' : 'stopped';
      this.emitStateChange();
      await this.adapter.onStopped?.(this.getState());
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (!mode.keepAlive) {
        this.shouldKeepAlive = false;
      }
      const normalizedError = toError(error);
      this.markError(normalizedError.message);
      throw normalizedError;
    }
  }

  private bindChildProcess(
    child: LocalProcessHandle,
    plan: LocalProcessLaunchPlan,
    launchEpoch: number,
  ): void {
    const stdoutLineBuffer = createProcessOutputLineBuffer();
    const stderrLineBuffer = createProcessOutputLineBuffer();

    child.onceExit(({ code, signal }) => {
      this.flushLogOutput('stdout', stdoutLineBuffer);
      this.flushLogOutput('stderr', stderrLineBuffer);

      if (this.child !== child || this.lifecycleEpoch !== launchEpoch) {
        return;
      }

      const previousLifecycle = this.lifecycle;
      const previousPid = child.pid;
      this.child = null;

      if (
        previousLifecycle === 'stopping'
        || previousLifecycle === 'stopped'
        || previousLifecycle === 'idle'
      ) {
        return;
      }

      if (plan.terminateProcessTree === true && typeof previousPid === 'number') {
        void terminateProcessTree(previousPid, this.logger, this.adapter.displayName).catch((error) => {
          this.logger?.warn?.(
            `[${this.adapter.displayName}] failed to clean up descendants after child exit`,
            error,
          );
        });
      }

      const message = `${this.adapter.displayName} exited unexpectedly (code=${String(code)}, signal=${String(signal)})`;
      this.logger?.warn?.(
        `[${this.adapter.displayName}] exited unexpectedly (code=${String(code)}, signal=${String(signal)}, previousLifecycle=${previousLifecycle})`,
      );
      const crashEvent: LocalProcessCrashEvent = {
        id: this.adapter.id,
        displayName: this.adapter.displayName,
        ...(previousPid ? { pid: previousPid } : {}),
        code,
        signal,
        message,
      };

      const operation = this.activeOperation;
      if (
        operation?.epoch === launchEpoch
        && (operation.kind === 'start' || operation.kind === 'restart')
      ) {
        this.launchFailure = { epoch: launchEpoch, error: new Error(message) };
        this.abortReadinessControllers(this.launchFailure.error);
        return;
      }

      void this.adapter.onCrashed?.(crashEvent);
      this.markError(message);
      this.scheduleAutoRestart('child-exit');
    });

    child.onceError(({ message, rawError }) => {
      if (this.child !== child || this.lifecycleEpoch !== launchEpoch) {
        return;
      }
      const errorMessage = `${this.adapter.displayName} process error: ${message}`;
      this.child = null;
      this.logger?.error?.(`[${this.adapter.displayName}] process error`, rawError ?? message);
      const operation = this.activeOperation;
      if (
        operation?.epoch === launchEpoch
        && (operation.kind === 'start' || operation.kind === 'restart')
      ) {
        this.launchFailure = { epoch: launchEpoch, error: new Error(errorMessage) };
        this.abortReadinessControllers(this.launchFailure.error);
        return;
      }
      this.markError(errorMessage);
      this.scheduleAutoRestart('child-error');
    });

    child.stdout?.on('data', (chunk) => this.logOutput('stdout', stdoutLineBuffer, chunk));
    child.stderr?.on('data', (chunk) => this.logOutput('stderr', stderrLineBuffer, chunk));
  }

  private logOutput(
    stream: LocalProcessLogStream,
    lineBuffer: ProcessOutputLineBuffer,
    chunk: string | Buffer,
  ): void {
    this.writeLogLines(stream, lineBuffer.push(chunk));
  }

  private flushLogOutput(
    stream: LocalProcessLogStream,
    lineBuffer: ProcessOutputLineBuffer,
  ): void {
    this.writeLogLines(stream, lineBuffer.flush());
  }

  private writeLogLines(stream: LocalProcessLogStream, lines: string[]): void {
    for (const line of lines) {
      const event = this.adapter.classifyLog?.(line, stream) ?? {
        level: stream === 'stderr' ? 'warn' as const : 'info' as const,
        message: line,
      };
      if (event.level === 'drop') {
        continue;
      }
      const message = `${formatProcessLogPrefix(this.adapter.displayName, stream)} ${event.message}`;
      if (event.level === 'debug') {
        this.logger?.debug?.(message);
        continue;
      }
      if (event.level === 'warn') {
        this.logger?.warn?.(message);
        continue;
      }
      if (event.level === 'error') {
        this.logger?.error?.(message);
        continue;
      }
      this.logger?.info?.(message);
    }
  }

  private scheduleAutoRestart(reason: string): void {
    const decision = getLocalProcessRestartDecision({
      autoRestartOnCrash: this.autoRestartOnCrash,
      shouldKeepAlive: this.shouldKeepAlive,
      hasRestartTimer: this.autoRestartTimer !== null,
      hasChildProcess: this.child !== null,
      nowMs: Date.now(),
      crashTimestamps: this.crashTimestamps,
      windowMs: this.autoRestartWindowMs,
      maxAttempts: this.autoRestartMaxAttempts,
      baseDelayMs: this.autoRestartBaseDelayMs,
      maxDelayMs: this.autoRestartMaxDelayMs,
    });

    if (decision.action === 'skip') {
      return;
    }

    if (decision.action === 'halt') {
      this.crashTimestamps = decision.crashTimestamps;
      this.logger?.error?.(
        `[${this.adapter.displayName}] auto-restart halted: exceeded ${String(decision.maxAttempts)} crashes in ${String(decision.windowMs)}ms`,
      );
      void this.adapter.onAutoRestartHalted?.({
        reason,
        maxAttempts: decision.maxAttempts,
        windowMs: decision.windowMs,
      });
      return;
    }

    this.crashTimestamps = decision.crashTimestamps;
    this.logger?.warn?.(
      `[${this.adapter.displayName}] scheduling auto-restart in ${String(decision.delayMs)}ms (attempt=${String(decision.attempt)}, reason=${reason})`,
    );
    void this.adapter.onAutoRestartScheduled?.({
      reason,
      attempt: decision.attempt,
      delayMs: decision.delayMs,
    });
    this.autoRestartTimer = setTimeout(() => {
      this.autoRestartTimer = null;
      if (!this.shouldKeepAlive || this.child) {
        return;
      }
      void this.start().catch((error) => {
        this.logger?.error?.(`[${this.adapter.displayName}] auto-restart failed`, error);
        if (isAbortError(error)) {
          return;
        }
        this.shouldKeepAlive = true;
        this.scheduleAutoRestart('auto-restart-failed');
      });
    }, decision.delayMs);
    this.autoRestartTimer.unref?.();
  }

  private async resolveStartFailureRecovery(
    context: LocalProcessStartFailureContext,
  ): Promise<{ readonly action: 'retry' | 'fail'; readonly cleanup: 'stop-current' | 'keep-current' }> {
    const recovery = this.adapter.recoverStartFailure
      ? await this.adapter.recoverStartFailure(context)
      : { action: 'fail' as const };
    return {
      action: recovery.action,
      cleanup: recovery.cleanup ?? 'stop-current',
    };
  }

  private clearAutoRestartTimer(): void {
    if (!this.autoRestartTimer) {
      return;
    }
    clearTimeout(this.autoRestartTimer);
    this.autoRestartTimer = null;
  }

  private startInflightBelongsToAbortedOperation(): boolean {
    return this.startInflightOperation?.signal.aborted === true;
  }

  private restartInflightBelongsToAbortedOperation(): boolean {
    return this.restartInflightOperation?.signal.aborted === true;
  }

  private canReuseCurrentLaunch(plan: LocalProcessLaunchPlan): boolean {
    return this.child?.isAlive() === true
      && this.launchPlan !== null
      && haveSameLaunchIdentity(this.launchPlan, plan);
  }

  private canRetryCurrentLaunch(plan: LocalProcessLaunchPlan | undefined): boolean {
    if (!plan || this.launchPlan !== plan) {
      return false;
    }

    return plan.kind === 'external' || this.child?.isAlive() === true;
  }

  private takeLaunchFailure(operation: LifecycleOperationContext): Error | null {
    if (this.launchFailure?.epoch !== operation.epoch) {
      return null;
    }
    const failure = this.launchFailure.error;
    this.launchFailure = null;
    return failure;
  }

  private throwLaunchFailure(operation: LifecycleOperationContext): void {
    const failure = this.takeLaunchFailure(operation);
    if (failure) {
      throw failure;
    }
  }

  private beginLifecycleOperation(kind: LifecycleOperationKind): LifecycleOperationContext {
    const previousOperation = this.activeOperation;
    if (previousOperation) {
      previousOperation.controller.abort(new LocalProcessLifecycleAbortError(kind));
    }

    this.abortReadinessControllers(new LocalProcessLifecycleAbortError(kind));
    const controller = new AbortController();
    const operation: LifecycleOperationContext = {
      kind,
      epoch: this.lifecycleEpoch + 1,
      controller,
      signal: controller.signal,
      startAttempt: 0,
    };
    this.lifecycleEpoch = operation.epoch;
    this.activeOperation = operation;
    return operation;
  }

  private finishLifecycleOperation(operation: LifecycleOperationContext): void {
    if (this.activeOperation !== operation) {
      return;
    }
    this.activeOperation = null;
  }

  private assertOperationActive(operation: LifecycleOperationContext): void {
    if (operation.signal.aborted || this.activeOperation !== operation || this.lifecycleEpoch !== operation.epoch) {
      throw new LocalProcessLifecycleAbortError(operation.kind);
    }
  }

  private registerReadinessController(operation?: LifecycleOperationContext): AbortController {
    const controller = new AbortController();
    const abort = () => controller.abort(operation?.signal.reason);
    if (operation?.signal.aborted) {
      abort();
    } else if (operation) {
      operation.signal.addEventListener('abort', abort, { once: true });
    }
    this.readinessControllers.add(controller);
    return controller;
  }

  private abortReadinessControllers(reason?: unknown): void {
    for (const controller of this.readinessControllers) {
      controller.abort(reason);
    }
    this.readinessControllers.clear();
  }

  private markError(message: string): void {
    this.lifecycle = 'error';
    this.lastError = message;
    this.emitStateChange();
  }

  private emitStateChange(): void {
    this.stateChangeEmitter.emit('change', this.getState());
  }
}

export function createLocalProcessRuntime(options: LocalProcessRuntimeOptions): LocalProcessRuntime {
  return new LocalProcessRuntime(options);
}

function positiveNumberOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Number(value) : fallback;
}

function haveSameLaunchIdentity(
  current: LocalProcessLaunchPlan,
  next: LocalProcessLaunchPlan,
): boolean {
  return current.kind === next.kind
    && current.command === next.command
    && current.port === next.port;
}

function buildStdio(stdio: 'ignore' | 'pipe' | 'inherit', ipc: boolean): StdioOptions {
  if (ipc) {
    return [stdio, stdio, stdio, 'ipc'];
  }
  return [stdio, stdio, stdio];
}

function buildUtilityForkOptions(plan: LocalProcessLaunchPlan): LocalProcessUtilityForkOptions {
  return {
    cwd: plan.cwd,
    env: plan.env,
    stdio: plan.stdio ?? 'pipe',
    ...(plan.serviceName ? { serviceName: plan.serviceName } : {}),
  };
}

function createChildProcessHandle(child: ChildProcess): LocalProcessHandle {
  return {
    get pid() {
      return child.pid;
    },
    get stdout() {
      return child.stdout;
    },
    get stderr() {
      return child.stderr;
    },
    send: child.send ? (message) => child.send?.(message) === true : undefined,
    kill: (signal) => child.kill(signal),
    onceExit: (listener) => {
      child.once('exit', (code, signal) => listener({ code, signal }));
    },
    onceError: (listener) => {
      child.once('error', (error) => listener({ message: toErrorMessage(error), rawError: error }));
    },
    isAlive: () => child.exitCode === null && child.signalCode === null,
  };
}

function createUtilityProcessHandle(child: LocalProcessUtilityProcess): LocalProcessHandle {
  let exited = false;
  return {
    get pid() {
      return child.pid;
    },
    get stdout() {
      return child.stdout;
    },
    get stderr() {
      return child.stderr;
    },
    kill: () => child.kill(),
    onceExit: (listener) => {
      child.once('exit', (code) => {
        exited = true;
        listener({ code, signal: null });
      });
    },
    onceError: (listener) => {
      child.once('error', (type, location, report) => {
        listener({ message: formatUtilityProcessError(type, location, report) });
      });
    },
    isAlive: () => !exited && child.pid !== undefined,
  };
}

async function loadElectronUtilityLauncher(): Promise<LocalProcessUtilityLauncher> {
  const electron = await import('electron') as ElectronUtilityModule;
  return electron.utilityProcess;
}

function formatUtilityProcessError(type: string, location: string, report: string): string {
  const parts = [type, location, report].filter((part) => part.trim().length > 0);
  return parts.length > 0 ? parts.join(' ') : 'unknown utility process error';
}

async function terminateChildProcess(
  child: LocalProcessHandle,
  timeoutMs: number,
  plan: LocalProcessLaunchPlan | null,
): Promise<void> {
  const exitPromise = new Promise<void>((resolveExit) => {
    child.onceExit(() => resolveExit());
  });

  const pid = child.pid;
  try {
    if (plan?.gracefulShutdownMessage !== undefined && child.send) {
      if (!child.send(plan.gracefulShutdownMessage) && child.isAlive()) {
        throw new Error('graceful shutdown message was not delivered');
      }
    } else if (plan?.terminateProcessTree === true && typeof pid === 'number') {
      await terminateProcessTreeGracefully(pid, child);
    } else if (!child.kill('SIGTERM') && child.isAlive()) {
      throw new Error('SIGTERM was not delivered');
    }
  } catch (error) {
    if (!child.isAlive()) {
      return;
    }
    throw new Error('Failed to terminate child process gracefully', { cause: error });
  }

  await Promise.race([
    exitPromise,
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
  ]);

  const processStillAlive = child.isAlive()
    || (plan?.terminateProcessTree === true
      && typeof pid === 'number'
      && isProcessGroupAlive(pid));
  if (!processStillAlive) {
    return;
  }

  try {
    if (plan?.terminateProcessTree === true && typeof pid === 'number') {
      await terminateProcessTree(pid);
    } else if (!child.kill('SIGKILL') && child.isAlive()) {
      throw new Error('SIGKILL was not delivered');
    }
  } catch (error) {
    if (!child.isAlive()) {
      return;
    }
    throw new Error('Failed to force terminate child process', { cause: error });
  }

  await Promise.race([
    exitPromise,
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
  ]);
  if (child.isAlive() || (
    plan?.terminateProcessTree === true
    && typeof pid === 'number'
    && isProcessGroupAlive(pid)
  )) {
    throw new Error(`Child process ${String(pid ?? 'unknown')} is still running after force termination`);
  }
}

async function forceTerminateChildProcess(
  child: LocalProcessHandle,
  plan: LocalProcessLaunchPlan | null,
  timeoutMs: number,
  logger?: LocalProcessLogger,
  displayName = 'process',
): Promise<void> {
  const pid = child.pid;
  const exitPromise = new Promise<void>((resolveExit) => {
    child.onceExit(() => resolveExit());
  });

  try {
    if (plan?.terminateProcessTree === true && typeof pid === 'number') {
      await terminateProcessTree(pid, logger, displayName);
    } else if (!child.kill('SIGKILL') && child.isAlive()) {
      throw new Error('SIGKILL was not delivered');
    }
  } catch (error) {
    if (!child.isAlive()) {
      return;
    }
    throw new Error(`Failed to force terminate ${displayName}`, { cause: error });
  }

  await Promise.race([
    exitPromise,
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
  ]);
  if (child.isAlive() || (
    plan?.terminateProcessTree === true
    && typeof pid === 'number'
    && isProcessGroupAlive(pid)
  )) {
    throw new Error(`Failed to force terminate ${displayName}: process is still running`);
  }
}

function shouldCreateProcessGroup(plan: LocalProcessLaunchPlan): boolean {
  return plan.terminateProcessTree === true && process.platform !== 'win32';
}

async function terminateProcessTreeGracefully(
  pid: number,
  child: LocalProcessHandle,
): Promise<void> {
  if (process.platform === 'win32') {
    await terminateProcessTree(pid);
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function isProcessGroupAlive(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessTree(
  pid: number,
  logger?: LocalProcessLogger,
  displayName = 'process',
): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      exec(`taskkill /F /PID ${pid} /T`, { timeout: 5000, windowsHide: true }, (error) => {
        if (error) {
          logger?.warn?.(`[${displayName}] failed to terminate process tree`, error);
          reject(new Error(`Failed to terminate ${displayName} process tree`, { cause: error }));
          return;
        }
        resolve();
      });
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process may have exited already.
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toErrorMessage(error: unknown): string {
  return toError(error).message;
}
