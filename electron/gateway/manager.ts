/**
 * Gateway Process Manager
 * 仅负责 OpenClaw Gateway 进程生命周期，不再承担协议解析与 RPC 语义。
 */
import { EventEmitter } from 'events';
import { PORTS } from '../utils/config';
import { logger } from '../utils/logger';
import {
  DEFAULT_RECONNECT_CONFIG,
  type ReconnectConfig,
  type GatewayLifecycleState,
  getReconnectScheduleDecision,
  getReconnectSkipReason,
} from './process-policy';
import { GatewayStateController } from './state';
import { prepareGatewayLaunchContext } from './config-sync';
import { waitForGatewayPortReady } from './port-readiness';
import {
  findExistingGatewayProcess,
  runOpenClawDoctorRepair,
  terminateOwnedGatewayProcess,
  unloadLaunchctlGatewayService,
  waitForPortFree,
  warmupManagedPythonReadiness,
} from './supervisor';
import { GatewayLifecycleController, LifecycleSupersededError } from './lifecycle-controller';
import { launchGatewayProcess } from './process-launcher';
import { GatewayRestartController } from './restart-controller';
import { classifyGatewayStderrMessage, recordGatewayStartupStderrLine } from './startup-stderr';
import { runGatewayStartupSequence } from './startup-orchestrator';

export interface GatewayStatus {
  state: GatewayLifecycleState;
  port: number;
  pid?: number;
  uptime?: number;
  error?: string;
  connectedAt?: number;
  version?: string;
  reconnectAttempts?: number;
}

export interface GatewayManagerEvents {
  status: (status: GatewayStatus) => void;
  exit: (code: number | null) => void;
  error: (error: Error) => void;
}

