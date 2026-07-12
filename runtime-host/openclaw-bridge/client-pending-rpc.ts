import type { RuntimeScheduledTask, RuntimeSchedulerPort } from '../application/common/runtime-ports';
import type { GatewayTransportIssue } from '../shared/gateway-error';

export type GatewayRpcTelemetryPolicy = 'normal' | 'readiness-probe';

export interface PendingGatewayRpcRequest {
  readonly method: string;
  readonly timeoutAtMs: number;
  readonly telemetryPolicy: GatewayRpcTelemetryPolicy;
  readonly onFailure?: (issue: GatewayTransportIssue) => void;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface RegisterPendingGatewayRpcRequestInput {
  requestId: string;
  method: string;
  timeoutMs: number;
  nowMs: number;
  telemetryPolicy?: GatewayRpcTelemetryPolicy;
  onFailure?: (issue: GatewayTransportIssue) => void;
  onTimeout: (pending: PendingGatewayRpcRequest, error: Error) => void;
}

export const GATEWAY_PENDING_RPC_LIMIT = 128;
const GATEWAY_RPC_TIMEOUT_BUCKET_MS = 1_000;

export class GatewayPendingRpcRequests {
  private readonly pendingRequests = new Map<string, PendingGatewayRpcRequest>();
  private readonly timeoutBuckets = new Map<number, RuntimeScheduledTask>();

  constructor(private readonly scheduler: RuntimeSchedulerPort) {}

  size(): number {
    return this.pendingRequests.size;
  }

  register(input: RegisterPendingGatewayRpcRequestInput): Promise<unknown> {
    if (this.pendingRequests.size >= GATEWAY_PENDING_RPC_LIMIT) {
      return Promise.reject(new Error(`Gateway pending RPC limit exceeded: ${input.method}`));
    }
    const timeoutAtMs = input.nowMs + Math.max(1000, input.timeoutMs);
    const bucketKey = this.timeoutBucketKey(timeoutAtMs);
    return new Promise((resolveRpc, rejectRpc) => {
      this.pendingRequests.set(input.requestId, {
        method: input.method,
        timeoutAtMs,
        telemetryPolicy: input.telemetryPolicy ?? 'normal',
        ...(input.onFailure ? { onFailure: input.onFailure } : {}),
        resolve: (value) => resolveRpc(value),
        reject: (error) => rejectRpc(error),
      });
      this.ensureTimeoutBucket(bucketKey, input.nowMs, input.onTimeout);
    });
  }

  take(requestId: string): PendingGatewayRpcRequest | null {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return null;
    }
    this.pendingRequests.delete(requestId);
    this.clearEmptyTimeoutBuckets();
    return pending;
  }

  delete(requestId: string): void {
    if (this.pendingRequests.delete(requestId)) {
      this.clearEmptyTimeoutBuckets();
    }
  }

  rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
    this.clearTimeoutBuckets();
  }

  private timeoutBucketKey(timeoutAtMs: number): number {
    return Math.ceil(timeoutAtMs / GATEWAY_RPC_TIMEOUT_BUCKET_MS) * GATEWAY_RPC_TIMEOUT_BUCKET_MS;
  }

  private ensureTimeoutBucket(
    bucketKey: number,
    nowMs: number,
    onTimeout: RegisterPendingGatewayRpcRequestInput['onTimeout'],
  ): void {
    if (this.timeoutBuckets.has(bucketKey)) {
      return;
    }
    const delayMs = Math.max(1, bucketKey - nowMs);
    const scheduledTask = this.scheduler.schedule(delayMs, () => {
      this.timeoutBuckets.delete(bucketKey);
      for (const [requestId, pending] of this.pendingRequests.entries()) {
        if (this.timeoutBucketKey(pending.timeoutAtMs) !== bucketKey) {
          continue;
        }
        this.pendingRequests.delete(requestId);
        const timeoutError = new Error(`Gateway RPC timeout: ${pending.method}`);
        pending.reject(timeoutError);
        onTimeout(pending, timeoutError);
      }
    });
    this.timeoutBuckets.set(bucketKey, scheduledTask);
  }

  private clearEmptyTimeoutBuckets(): void {
    const activeBucketKeys = new Set<number>();
    for (const pending of this.pendingRequests.values()) {
      activeBucketKeys.add(this.timeoutBucketKey(pending.timeoutAtMs));
    }
    for (const [bucketKey, scheduledTask] of this.timeoutBuckets.entries()) {
      if (!activeBucketKeys.has(bucketKey)) {
        scheduledTask.cancel();
        this.timeoutBuckets.delete(bucketKey);
      }
    }
  }

  private clearTimeoutBuckets(): void {
    for (const scheduledTask of this.timeoutBuckets.values()) {
      scheduledTask.cancel();
    }
    this.timeoutBuckets.clear();
  }
}
