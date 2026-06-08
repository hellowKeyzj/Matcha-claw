import { describe, expect, it, vi } from 'vitest';
import { waitForGatewayControlReady } from '../../electron/main/gateway-control-ready-probe';

const runtimeHostEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};

function createRuntimeHostManagerMock(request: ReturnType<typeof vi.fn>) {
  return {
    request: vi.fn(async (method: string, route: string, payload?: unknown, options?: unknown) => {
      if (route === '/api/runtime-endpoints/list') {
        return {
          data: {
            endpoints: [{
              id: 'openclaw-local',
              runtimeAdapterId: 'openclaw',
              runtimeInstanceId: 'local',
              capabilitySummaries: [{ id: 'runtime.host', availability: 'available' }],
            }],
          },
        };
      }
      if (route === '/api/capabilities/list') {
        return {
          data: {
            capabilities: [{
              id: 'runtime.host',
              availability: 'available',
              scope: { kind: 'runtime-instance', endpoint: runtimeHostEndpoint },
            }],
          },
        };
      }
      return await request(method, route, payload, options);
    }),
  };
}

describe('gateway control ready probe', () => {
  it('continues polling retryable OpenClaw V4 starting responses until ready', async () => {
    let now = 0;
    const request = vi.fn()
      .mockResolvedValueOnce({
        data: {
          success: false,
          phase: 'starting',
          retryable: true,
          retryAfterMs: 100,
          code: 'UNAVAILABLE',
          error: 'Gateway connect failed: gateway starting; retry shortly',
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          phase: 'ready',
          retryable: false,
          requiredMethods: ['status'],
          missingMethods: [],
        },
      });
    const delay = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(waitForGatewayControlReady({
      runtimeHostManager: createRuntimeHostManagerMock(request) as never,
      nowMs: () => now,
      delay,
    }, 30000)).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/api/capabilities/execute',
      expect.objectContaining({
        id: 'runtime.host',
        operationId: 'runtimeHost.gatewayReady',
        scope: { kind: 'runtime-instance', endpoint: runtimeHostEndpoint },
        target: { kind: 'gateway-control' },
      }),
      expect.anything(),
    );
    expect(delay).toHaveBeenCalledWith(1000);
  });

  it('backs off retryable probes with 1s, 2s, then 3s delays', async () => {
    let now = 0;
    const request = vi.fn()
      .mockResolvedValueOnce({ data: { success: false, phase: 'starting', retryable: true } })
      .mockResolvedValueOnce({ data: { success: false, phase: 'starting', retryable: true } })
      .mockResolvedValueOnce({ data: { success: false, phase: 'starting', retryable: true } })
      .mockResolvedValueOnce({ data: { success: false, phase: 'starting', retryable: true } })
      .mockResolvedValueOnce({ data: { success: true, phase: 'ready' } });
    const delay = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(waitForGatewayControlReady({
      runtimeHostManager: createRuntimeHostManagerMock(request) as never,
      nowMs: () => now,
      delay,
    }, 30000)).resolves.toBeUndefined();

    expect(delay).toHaveBeenNthCalledWith(1, 1000);
    expect(delay).toHaveBeenNthCalledWith(2, 2000);
    expect(delay).toHaveBeenNthCalledWith(3, 3000);
    expect(delay).toHaveBeenNthCalledWith(4, 3000);
  });

  it('fails immediately on non-retryable unavailable responses', async () => {
    const request = vi.fn(async () => ({
      data: {
        success: false,
        phase: 'unavailable',
        retryable: false,
        code: 'GATEWAY_METHODS_UNAVAILABLE',
        missingMethods: ['status'],
      },
    }));

    await expect(waitForGatewayControlReady({
      runtimeHostManager: createRuntimeHostManagerMock(request) as never,
      nowMs: () => 0,
      delay: vi.fn(),
    }, 30000)).rejects.toThrow('GATEWAY_METHODS_UNAVAILABLE');

    expect(request).toHaveBeenCalledTimes(1);
  });
});
