import { describe, expect, it, vi } from 'vitest';
import { waitForGatewayControlReady } from '../../electron/main/gateway-control-ready-probe';

const runtimeHostEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};
const gatewayPort = 18789;
const gatewayExternalToken = 'gateway-external-token';
const controlReadyBudgetMs = 60_000;

function createRuntimeHostManagerMock(request: ReturnType<typeof vi.fn>) {
  const runtimeHostManager = {
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
  return runtimeHostManager;
}

function createProbeDeps(request: ReturnType<typeof vi.fn>, nowMs: () => number, delay: ReturnType<typeof vi.fn>) {
  return {
    runtimeHostManager: createRuntimeHostManagerMock(request) as never,
    nowMs,
    delay,
  };
}

describe('gateway control ready probe', () => {
  it('uses a positive retryAfterMs before fallback and preserves gateway connection input', async () => {
    let now = 0;
    const request = vi.fn()
      .mockResolvedValueOnce({
        data: {
          success: false,
          phase: 'starting',
          retryable: true,
          retryAfterMs: 100,
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          phase: 'ready',
          retryable: false,
        },
      });
    const delay = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(waitForGatewayControlReady(
      createProbeDeps(request, () => now, delay),
      controlReadyBudgetMs,
      gatewayPort,
      gatewayExternalToken,
    )).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/api/capabilities/execute',
      expect.objectContaining({
        id: 'runtime.host',
        operationId: 'runtimeHost.gatewayReady',
        scope: { kind: 'runtime-instance', endpoint: runtimeHostEndpoint },
        target: { kind: 'gateway-control' },
        input: {
          port: gatewayPort,
          externalToken: gatewayExternalToken,
        },
      }),
      { timeoutMs: 3_000 },
    );
    expect(delay).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(100);
  });

  it('backs off retryable probes with 1s, 2s, then 3s fallback delays', async () => {
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

    await expect(waitForGatewayControlReady(
      createProbeDeps(request, () => now, delay),
      controlReadyBudgetMs,
      gatewayPort,
    )).resolves.toBeUndefined();

    expect(delay).toHaveBeenNthCalledWith(1, 1_000);
    expect(delay).toHaveBeenNthCalledWith(2, 2_000);
    expect(delay).toHaveBeenNthCalledWith(3, 3_000);
    expect(delay).toHaveBeenNthCalledWith(4, 3_000);
  });

  it('clamps the final delay to the 60-second budget and makes no request after it expires', async () => {
    let now = 0;
    const request = vi.fn(async () => {
      now += 59_500;
      return {
        data: {
          success: false,
          phase: 'starting',
          retryable: true,
          retryAfterMs: 5_000,
          error: 'Gateway is still starting',
        },
      };
    });
    const delay = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(waitForGatewayControlReady(
      createProbeDeps(request, () => now, delay),
      controlReadyBudgetMs,
      gatewayPort,
    )).rejects.toThrow('Gateway control readiness budget exhausted');

    expect(delay).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(500);
    expect(now).toBe(controlReadyBudgetMs);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses the caller budget to clamp the request and prevent a follow-up attempt', async () => {
    let now = 0;
    const request = vi.fn(async () => {
      now += 450;
      return {
        data: {
          success: false,
          phase: 'starting',
          retryable: true,
          retryAfterMs: 1_000,
        },
      };
    });
    const delay = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(waitForGatewayControlReady(
      createProbeDeps(request, () => now, delay),
      500,
      gatewayPort,
    )).rejects.toThrow('Gateway control readiness budget exhausted');

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/api/capabilities/execute',
      expect.objectContaining({ input: { port: gatewayPort } }),
      { timeoutMs: 500 },
    );
    expect(delay).toHaveBeenCalledWith(50);
    expect(now).toBe(500);
  });

  it('uses a short per-request timeout rather than the former 15-second ceiling', async () => {
    const request = vi.fn(async () => ({
      data: {
        success: true,
        phase: 'ready',
      },
    }));
    const delay = vi.fn();

    await expect(waitForGatewayControlReady(
      createProbeDeps(request, () => 0, delay),
      controlReadyBudgetMs,
      gatewayPort,
    )).resolves.toBeUndefined();

    const requestTimeoutMs = request.mock.calls[0]?.[3]?.timeoutMs;
    expect(requestTimeoutMs).toBe(3_000);
    expect(requestTimeoutMs).toBeLessThan(15_000);
    expect(delay).not.toHaveBeenCalled();
  });

  it('bounds runtime-host endpoint discovery within the same short request timeout', async () => {
    const request = vi.fn(async () => ({
      data: {
        success: true,
        phase: 'ready',
      },
    }));
    const runtimeHostManager = createRuntimeHostManagerMock(request);

    await expect(waitForGatewayControlReady({
      runtimeHostManager: runtimeHostManager as never,
      nowMs: () => 0,
      delay: vi.fn(),
    }, controlReadyBudgetMs, gatewayPort)).resolves.toBeUndefined();

    expect(runtimeHostManager.request).toHaveBeenNthCalledWith(
      1,
      'GET',
      '/api/runtime-endpoints/list',
      undefined,
      { timeoutMs: 3_000 },
    );
    expect(runtimeHostManager.request).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/api/capabilities/execute',
      expect.anything(),
      { timeoutMs: 3_000 },
    );
  });

  it('fails immediately when the response is non-retryable even if its phase says starting', async () => {
    const request = vi.fn(async () => ({
      data: {
        success: false,
        phase: 'starting',
        retryable: false,
        code: 'GATEWAY_METHODS_UNAVAILABLE',
        error: 'Gateway is starting but cannot become ready',
      },
    }));
    const delay = vi.fn();

    await expect(waitForGatewayControlReady(
      createProbeDeps(request, () => 0, delay),
      controlReadyBudgetMs,
      gatewayPort,
    )).rejects.toThrow('Gateway is starting but cannot become ready');

    expect(request).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('does not wait for retryable structured responses outside the starting phase', async () => {
    const request = vi.fn(async () => ({
      data: {
        success: false,
        phase: 'unavailable',
        retryable: true,
        error: 'Gateway connection lost',
      },
    }));
    const delay = vi.fn();

    await expect(waitForGatewayControlReady(
      createProbeDeps(request, () => 0, delay),
      controlReadyBudgetMs,
      gatewayPort,
    )).rejects.toThrow('Gateway connection lost');

    expect(request).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('preserves runtime-host request exceptions for outer transient recovery', async () => {
    const requestError = new Error('runtime-host connection reset');
    const request = vi.fn(async () => {
      throw requestError;
    });
    const delay = vi.fn();

    await expect(waitForGatewayControlReady(
      createProbeDeps(request, () => 0, delay),
      controlReadyBudgetMs,
      gatewayPort,
    )).rejects.toBe(requestError);

    expect(request).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});
