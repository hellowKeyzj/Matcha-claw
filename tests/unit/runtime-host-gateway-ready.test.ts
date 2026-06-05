import { describe, expect, it, vi } from 'vitest';
import { GatewayService } from '../../runtime-host/application/gateway/service';
import { DEFAULT_GATEWAY_BASE_METHODS } from '../../runtime-host/application/gateway/gateway-runtime-port';
import { GatewayReadinessWorkflow } from '../../runtime-host/application/workflows/gateway-readiness/gateway-readiness-workflow';

describe('runtime-host gateway ready service', () => {
  function createFileSystem() {
    return {} as ConstructorParameters<typeof GatewayService>[0]['fileSystem'];
  }

  it('checks explicit required methods against gateway capabilities', async () => {
    const gateway = {
      gatewayRpc: vi.fn(),
      inspectGatewayControlReadiness: vi.fn(async (methods: readonly string[]) => ({
        ready: false,
        phase: 'unavailable' as const,
        requiredMethods: methods,
        missingMethods: ['TaskList'],
        retryable: false,
        code: 'GATEWAY_METHODS_UNAVAILABLE',
      })),
      readGatewayConnectionState: vi.fn(),
      chatSend: vi.fn(),
    };
    const service = new GatewayService({ readinessWorkflow: new GatewayReadinessWorkflow({ gateway }) });

    await expect(service.ready({
      timeoutMs: 3000,
      requiredMethods: ['TaskList'],
    })).resolves.toEqual({
      status: 200,
      data: {
        success: false,
        phase: 'unavailable',
        retryable: false,
        requiredMethods: ['TaskList'],
        code: 'GATEWAY_METHODS_UNAVAILABLE',
        missingMethods: ['TaskList'],
      },
    });
    expect(gateway.inspectGatewayControlReadiness).toHaveBeenCalledWith(['TaskList'], 3000);
  });

  it('uses base gateway readiness when no required methods are provided', async () => {
    const gateway = {
      gatewayRpc: vi.fn(),
      inspectGatewayControlReadiness: vi.fn(async (methods: readonly string[]) => ({
        ready: true,
        phase: 'ready' as const,
        requiredMethods: methods,
        missingMethods: [],
        retryable: false,
      })),
      readGatewayConnectionState: vi.fn(),
      chatSend: vi.fn(),
    };
    const service = new GatewayService({ readinessWorkflow: new GatewayReadinessWorkflow({ gateway }) });

    await expect(service.ready({ timeoutMs: 3000 })).resolves.toMatchObject({
      status: 200,
      data: {
        success: true,
        phase: 'ready',
        retryable: false,
      },
    });
    expect(gateway.inspectGatewayControlReadiness).toHaveBeenCalledWith(DEFAULT_GATEWAY_BASE_METHODS, 3000);
  });

  it('returns retryable starting readiness from OpenClaw V4 unavailable response', async () => {
    const gateway = {
      gatewayRpc: vi.fn(),
      inspectGatewayControlReadiness: vi.fn(async (methods: readonly string[]) => ({
        ready: false,
        phase: 'starting' as const,
        requiredMethods: methods,
        missingMethods: [],
        retryable: true,
        code: 'UNAVAILABLE',
        error: 'Gateway connect failed: gateway starting; retry shortly',
        retryAfterMs: 750,
        details: { reason: 'startup-sidecars-pending' },
      })),
      readGatewayConnectionState: vi.fn(),
      chatSend: vi.fn(),
    };
    const service = new GatewayService({ readinessWorkflow: new GatewayReadinessWorkflow({ gateway }) });

    await expect(service.ready({ timeoutMs: 3000 })).resolves.toEqual({
      status: 200,
      data: {
        success: false,
        phase: 'starting',
        retryable: true,
        requiredMethods: DEFAULT_GATEWAY_BASE_METHODS,
        missingMethods: [],
        code: 'UNAVAILABLE',
        error: 'Gateway connect failed: gateway starting; retry shortly',
        retryAfterMs: 750,
        details: { reason: 'startup-sidecars-pending' },
      },
    });
  });

  it('auto-approves only OpenClaw Control UI browser pairing requests', async () => {
    const gateway = {
      gatewayRpc: vi.fn(async (method: string) => {
        if (method === 'device.pair.list') {
          return {
            pending: [
              { requestId: 'control-1', clientId: 'openclaw-control-ui' },
              { requestId: 'other-1', clientId: 'external-device' },
              { requestId: '', clientId: 'openclaw-control-ui' },
            ],
          };
        }
        return { ok: true };
      }),
      inspectGatewayControlReadiness: vi.fn(),
      readGatewayConnectionState: vi.fn(),
      chatSend: vi.fn(),
    };
    const service = new GatewayService({ readinessWorkflow: new GatewayReadinessWorkflow({ gateway }) });

    await expect(service.approvePendingControlUiPairingRequests()).resolves.toEqual({
      status: 200,
      data: {
        success: true,
        approvedRequestIds: ['control-1'],
      },
    });
    expect(gateway.gatewayRpc).toHaveBeenCalledWith('device.pair.list', {}, 10000);
    expect(gateway.gatewayRpc).toHaveBeenCalledWith('device.pair.approve', { requestId: 'control-1' }, 15000);
    expect(gateway.gatewayRpc).not.toHaveBeenCalledWith('device.pair.approve', { requestId: 'other-1' }, 15000);
  });
});
