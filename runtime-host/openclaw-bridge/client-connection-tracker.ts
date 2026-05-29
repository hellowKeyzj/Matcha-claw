import {
  buildGatewayHealthSummary,
  buildInitialDiagnostics,
  sameDiagnosticsSnapshot,
  type GatewayConnectionStatePayload,
  type GatewayDiagnosticsSnapshot,
} from './client-state';
import type { RuntimeClockPort } from '../application/common/runtime-ports';

export class GatewayConnectionTracker {
  private currentDiagnostics: GatewayDiagnosticsSnapshot = buildInitialDiagnostics();
  private currentSnapshot: GatewayConnectionStatePayload;

  constructor(
    private readonly clock: RuntimeClockPort,
    private readonly onChange?: (payload: GatewayConnectionStatePayload) => void,
  ) {
    this.currentSnapshot = {
      state: 'disconnected',
      portReachable: false,
      gatewayReady: false,
      healthSummary: 'unresponsive',
      transportEpoch: 0,
      diagnostics: this.currentDiagnostics,
      updatedAt: this.clock.nowMs(),
    };
  }

  get diagnostics(): GatewayDiagnosticsSnapshot {
    return this.currentDiagnostics;
  }

  get snapshot(): GatewayConnectionStatePayload {
    return this.currentSnapshot;
  }

  emitInitial(): void {
    this.onChange?.(this.currentSnapshot);
  }

  updateDiagnostics(
    patch: Partial<GatewayDiagnosticsSnapshot>,
  ): GatewayDiagnosticsSnapshot {
    this.currentDiagnostics = {
      ...this.currentDiagnostics,
      ...patch,
    };
    return this.currentDiagnostics;
  }

  updateSnapshot(
    patch: Partial<Omit<GatewayConnectionStatePayload, 'updatedAt'>>,
  ): GatewayConnectionStatePayload {
    const shouldClearIssue = patch.lastIssue === undefined && patch.lastError === '';
    const nextSnapshot: GatewayConnectionStatePayload = {
      state: patch.state ?? this.currentSnapshot.state,
      portReachable: patch.portReachable ?? this.currentSnapshot.portReachable,
      gatewayReady: patch.gatewayReady ?? this.currentSnapshot.gatewayReady,
      transportEpoch: patch.transportEpoch ?? this.currentSnapshot.transportEpoch,
      diagnostics: patch.diagnostics ?? this.currentSnapshot.diagnostics,
      healthSummary: buildGatewayHealthSummary({
        state: patch.state ?? this.currentSnapshot.state,
        portReachable: patch.portReachable ?? this.currentSnapshot.portReachable,
        gatewayReady: patch.gatewayReady ?? this.currentSnapshot.gatewayReady,
        diagnostics: patch.diagnostics ?? this.currentSnapshot.diagnostics,
      }),
      ...(patch.lastError !== undefined
        ? (patch.lastError ? { lastError: patch.lastError } : {})
        : (this.currentSnapshot.lastError ? { lastError: this.currentSnapshot.lastError } : {})),
      ...(patch.lastIssue !== undefined
        ? (patch.lastIssue ? { lastIssue: patch.lastIssue } : {})
        : (!shouldClearIssue && this.currentSnapshot.lastIssue ? { lastIssue: this.currentSnapshot.lastIssue } : {})),
      updatedAt: this.clock.nowMs(),
    };
    const unchanged = this.currentSnapshot.state === nextSnapshot.state
      && this.currentSnapshot.portReachable === nextSnapshot.portReachable
      && this.currentSnapshot.gatewayReady === nextSnapshot.gatewayReady
      && this.currentSnapshot.transportEpoch === nextSnapshot.transportEpoch
      && this.currentSnapshot.healthSummary === nextSnapshot.healthSummary
      && this.currentSnapshot.lastError === nextSnapshot.lastError
      && this.currentSnapshot.lastIssue?.message === nextSnapshot.lastIssue?.message
      && this.currentSnapshot.lastIssue?.source === nextSnapshot.lastIssue?.source
      && this.currentSnapshot.lastIssue?.code === nextSnapshot.lastIssue?.code
      && this.currentSnapshot.lastIssue?.retryable === nextSnapshot.lastIssue?.retryable
      && this.currentSnapshot.lastIssue?.retryAfterMs === nextSnapshot.lastIssue?.retryAfterMs
      && sameDiagnosticsSnapshot(this.currentSnapshot.diagnostics, nextSnapshot.diagnostics);
    if (unchanged) {
      return this.currentSnapshot;
    }
    this.currentSnapshot = nextSnapshot;
    this.onChange?.(this.currentSnapshot);
    return this.currentSnapshot;
  }
}
