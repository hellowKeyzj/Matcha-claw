import type { RuntimeScheduledTask, RuntimeSchedulerPort } from '../application/common/runtime-ports';

export interface PendingGatewayRpcRequest {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  clearTimer(): void;
}

interface RegisterPendingGatewayRpcRequestInput {
  requestId: string;
  method: string;
  timeoutMs: number;
  onTimeout: (pending: PendingGatewayRpcRequest) => void;
}

export class GatewayPendingRpcRequests {
  private readonly pendingRequests = new Map<string, PendingGatewayRpcRequest>();

  constructor(private readonly scheduler: RuntimeSchedulerPort) {}

  register(input: RegisterPendingGatewayRpcRequestInput): Promise<unknown> {
    return new Promise((resolveRpc, rejectRpc) => {
      const scheduledTask: RuntimeScheduledTask = this.scheduler.schedule(Math.max(1000, input.timeoutMs), () => {
        const pending = this.pendingRequests.get(input.requestId);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(input.requestId);
        input.onTimeout(pending);
      });

      this.pendingRequests.set(input.requestId, {
        method: input.method,
        resolve: (value) => resolveRpc(value),
        reject: (error) => rejectRpc(error),
        clearTimer: () => scheduledTask.cancel(),
      });
    });
  }

  take(requestId: string): PendingGatewayRpcRequest | null {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return null;
    }
    pending.clearTimer();
    this.pendingRequests.delete(requestId);
    return pending;
  }

  delete(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      pending.clearTimer();
      this.pendingRequests.delete(requestId);
    }
  }

  rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      pending.clearTimer();
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }
}
