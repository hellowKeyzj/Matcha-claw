import { describe, expect, it, vi } from 'vitest';
import { waitForGatewayControlReady } from '../../electron/main/gateway-control-ready-probe';

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
      runtimeHostManager: { request } as never,
      nowMs: () => now,
      delay,
    }, 30000)).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(2);
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
      runtimeHostManager: { request } as never,
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
      runtimeHostManager: { request } as never,
      nowMs: () => 0,
      delay: vi.fn(),
    }, 30000)).rejects.toThrow('GATEWAY_METHODS_UNAVAILABLE');

    expect(request).toHaveBeenCalledTimes(1);
  });
});
