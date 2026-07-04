import { DEFAULT_GATEWAY_RPC_TIMEOUT_MS } from '../shared/runtime-host-constants';
import { ensureError } from './client-errors';
import type { GatewayPendingRpcRequests } from './client-pending-rpc';
import { createGatewayTransportIssue } from './client-state';
import type { GatewayTransportIssue } from '../shared/gateway-error';
import type { RuntimeClockPort, RuntimeIdGeneratorPort } from '../application/common/runtime-ports';
import type { RuntimeHostLogger } from '../shared/logger';

export const GATEWAY_RPC_CONCURRENCY_LIMIT = 16;
export const GATEWAY_RPC_QUEUE_LIMIT = 64;

export interface GatewayRpcSenderDeps {
  ensureConnected(timeoutMs: number): Promise<void>;
  isSocketOpen(): boolean;
  sendRaw(payload: string): void;
  pendingRpcRequests: Pick<GatewayPendingRpcRequests, 'register' | 'delete' | 'size'>;
  idGenerator: RuntimeIdGeneratorPort;
  clock: RuntimeClockPort;
  logger?: RuntimeHostLogger;
  recordRpcFailure(method: string, issue?: GatewayTransportIssue): void;
}

interface QueuedGatewayRpcCall {
  resolve(): void;
}

export class GatewayRpcSender {
  private activeCallCount = 0;
  private readonly queuedCalls: QueuedGatewayRpcCall[] = [];
  private queuedCallHead = 0;

  constructor(private readonly deps: GatewayRpcSenderDeps) {}

  private acquireCallSlot(method: string): Promise<void> | null {
    if (this.activeCallCount < GATEWAY_RPC_CONCURRENCY_LIMIT) {
      this.activeCallCount += 1;
      return null;
    }
    if (this.queuedCallCount() >= GATEWAY_RPC_QUEUE_LIMIT) {
      throw new Error(`Gateway RPC queue full: ${method}`);
    }
    return new Promise<void>((resolve) => {
      this.queuedCalls.push({ resolve });
    });
  }

  private queuedCallCount(): number {
    return this.queuedCalls.length - this.queuedCallHead;
  }

  private rpcTelemetry() {
    return {
      activeCallCount: this.activeCallCount,
      queuedCallCount: this.queuedCallCount(),
      pendingRpcCount: this.deps.pendingRpcRequests.size(),
    };
  }

  private releaseCallSlot(): void {
    const next = this.queuedCalls[this.queuedCallHead];
    if (next) {
      this.queuedCallHead += 1;
      next.resolve();
      if (this.queuedCallHead > 32 && this.queuedCallHead * 2 >= this.queuedCalls.length) {
        this.queuedCalls.splice(0, this.queuedCallHead);
        this.queuedCallHead = 0;
      }
      return;
    }
    this.queuedCalls.length = 0;
    this.queuedCallHead = 0;
    this.activeCallCount = Math.max(0, this.activeCallCount - 1);
  }

  call(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_GATEWAY_RPC_TIMEOUT_MS,
  ): Promise<unknown> {
    let queued: Promise<void> | null;
    try {
      queued = this.acquireCallSlot(method);
    } catch (error) {
      return Promise.reject(error);
    }
    const run = async () => {
      try {
        return await this.callWithSlot(method, params, timeoutMs);
      } finally {
        this.releaseCallSlot();
      }
    };
    return queued ? queued.then(run) : run();
  }

  private async callWithSlot(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const startedAt = this.deps.clock.nowMs();
    this.deps.logger?.traceDebug?.(3, '[gateway-rpc] start', {
      method,
      timeoutMs,
      ...this.rpcTelemetry(),
    });
    await this.deps.ensureConnected(Math.max(2000, timeoutMs));
    const connectedAt = this.deps.clock.nowMs();
    this.deps.logger?.traceDebug?.(3, '[gateway-rpc] connected', {
      method,
      connectElapsedMs: connectedAt - startedAt,
      timeoutMs,
    });
    if (!this.deps.isSocketOpen()) {
      this.deps.logger?.warn('[gateway-rpc] socket-unavailable', {
        method,
        elapsedMs: this.deps.clock.nowMs() - startedAt,
      });
      throw new Error('Gateway socket unavailable');
    }

    const requestId = `req-${this.deps.idGenerator.randomId()}`;
    this.deps.logger?.traceDebug?.(3, '[gateway-rpc] register', {
      requestId,
      method,
      timeoutMs,
      ...this.rpcTelemetry(),
    });
    const rpcPromise = this.deps.pendingRpcRequests.register({
      requestId,
      method,
      timeoutMs,
      nowMs: this.deps.clock.nowMs(),
      onTimeout: (_pending, timeoutError) => {
        this.deps.logger?.warn('[gateway-rpc] timeout', {
          requestId,
          method,
          timeoutMs,
          elapsedMs: this.deps.clock.nowMs() - startedAt,
        });
        this.deps.recordRpcFailure(method, createGatewayTransportIssue({
          message: timeoutError.message,
          source: 'rpc',
          clock: this.deps.clock,
        }));
      },
    });

    try {
      this.deps.sendRaw(JSON.stringify({
        type: 'req',
        id: requestId,
        method,
        params: params || {},
      }));
      this.deps.logger?.traceDebug?.(3, '[gateway-rpc] sent', {
        requestId,
        method,
        elapsedMs: this.deps.clock.nowMs() - startedAt,
        ...this.rpcTelemetry(),
      });
    } catch (error) {
      this.deps.pendingRpcRequests.delete(requestId);
      const sendError = ensureError(error, `Failed to send gateway RPC: ${method}`);
      this.deps.logger?.warn('[gateway-rpc] send-error', {
        requestId,
        method,
        message: sendError.message,
        elapsedMs: this.deps.clock.nowMs() - startedAt,
      });
      this.deps.recordRpcFailure(method, createGatewayTransportIssue({
        message: sendError.message,
        source: 'rpc',
        clock: this.deps.clock,
      }));
      throw sendError;
    }

    try {
      const result = await rpcPromise;
      this.deps.logger?.traceDebug?.(3, '[gateway-rpc] success', {
        requestId,
        method,
        elapsedMs: this.deps.clock.nowMs() - startedAt,
        ...this.rpcTelemetry(),
      });
      return result;
    } catch (error) {
      this.deps.logger?.warn('[gateway-rpc] failed', {
        requestId,
        method,
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: this.deps.clock.nowMs() - startedAt,
        ...this.rpcTelemetry(),
      });
      throw error;
    }
  }
}
