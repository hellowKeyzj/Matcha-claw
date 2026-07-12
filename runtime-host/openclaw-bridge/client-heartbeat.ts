import type {
  RuntimeClockPort,
  RuntimePlatform,
  RuntimeScheduledTask,
  RuntimeSchedulerPort,
} from '../application/common/runtime-ports';

export function getGatewayHeartbeatOptions(platform: RuntimePlatform) {
  return {
    intervalMs: platform === 'win32' ? 45_000 : 30_000,
    timeoutMs: platform === 'win32' ? 20_000 : 10_000,
    maxMisses: platform === 'win32' ? 4 : 3,
  };
}

export const GATEWAY_READY_FALLBACK_PROBE_DELAYS_MS = [1_500, 3_000, 5_000, 8_000, 12_000, 30_000] as const;
export const GATEWAY_INITIAL_READY_HEARTBEAT_GRACE_MS = 300_000;

export interface GatewayHeartbeatCallbacks {
  isActive(epoch: number): boolean;
  isSocketOpen(): boolean;
  isConnected(): boolean;
  isGatewayReady(): boolean;
  getConnectedAt(): number;
  getConsecutiveHeartbeatMisses(): number;
  ping(): void;
  probeReady(): Promise<void>;
  recordHeartbeatTimeout(nextMisses: number): void;
  requestRestart(): void;
  scheduleReconnect(reason: string): void;
}

export class GatewayHeartbeatScheduler {
  private heartbeatTimer: RuntimeScheduledTask | null = null;
  private heartbeatTimeoutTimer: RuntimeScheduledTask | null = null;
  private heartbeatTimeoutGeneration = 0;
  private gatewayReadyFallbackTimer: RuntimeScheduledTask | null = null;
  private initialReadyHeartbeatRecoveryTimer: RuntimeScheduledTask | null = null;
  private gatewayReadyFallbackAttempt = 0;

  constructor(
    private readonly callbacks: GatewayHeartbeatCallbacks,
    private readonly options: ReturnType<typeof getGatewayHeartbeatOptions>,
    private readonly scheduler: RuntimeSchedulerPort,
    private readonly clock: RuntimeClockPort,
  ) {}

  clearHeartbeatTimeout(): void {
    this.heartbeatTimeoutGeneration += 1;
    if (this.heartbeatTimeoutTimer) {
      this.heartbeatTimeoutTimer.cancel();
      this.heartbeatTimeoutTimer = null;
    }
  }

  clearHeartbeatTimers(): void {
    if (this.heartbeatTimer) {
      this.heartbeatTimer.cancel();
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatTimeout();
  }

  clearRecoveryTimers(): void {
    if (this.gatewayReadyFallbackTimer) {
      this.gatewayReadyFallbackTimer.cancel();
      this.gatewayReadyFallbackTimer = null;
    }
    this.gatewayReadyFallbackAttempt = 0;
    if (this.initialReadyHeartbeatRecoveryTimer) {
      this.initialReadyHeartbeatRecoveryTimer.cancel();
      this.initialReadyHeartbeatRecoveryTimer = null;
    }
  }

  private nextGatewayReadyFallbackDelayMs(): number {
    const index = Math.min(
      this.gatewayReadyFallbackAttempt,
      GATEWAY_READY_FALLBACK_PROBE_DELAYS_MS.length - 1,
    );
    const delayMs = GATEWAY_READY_FALLBACK_PROBE_DELAYS_MS[index]!;
    this.gatewayReadyFallbackAttempt += 1;
    return delayMs;
  }

  scheduleGatewayReadyFallback(expectedEpoch: number): void {
    if (this.gatewayReadyFallbackTimer) {
      this.gatewayReadyFallbackTimer.cancel();
    }
    if (
      !this.callbacks.isActive(expectedEpoch)
      || !this.callbacks.isConnected()
      || this.callbacks.isGatewayReady()
    ) {
      return;
    }
    this.gatewayReadyFallbackTimer = this.scheduler.schedule(this.nextGatewayReadyFallbackDelayMs(), () => {
      this.gatewayReadyFallbackTimer = null;
      if (
        !this.callbacks.isActive(expectedEpoch)
        || !this.callbacks.isConnected()
        || this.callbacks.isGatewayReady()
      ) {
        return;
      }
      void this.callbacks.probeReady().catch(() => {
        if (
          !this.callbacks.isActive(expectedEpoch)
          || !this.callbacks.isConnected()
          || this.callbacks.isGatewayReady()
        ) {
          return;
        }
        this.scheduleGatewayReadyFallback(expectedEpoch);
      });
    });
  }

  scheduleHeartbeat(expectedEpoch: number): void {
    this.clearHeartbeatTimers();
    const tick = () => {
      if (
        !this.callbacks.isActive(expectedEpoch)
        || !this.callbacks.isSocketOpen()
        || !this.callbacks.isConnected()
      ) {
        return;
      }
      const missesAtPing = this.callbacks.getConsecutiveHeartbeatMisses();
      this.callbacks.ping();
      const timeoutGeneration = this.heartbeatTimeoutGeneration;
      this.heartbeatTimeoutTimer = this.scheduler.schedule(this.options.timeoutMs, () => {
        if (timeoutGeneration !== this.heartbeatTimeoutGeneration) {
          return;
        }
        this.heartbeatTimeoutTimer = null;
        if (!this.callbacks.isActive(expectedEpoch) || !this.callbacks.isConnected()) {
          return;
        }
        const currentMisses = this.callbacks.getConsecutiveHeartbeatMisses();
        if (currentMisses < missesAtPing) {
          return;
        }
        const nextMisses = currentMisses + 1;
        this.callbacks.recordHeartbeatTimeout(nextMisses);
        if (nextMisses >= this.options.maxMisses) {
          const withinInitialReadyGrace = !this.callbacks.isGatewayReady()
            && this.callbacks.getConnectedAt() > 0
            && (this.clock.nowMs() - this.callbacks.getConnectedAt()) < GATEWAY_INITIAL_READY_HEARTBEAT_GRACE_MS;
          if (withinInitialReadyGrace) {
            if (!this.initialReadyHeartbeatRecoveryTimer) {
              this.initialReadyHeartbeatRecoveryTimer = this.scheduler.schedule(Math.max(0, GATEWAY_INITIAL_READY_HEARTBEAT_GRACE_MS - (this.clock.nowMs() - this.callbacks.getConnectedAt())), () => {
                this.initialReadyHeartbeatRecoveryTimer = null;
                this.callbacks.requestRestart();
              });
            }
            this.scheduleHeartbeat(expectedEpoch);
            return;
          }
          this.callbacks.requestRestart();
          this.callbacks.scheduleReconnect('heartbeat-timeout');
          return;
        }
        this.scheduleHeartbeat(expectedEpoch);
      });
      this.heartbeatTimer = this.scheduler.schedule(this.options.intervalMs, tick);
    };

    this.heartbeatTimer = this.scheduler.schedule(this.options.intervalMs, tick);
    this.scheduleGatewayReadyFallback(expectedEpoch);
  }
}
