import { DEFAULT_GATEWAY_RPC_TIMEOUT_MS } from '../shared/runtime-host-constants';
import { ensureError } from './client-errors';
import type { GatewayPendingRpcRequests } from './client-pending-rpc';
import { createGatewayTransportIssue } from './client-state';
import type { GatewayTransportIssue } from '../shared/gateway-error';
import type { RuntimeClockPort, RuntimeIdGeneratorPort } from '../application/common/runtime-ports';
import type { RuntimeHostLogger } from '../shared/logger';

export interface GatewayRpcSenderDeps {
  ensureConnected(timeoutMs: number): Promise<void>;
  isSocketOpen(): boolean;
  sendRaw(payload: string): void;
  pendingRpcRequests: GatewayPendingRpcRequests;
  idGenerator: RuntimeIdGeneratorPort;
  clock: RuntimeClockPort;
  logger?: RuntimeHostLogger;
  recordRpcFailure(method: string, issue?: GatewayTransportIssue): void;
}

export class GatewayRpcSender {
  constructor(private readonly deps: GatewayRpcSenderDeps) {}

  async call(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_GATEWAY_RPC_TIMEOUT_MS,
  ): Promise<unknown> {
    const startedAt = this.deps.clock.nowMs();
    this.deps.logger?.traceDebug?.(3, '[gateway-rpc] start', {
      method,
      timeoutMs,
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
    const rpcPromise = this.deps.pendingRpcRequests.register({
      requestId,
      method,
      timeoutMs,
      onTimeout: (pending) => {
        const timeoutError = new Error(`Gateway RPC timeout: ${method}`);
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
        pending.reject(timeoutError);
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
      });
      return result;
    } catch (error) {
      this.deps.logger?.warn('[gateway-rpc] failed', {
        requestId,
        method,
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: this.deps.clock.nowMs() - startedAt,
      });
      throw error;
    }
  }
}
