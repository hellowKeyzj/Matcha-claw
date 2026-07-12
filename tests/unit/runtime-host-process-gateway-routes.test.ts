import { describe, expect, it, vi } from 'vitest';
import { gatewayRoutes } from '../../runtime-host/api/routes/gateway-routes';
import { GatewayService } from '../../runtime-host/application/gateway/service';
import { GatewayReadinessWorkflow } from '../../runtime-host/application/workflows/gateway-readiness/gateway-readiness-workflow';
import { createAgentRunCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/agent-run-capability';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

function createDeps(options: {
  readonly recoverGatewayConnection?: (reason: string, timeoutMs?: number) => Promise<unknown>;
} = {}) {
  const openclawBridge = {
    gatewayRpc: vi.fn(async () => ({ ok: true })),
    inspectGatewayControlReadiness: vi.fn(async (methods: readonly string[]) => ({
      ready: true,
      phase: 'ready' as const,
      requiredMethods: methods,
      missingMethods: [],
      retryable: false,
    })),
    readGatewayConnectionState: vi.fn(async () => ({
      state: 'connected',
      portReachable: true,
      gatewayReady: true,
      healthSummary: 'healthy',
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1,
    })),
    recoverGatewayConnection: vi.fn(options.recoverGatewayConnection ?? (async () => ({
      state: 'connected',
      portReachable: true,
      gatewayReady: true,
      healthSummary: 'healthy',
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 2,
    }))),
    chatSend: vi.fn(async () => ({ id: 'msg-1' })),
  };
  return {
    openclawBridge,
    gatewayService: new GatewayService({
      readinessWorkflow: new GatewayReadinessWorkflow({ gateway: openclawBridge }),
    }),
  };
}

describe('runtime-host process gateway routes', () => {
  it('POST /api/gateway/rpc 不再作为通用 Gateway 后门处理', async () => {
    const deps = createDeps();

    const result = await dispatchRuntimeRouteDefinition(
      gatewayRoutes,
      'POST',
      '/api/gateway/rpc',
      {
        method: 'chat.history',
        params: { sessionKey: 'agent:main:main' },
        timeoutMs: 9000,
      },
      deps,
    );

    expect(deps.openclawBridge.gatewayRpc).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('POST /api/gateway/ready 不再作为 direct control route 暴露', async () => {
    const deps = createDeps();

    const result = await dispatchRuntimeRouteDefinition(
      gatewayRoutes,
      'POST',
      '/api/gateway/ready',
      { timeoutMs: 8000 },
      deps,
    );

    expect(deps.openclawBridge.inspectGatewayControlReadiness).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 400,
      data: { success: false },
    });
  });

  it.each([
    '/api/gateway/agent-wait',
    '/api/chat/send-with-media',
  ])('POST %s 不再作为 direct route 暴露', async (path) => {
    const deps = createDeps();

    const result = await dispatchRuntimeRouteDefinition(
      gatewayRoutes,
      'POST',
      path,
      { method: 'agent.wait', params: { runId: 'run-1', timeoutMs: 30000 } },
      deps,
    );

    expect(deps.openclawBridge.gatewayRpc).not.toHaveBeenCalled();
    expect(deps.openclawBridge.chatSend).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('agent.run capability operation 等待 agent.wait', async () => {
    const deps = createDeps();
    const [route] = createAgentRunCapabilityOperationRoutes({ gateway: deps.openclawBridge });

    const result = await route!.handle({
      domainInput: {
        runId: 'run-1',
        waitSliceMs: 30000,
        rpcTimeoutBufferMs: 10000,
      },
    });

    expect(deps.openclawBridge.gatewayRpc).toHaveBeenCalledWith(
      'agent.wait',
      { runId: 'run-1', timeoutMs: 30000 },
      40000,
    );
    expect(result).toEqual({
      status: 200,
      data: { ok: true },
    });
  });

  it('GET /api/gateway/status 返回 transport 真相快照', async () => {
    const deps = createDeps();

    const result = await dispatchRuntimeRouteDefinition(
      gatewayRoutes,
      'GET',
      '/api/gateway/status',
      undefined,
      deps,
    );

    expect(deps.openclawBridge.readGatewayConnectionState).toHaveBeenCalledTimes(1);
    expect(deps.openclawBridge.recoverGatewayConnection).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        status: {
          state: 'connected',
          portReachable: true,
          gatewayReady: true,
          healthSummary: 'healthy',
          diagnostics: {
            consecutiveHeartbeatMisses: 0,
            consecutiveRpcFailures: 0,
          },
          updatedAt: 1,
        },
      },
    });
  });

  it('POST /api/gateway/recover 显式重建 transport 控制通道', async () => {
    const deps = createDeps();

    const result = await dispatchRuntimeRouteDefinition(
      gatewayRoutes,
      'POST',
      '/api/gateway/recover',
      { reason: 'gateway-restart', timeoutMs: 15000 },
      deps,
    );

    expect(deps.openclawBridge.recoverGatewayConnection).toHaveBeenCalledWith('gateway-restart', 15000);
    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        status: {
          state: 'connected',
          portReachable: true,
          gatewayReady: true,
          healthSummary: 'healthy',
          diagnostics: {
            consecutiveHeartbeatMisses: 0,
            consecutiveRpcFailures: 0,
          },
          updatedAt: 2,
        },
      },
    });
  });

  it('POST /api/gateway/recover 将恢复失败映射为 route server error', async () => {
    const deps = createDeps({
      recoverGatewayConnection: async () => {
        throw new Error('Gateway recovery failed');
      },
    });

    const result = await dispatchRuntimeRouteDefinition(
      gatewayRoutes,
      'POST',
      '/api/gateway/recover',
      { reason: 'manual-retry', timeoutMs: 12000 },
      deps,
    );

    expect(deps.openclawBridge.recoverGatewayConnection).toHaveBeenCalledWith('manual-retry', 12000);
    expect(result).toEqual({
      status: 500,
      data: {
        success: false,
        error: 'Error: Gateway recovery failed',
      },
    });
  });

  it('POST /api/gateway/recover 将恢复 timeout 映射为 route server error', async () => {
    const deps = createDeps({
      recoverGatewayConnection: async () => {
        throw new Error('Gateway connect timeout');
      },
    });

    const result = await dispatchRuntimeRouteDefinition(
      gatewayRoutes,
      'POST',
      '/api/gateway/recover',
      { reason: 'gateway-timeout', timeoutMs: 5000 },
      deps,
    );

    expect(deps.openclawBridge.recoverGatewayConnection).toHaveBeenCalledWith('gateway-timeout', 5000);
    expect(result).toEqual({
      status: 500,
      data: {
        success: false,
        error: 'Error: Gateway connect timeout',
      },
    });
  });
});
