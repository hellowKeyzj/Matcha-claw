import { EventEmitter } from 'events';
import { PORTS } from '../../../utils/config';
import { logger } from '../../../utils/logger';
import { type GatewayLifecycleState, shouldDeferRestart } from './process-policy';
import { GatewayStateController } from './state';
import { GatewayRestartController } from './restart-controller';
import type { RuntimeHostManager } from '../../runtime-host-manager';

export interface GatewayStatus {
  processState: GatewayLifecycleState;
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

export type GatewayRestartResult =
  | { readonly status: 'restarted' }
  | { readonly status: 'deferred' };

export type GatewayProcessController = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
};

/**
 * OpenClaw gateway domain/status facade.
 *
 * Physical spawn/kill/restart/crash ownership belongs to LocalProcessRuntime via
 * OpenClawGatewayProcessAdapter. This facade keeps gateway-specific status,
 * control-ready probe wiring, reload command, and debounced restart requests for
 * Electron/runtime-host callers.
 */
export class GatewayManager extends EventEmitter {
  private controlReadyProbe: ((timeoutMs: number, port: number, externalToken?: string) => Promise<void>) | null = null;
  private runtimeHostManager: RuntimeHostManager | null = null;
  private processController: GatewayProcessController | null = null;
  private readonly stateController: GatewayStateController;
  private readonly restartController = new GatewayRestartController();
  private reloadDebounceTimer: NodeJS.Timeout | null = null;
  private status: GatewayStatus = { processState: 'stopped', port: PORTS.OPENCLAW_GATEWAY };

  constructor() {
    super();
    this.stateController = new GatewayStateController({
      emitStatus: (status) => {
        this.status = status;
        this.emit('status', status);
      },
      onTransition: (previousState, nextState) => {
        this.flushDeferredRestart(`status:${previousState}->${nextState}`);
      },
    });
  }

  getStatus(): GatewayStatus {
    return this.stateController.getStatus();
  }

  setRuntimeHostManager(runtimeHost: RuntimeHostManager): void {
    this.runtimeHostManager = runtimeHost;
  }

  getRuntimeHostManager(): RuntimeHostManager {
    if (!this.runtimeHostManager) {
      throw new Error('Gateway runtimeHost manager is not configured');
    }
    return this.runtimeHostManager;
  }

  setProcessController(controller: GatewayProcessController): void {
    this.processController = controller;
  }

  setControlReadyProbe(
    probe: (timeoutMs: number, port: number, externalToken?: string) => Promise<void>,
  ): void {
    this.controlReadyProbe = probe;
  }

  async waitForControlReady(timeoutMs: number, port = this.status.port, externalToken?: string): Promise<void> {
    if (!this.controlReadyProbe) {
      throw new Error('Gateway control ready probe is not configured');
    }
    await this.controlReadyProbe(timeoutMs, port, externalToken);
  }

  isConnected(): boolean {
    return this.status.processState === 'running';
  }

  async start(): Promise<void> {
    await this.requireProcessController().start();
  }

  async stop(): Promise<void> {
    this.clearPendingGatewayControlTimers();
    await this.requireProcessController().stop();
  }

  async restart(): Promise<GatewayRestartResult> {
    if (shouldDeferRestart({ processState: this.status.processState })) {
      this.restartController.markDeferredRestart('restart', {
        processState: this.status.processState,
      });
      return { status: 'deferred' };
    }
    await this.requireProcessController().restart();
    this.restartController.recordRestartCompleted();
    return { status: 'restarted' };
  }

  debouncedRestart(delayMs = 2000): void {
    this.restartController.debouncedRestart(delayMs, () => {
      void this.restart().catch((err) => {
        logger.warn('Debounced Gateway restart failed:', err);
      });
    });
  }

  async reload(): Promise<void> {
    if (shouldDeferRestart({ processState: this.status.processState })) {
      this.restartController.markDeferredRestart('reload', {
        processState: this.status.processState,
      });
      return;
    }

    if (!this.status.pid || this.status.processState !== 'running') {
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
      process.kill(this.status.pid, 'SIGUSR1');
      logger.info(`Sent SIGUSR1 to Gateway for config reload (pid=${this.status.pid})`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (this.status.processState !== 'running' || !this.status.pid) {
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

  async checkHealth(): Promise<{ ok: boolean; error?: string; uptime?: number }> {
    try {
      if (this.status.processState !== 'running') {
        return { ok: false, error: `Gateway state is ${this.status.processState}` };
      }

      if (this.status.pid) {
        try {
          process.kill(this.status.pid, 0);
        } catch {
          return { ok: false, error: `Gateway process not alive (pid=${this.status.pid})` };
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

  markStarting(): void {
    this.setStatus({
      processState: 'starting',
      error: undefined,
      pid: undefined,
      connectedAt: undefined,
      uptime: undefined,
      reconnectAttempts: 0,
    });
  }

  markLaunched(pid?: number): void {
    this.setStatus({ ...(typeof pid === 'number' ? { pid } : {}) });
  }

  markControlConnecting(): void {
    this.setStatus({ processState: 'control_connecting', error: undefined });
  }

  markRunning(): void {
    this.setStatus({
      processState: 'running',
      port: this.status.port,
      connectedAt: Date.now(),
      error: undefined,
      reconnectAttempts: 0,
    });
    this.restartController.recordRestartCompleted();
    this.flushDeferredRestart('running');
  }

  markAutoRestartScheduled(attempt: number): void {
    this.setStatus({
      processState: 'reconnecting',
      reconnectAttempts: attempt,
    });
  }

  markAutoRestartHalted(error: string, reconnectAttempts: number): void {
    this.setStatus({
      processState: 'error',
      error,
      pid: undefined,
      connectedAt: undefined,
      uptime: undefined,
      reconnectAttempts,
    });
  }

  markStopped(): void {
    this.clearPendingGatewayControlTimers();
    this.restartController.resetDeferredRestart();
    this.setStatus({
      processState: 'stopped',
      error: undefined,
      pid: undefined,
      connectedAt: undefined,
      uptime: undefined,
      reconnectAttempts: 0,
    });
  }

  markError(error: string, options?: { readonly preservePid?: boolean }): void {
    this.setStatus({
      processState: 'error',
      error,
      ...(options?.preservePid === true ? {} : { pid: undefined }),
      connectedAt: undefined,
      uptime: undefined,
      reconnectAttempts: undefined,
    });
    this.flushDeferredRestart('error');
  }

  markCrashed(error: string, code: number | null): void {
    this.setStatus({
      processState: 'reconnecting',
      error,
      pid: undefined,
      connectedAt: undefined,
      uptime: undefined,
    });
    this.emit('exit', code);
    this.flushDeferredRestart('crashed');
  }

  private requireProcessController(): GatewayProcessController {
    if (!this.processController) {
      throw new Error('Gateway process controller is not configured');
    }
    return this.processController;
  }

  private clearPendingGatewayControlTimers(): void {
    this.restartController.clearDebounceTimer();
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
  }

  private flushDeferredRestart(trigger: string): void {
    this.restartController.flushDeferredRestart(
      trigger,
      {
        processState: this.status.processState,
      },
      () => {
        void this.restart().catch((error) => {
          logger.warn('Deferred Gateway restart failed:', error);
        });
      },
    );
  }

  private setStatus(update: Partial<GatewayStatus>): void {
    this.stateController.setStatus(update);
  }
}
