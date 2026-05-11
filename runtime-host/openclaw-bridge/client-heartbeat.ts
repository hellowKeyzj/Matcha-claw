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

export const GATEWAY_READY_FALLBACK_MS = 30_000;
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
  private gatewayReadyFallbackTimer: RuntimeScheduledTask | null = null;
  private initialReadyHeartbeatRecoveryTimer: RuntimeScheduledTask | null = null;

  constructor(
    private readonly callbacks: GatewayHeartbeatCallbacks,
    private readonly options: ReturnType<typeof getGatewayHeartbeatOptions>,
    private readonly scheduler: RuntimeSchedulerPort,
    private readonly clock: RuntimeClockPort,
  ) {}

  clearHeartbeatTimers(): void {
    if (this.heartbeatTimer) {
      this.heartbeatTimer.cancel();
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      this.heartbeatTimeoutTimer.cancel();
      this.heartbeatTimeoutTimer = null;
    }
  }

  clearRecoveryTimers(): void {
    if (this.gatewayReadyFallbackTimer) {
      this.gatewayReadyFallbackTimer.cancel();
      this.gatewayReadyFallbackTimer = null;
    }
    if (this.initialReadyHeartbeatRecoveryTimer) {
      this.initialReadyHeartbeatRecoveryTimer.cancel();
      this.initialReadyHeartbeatRecoveryTimer = null;
    }
  }

  scheduleGatewayReadyFallback(expectedEpoch: number): void {
    if (this.gatewayReadyFallbackTimer) {
      this.gatewayReadyFallbackTimer.cancel();
    }
    this.gatewayReadyFallbackTimer = this.scheduler.schedule(GATEWAY_READY_FALLBACK_MS, () => {
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
      this.callbacks.ping();
      this.heartbeatTimeoutTimer = this.scheduler.schedule(this.options.timeoutMs, () => {
        this.heartbeatTimeoutTimer = null;
        if (!this.callbacks.isActive(expectedEpoch) || !this.callbacks.isConnected()) {
          return;
        }
        const nextMisses = this.callbacks.getConsecutiveHeartbeatMisses() + 1;
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
