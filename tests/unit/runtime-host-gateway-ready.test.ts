import { describe, expect, it, vi } from 'vitest';
import { GatewayService } from '../../runtime-host/application/gateway/service';
import { DEFAULT_GATEWAY_BASE_METHODS } from '../../runtime-host/application/gateway/gateway-runtime-port';
import { GatewayReadinessWorkflow } from '../../runtime-host/application/workflows/gateway-readiness/gateway-readiness-workflow';

describe('runtime-host gateway ready service', () => {
  function createFileSystem() {
    return {} as ConstructorParameters<typeof GatewayService>[0]['fileSystem'];
  }

  it('forwards explicit named readiness windows to gateway capability checks', async () => {
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
      recoverGatewayConnection: vi.fn(),
      chatSend: vi.fn(),
    };
    const service = new GatewayService({ readinessWorkflow: new GatewayReadinessWorkflow({ gateway }) });

    await expect(service.ready({
      handshakeTimeoutMs: 3_000,
      livenessProbeTimeoutMs: 1_200,
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
    expect(gateway.inspectGatewayControlReadiness).toHaveBeenCalledWith(['TaskList'], {
      handshakeTimeoutMs: 3_000,
      livenessProbeTimeoutMs: 1_200,
    });
  });

  it('passes undefined when no named readiness windows are provided', async () => {
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
      recoverGatewayConnection: vi.fn(),
      chatSend: vi.fn(),
    };
    const service = new GatewayService({ readinessWorkflow: new GatewayReadinessWorkflow({ gateway }) });

    await expect(service.ready({})).resolves.toMatchObject({
      status: 200,
      data: {
        success: true,
        phase: 'ready',
        retryable: false,
      },
    });
    expect(gateway.inspectGatewayControlReadiness).toHaveBeenCalledWith(
      DEFAULT_GATEWAY_BASE_METHODS,
      undefined,
    );
  });

  it('ignores the legacy timeoutMs field', async () => {
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
      recoverGatewayConnection: vi.fn(),
      chatSend: vi.fn(),
    };
    const service = new GatewayService({ readinessWorkflow: new GatewayReadinessWorkflow({ gateway }) });

    await service.ready({ timeoutMs: 3_000 });

    expect(gateway.inspectGatewayControlReadiness).toHaveBeenCalledWith(
      DEFAULT_GATEWAY_BASE_METHODS,
      undefined,
    );
  });

  it('drops invalid named readiness windows while retaining valid fields', async () => {
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
      recoverGatewayConnection: vi.fn(),
      chatSend: vi.fn(),
    };
    const service = new GatewayService({ readinessWorkflow: new GatewayReadinessWorkflow({ gateway }) });

    await service.ready({ handshakeTimeoutMs: 0, livenessProbeTimeoutMs: -1 });
    await service.ready({ handshakeTimeoutMs: Number.NaN, livenessProbeTimeoutMs: '1_200' });
    await service.ready({ handshakeTimeoutMs: Infinity, livenessProbeTimeoutMs: null });
    await service.ready({ handshakeTimeoutMs: 1_500, livenessProbeTimeoutMs: 'invalid' });

    expect(gateway.inspectGatewayControlReadiness).toHaveBeenNthCalledWith(
      1,
      DEFAULT_GATEWAY_BASE_METHODS,
      undefined,
    );
    expect(gateway.inspectGatewayControlReadiness).toHaveBeenNthCalledWith(
      2,
      DEFAULT_GATEWAY_BASE_METHODS,
      undefined,
    );
    expect(gateway.inspectGatewayControlReadiness).toHaveBeenNthCalledWith(
      3,
      DEFAULT_GATEWAY_BASE_METHODS,
      undefined,
    );
    expect(gateway.inspectGatewayControlReadiness).toHaveBeenNthCalledWith(
      4,
      DEFAULT_GATEWAY_BASE_METHODS,
      { handshakeTimeoutMs: 1_500 },
    );
  });

  it('returns structured retryable starting readiness from OpenClaw V4 unavailable response', async () => {
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
      recoverGatewayConnection: vi.fn(),
      chatSend: vi.fn(),
    };
    const service = new GatewayService({ readinessWorkflow: new GatewayReadinessWorkflow({ gateway }) });

    await expect(service.ready({ handshakeTimeoutMs: 3_000 })).resolves.toEqual({
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
    expect(gateway.inspectGatewayControlReadiness).toHaveBeenCalledWith(
      DEFAULT_GATEWAY_BASE_METHODS,
      { handshakeTimeoutMs: 3_000 },
    );
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
      recoverGatewayConnection: vi.fn(),
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