export class GatewayManager extends EventEmitter {
  private process: Electron.UtilityProcess | null = null;
  private processExitCode: number | null = null;
  private ownsProcess = false;
  private status: GatewayStatus = { state: 'stopped', port: PORTS.OPENCLAW_GATEWAY };
  private readonly stateController: GatewayStateController;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectConfig: ReconnectConfig;
  private shouldReconnect = true;
  private startLock = false;
  private lastSpawnSummary: string | null = null;
  private recentStartupStderrLines: string[] = [];
  private restartInFlight: Promise<void> | null = null;
  private readonly lifecycleController = new GatewayLifecycleController();
  private readonly restartController = new GatewayRestartController();
  private reloadDebounceTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<ReconnectConfig>) {
    super();
    this.stateController = new GatewayStateController({
      emitStatus: (status) => {
        this.status = status;
        this.emit('status', status);
      },
      onTransition: (previousState, nextState) => {
        this.restartController.flushDeferredRestart(
          `status:${previousState}->${nextState}`,
          {
            state: this.status.state,
            startLock: this.startLock,
            shouldReconnect: this.shouldReconnect,
          },
          () => {
            void this.restart().catch((error) => {
              logger.warn('Deferred Gateway restart failed:', error);
            });
          },
        );
      },
    });
    this.reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...config };
  }

  private sanitizeSpawnArgs(args: string[]): string[] {
    const sanitized = [...args];
    const tokenIdx = sanitized.indexOf('--token');
    if (tokenIdx !== -1 && tokenIdx + 1 < sanitized.length) {
      sanitized[tokenIdx + 1] = '[redacted]';
    }
    return sanitized;
  }

  getStatus(): GatewayStatus {
    return this.stateController.getStatus();
  }

  isConnected(): boolean {
    return this.status.state === 'running';
  }

  async start(): Promise<void> {
    if (this.startLock) {
      logger.debug('Gateway start ignored because a start flow is already in progress');
      return;
    }

    if (this.status.state === 'running') {
      logger.debug('Gateway already running, skipping start');
      return;
    }

    this.startLock = true;
    const startEpoch = this.lifecycleController.bump('start');
    logger.info(`Gateway start requested (port=${this.status.port})`);
    this.lastSpawnSummary = null;
    this.shouldReconnect = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      logger.debug('Cleared pending reconnect timer because start was requested manually');
    }

    this.reconnectAttempts = 0;
    this.setStatus({ state: 'starting', reconnectAttempts: 0 });

    warmupManagedPythonReadiness();

    try {
      await runGatewayStartupSequence({
        port: this.status.port,
        ownedPid: this.process?.pid,
        shouldWaitForPortFree: process.platform === 'win32',
        resetStartupStderrLines: () => {
          this.recentStartupStderrLines = [];
        },
        getStartupStderrLines: () => this.recentStartupStderrLines,
        assertLifecycle: (phase) => {
          this.lifecycleController.assert(startEpoch, phase);
        },
        findExistingGateway: async (port, ownedPid) => {
          return await findExistingGatewayProcess({ port, ownedPid });
        },
        connect: async (port) => {
          this.setStatus({
            state: 'running',
            port,
            connectedAt: Date.now(),
            error: undefined,
          });
        },
        onConnectedToExistingGateway: () => {
          this.ownsProcess = false;
          this.setStatus({ pid: undefined });
        },
        waitForPortFree: async (port) => {
          await waitForPortFree(port);
        },
        startProcess: async () => {
          await this.startProcess();
        },
        waitForReady: async (port) => {
          await waitForGatewayPortReady({
            port,
            getProcessExitCode: () => this.processExitCode,
          });
        },
        onConnectedToManagedGateway: () => {
          logger.debug('Gateway started successfully');
        },
        runDoctorRepair: async () => await runOpenClawDoctorRepair(),
        onDoctorRepairSuccess: () => {
          this.setStatus({ state: 'starting', error: undefined, reconnectAttempts: 0 });
        },
        delay: async (ms) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
      });
    } catch (error) {
      if (error instanceof LifecycleSupersededError) {
        logger.debug(error.message);
        return;
      }
      logger.error(
        `Gateway start failed (port=${this.status.port}, reconnectAttempts=${this.reconnectAttempts}, spawn=${this.lastSpawnSummary ?? 'n/a'})`,
        error,
      );
      this.setStatus({ state: 'error', error: String(error) });
      throw error;
    } finally {
      this.startLock = false;
      this.restartController.flushDeferredRestart(
        'start:finally',
        {
          state: this.status.state,
          startLock: this.startLock,
          shouldReconnect: this.shouldReconnect,
        },
        () => {
          void this.restart().catch((error) => {
            logger.warn('Deferred Gateway restart failed:', error);
          });
        },
      );
    }
  }

  async stop(): Promise<void> {
    logger.info('Gateway stop requested');
    this.lifecycleController.bump('stop');
    this.shouldReconnect = false;
    this.clearAllTimers();

    if (this.process && this.ownsProcess) {
      const child = this.process;
      await terminateOwnedGatewayProcess(child);
      if (this.process === child) {
        this.process = null;
      }
    }

    this.ownsProcess = false;
    this.restartController.resetDeferredRestart();
    this.setStatus({ state: 'stopped', error: undefined, pid: undefined, connectedAt: undefined, uptime: undefined });
  }

  async restart(): Promise<void> {
    if (this.restartController.isRestartDeferred({
      state: this.status.state,
      startLock: this.startLock,
    })) {
      this.restartController.markDeferredRestart('restart', {
        state: this.status.state,
        startLock: this.startLock,
      });
      return;
    }

    if (this.restartInFlight) {
      logger.debug('Gateway restart already in progress, joining existing request');
      await this.restartInFlight;
      return;
    }

    logger.debug('Gateway restart requested');
    this.restartInFlight = (async () => {
      await this.stop();
      await this.start();
    })();

    try {
      await this.restartInFlight;
    } finally {
      this.restartInFlight = null;
      this.restartController.flushDeferredRestart(
        'restart:finally',
        {
          state: this.status.state,
          startLock: this.startLock,
          shouldReconnect: this.shouldReconnect,
        },
        () => {
          void this.restart().catch((error) => {
            logger.warn('Deferred Gateway restart failed:', error);
          });
        },
      );
    }
  }

  debouncedRestart(delayMs = 2000): void {
    this.restartController.debouncedRestart(delayMs, () => {
      void this.restart().catch((err) => {
        logger.warn('Debounced Gateway restart failed:', err);
      });
    });
  }

  async reload(): Promise<void> {
    if (this.restartController.isRestartDeferred({
      state: this.status.state,
      startLock: this.startLock,
    })) {
      this.restartController.markDeferredRestart('reload', {
        state: this.status.state,
        startLock: this.startLock,
      });
      return;
    }

    if (!this.process?.pid || this.status.state !== 'running') {
      logger.warn('Gateway reload requested while not running; falling back to restart');
      await this.restart();
      return;
    }

    if (process.platform === 'win32') {
      logger.debug('Windows detected, falling back to Gateway restart for reload');
      await this.restart();
      return;
    }

    const connectedForMs = this.status.connectedAt
      ? Date.now() - this.status.connectedAt
      : Number.POSITIVE_INFINITY;

    if (connectedForMs < 8000) {
      logger.info(`Gateway connected ${connectedForMs}ms ago, skipping reload signal`);
      return;
    }

    try {
      process.kill(this.process.pid, 'SIGUSR1');
      logger.info(`Sent SIGUSR1 to Gateway for config reload (pid=${this.process.pid})`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (this.status.state !== 'running' || !this.process?.pid) {
        logger.warn('Gateway did not stay running after reload signal, falling back to restart');
        await this.restart();
      }
    } catch (error) {
      logger.warn('Gateway reload signal failed, falling back to restart:', error);
      await this.restart();
    }
  }

  debouncedReload(delayMs = 1200): void {
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
    }
    logger.debug(`Gateway reload debounced (will fire in ${delayMs}ms)`);
    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = null;
      void this.reload().catch((err) => {
        logger.warn('Debounced Gateway reload failed:', err);
      });
    }, delayMs);
  }

  private clearAllTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.restartController.clearDebounceTimer();
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
  }

  async checkHealth(): Promise<{ ok: boolean; error?: string; uptime?: number }> {
    try {
      if (this.status.state !== 'running') {
        return { ok: false, error: `Gateway state is ${this.status.state}` };
      }

      const managedPid = this.process?.pid;
      if (this.ownsProcess && managedPid) {
        try {
          process.kill(managedPid, 0);
        } catch {
          return { ok: false, error: `Gateway process not alive (pid=${managedPid})` };
        }
      }

      const uptime = this.status.connectedAt
        ? Math.floor((Date.now() - this.status.connectedAt) / 1000)
        : undefined;
      return { ok: true, uptime };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  private async startProcess(): Promise<void> {
    const launchContext = await prepareGatewayLaunchContext(this.status.port);
    await unloadLaunchctlGatewayService();
    this.processExitCode = null;

    const { child, lastSpawnSummary } = await launchGatewayProcess({
      port: this.status.port,
      launchContext,
      sanitizeSpawnArgs: (args) => this.sanitizeSpawnArgs(args),
      getCurrentState: () => this.status.state,
      getShouldReconnect: () => this.shouldReconnect,
      onStderrLine: (line) => {
        recordGatewayStartupStderrLine(this.recentStartupStderrLines, line);
        const classified = classifyGatewayStderrMessage(line);
        if (classified.level === 'drop') return;
        if (classified.level === 'debug') {
          logger.debug(`[Gateway stderr] ${classified.normalized}`);
          return;
        }
        logger.warn(`[Gateway stderr] ${classified.normalized}`);
      },
      onSpawn: (pid) => {
        this.setStatus({ pid });
      },
      onExit: (exitedChild, code) => {
        this.processExitCode = code;
        this.ownsProcess = false;
        if (this.process === exitedChild) {
          this.process = null;
        }
        this.emit('exit', code);

        const previousState = this.status.state;
        if (previousState === 'running' || previousState === 'starting' || previousState === 'reconnecting') {
          this.setStatus({ state: 'stopped' });
          this.scheduleReconnect();
        }
      },
      onError: () => {
        this.ownsProcess = false;
        if (this.process === child) {
          this.process = null;
        }
      },
    });

    this.process = child;
    this.ownsProcess = true;
    this.lastSpawnSummary = lastSpawnSummary;
  }

  private scheduleReconnect(): void {
    const decision = getReconnectScheduleDecision({
      shouldReconnect: this.shouldReconnect,
      hasReconnectTimer: this.reconnectTimer !== null,
      reconnectAttempts: this.reconnectAttempts,
      maxAttempts: this.reconnectConfig.maxAttempts,
      baseDelay: this.reconnectConfig.baseDelay,
      maxDelay: this.reconnectConfig.maxDelay,
    });

    if (decision.action === 'skip') {
      logger.debug(`Gateway reconnect skipped (${decision.reason})`);
      return;
    }

    if (decision.action === 'already-scheduled') {
      return;
    }

    if (decision.action === 'fail') {
      logger.error(`Gateway reconnect failed: max attempts reached (${decision.maxAttempts})`);
      this.setStatus({
        state: 'error',
        error: 'Failed to reconnect after maximum attempts',
        reconnectAttempts: this.reconnectAttempts,
      });
      return;
    }

    const { delay, nextAttempt, maxAttempts } = decision;
    this.reconnectAttempts = nextAttempt;
    logger.warn(`Scheduling Gateway reconnect attempt ${nextAttempt}/${maxAttempts} in ${delay}ms`);

    this.setStatus({
      state: 'reconnecting',
      reconnectAttempts: this.reconnectAttempts,
    });
    const scheduledEpoch = this.lifecycleController.getCurrentEpoch();

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const skipReason = getReconnectSkipReason({
        scheduledEpoch,
        currentEpoch: this.lifecycleController.getCurrentEpoch(),
        shouldReconnect: this.shouldReconnect,
      });
      if (skipReason) {
        logger.debug(`Skipping reconnect attempt: ${skipReason}`);
        return;
      }
      try {
        await this.start();
        this.reconnectAttempts = 0;
      } catch (error) {
        logger.error('Gateway reconnection attempt failed:', error);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private setStatus(update: Partial<GatewayStatus>): void {
    this.stateController.setStatus(update);
  }
}
