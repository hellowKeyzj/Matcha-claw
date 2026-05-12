import { describe, expect, it, vi } from 'vitest';
import { GatewayService } from '../../runtime-host/application/gateway/service';

describe('runtime-host gateway ready service', () => {
  function createFileSystem() {
    return {} as ConstructorParameters<typeof GatewayService>[0]['fileSystem'];
  }

  it('checks explicit required methods against gateway capabilities', async () => {
    const gateway = {
      gatewayRpc: vi.fn(),
      ensureGatewayReady: vi.fn(),
      inspectGatewayMethodReadiness: vi.fn(async () => ({
        ready: false,
        methods: ['TaskList'],
        missingMethods: ['TaskList'],
      })),
      readGatewayConnectionState: vi.fn(),
      chatSend: vi.fn(),
    };
    const service = new GatewayService({ gateway, fileSystem: createFileSystem() });

    await expect(service.ready({
      timeoutMs: 3000,
      requiredMethods: ['TaskList'],
    })).resolves.toEqual({
      status: 200,
      data: {
        success: false,
        code: 'GATEWAY_METHODS_UNAVAILABLE',
        missingMethods: ['TaskList'],
      },
    });
    expect(gateway.inspectGatewayMethodReadiness).toHaveBeenCalledWith(['TaskList'], 3000);
    expect(gateway.ensureGatewayReady).not.toHaveBeenCalled();
  });

  it('uses base gateway readiness when no required methods are provided', async () => {
    const gateway = {
      gatewayRpc: vi.fn(),
      ensureGatewayReady: vi.fn(async () => undefined),
      inspectGatewayMethodReadiness: vi.fn(),
      readGatewayConnectionState: vi.fn(),
      chatSend: vi.fn(),
    };
    const service = new GatewayService({ gateway, fileSystem: createFileSystem() });

    await expect(service.ready({ timeoutMs: 3000 })).resolves.toMatchObject({
      status: 200,
      data: { success: true },
    });
    expect(gateway.ensureGatewayReady).toHaveBeenCalledWith(3000);
    expect(gateway.inspectGatewayMethodReadiness).not.toHaveBeenCalled();
  });
});
