import { describe, expect, it, vi } from 'vitest';
import {
  GatewayControlReadinessBudgetError,
  waitForGatewayControlReady,
} from '../../electron/main/gateway-control-ready-probe';

const controlReadyBudgetMs = 60_000;

type ControlReady = ReturnType<typeof vi.fn>;

function succeeded(body: unknown) {
  return { status: 200 as const, body };
}

function createProbeDeps(controlReady: ControlReady, nowMs: () => number, delay: ReturnType<typeof vi.fn>) {
  return {
    runtimeControlTransport: { controlReady },
    nowMs,
    delay,
  };
}

describe('gateway control ready probe', () => {
  it('uses runtime-control transport and retries a starting status before ready', async () => {
    let now = 0;
    const controlReady = vi.fn()
      .mockResolvedValueOnce(succeeded({ ready: false, phase: 'starting', retryable: true }))
      .mockResolvedValueOnce(succeeded({ ready: true, phase: 'ready', retryable: false }));
    const delay = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(waitForGatewayControlReady(
      createProbeDeps(controlReady, () => now, delay),
      controlReadyBudgetMs,
    )).resolves.toBeUndefined();

    expect(controlReady).toHaveBeenCalledTimes(2);
    expect(controlReady).toHaveBeenCalledWith({ timeoutMs: 3_000 });
    expect(delay).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(1_000);
  });

  it('backs off retryable starting statuses with 1s, 2s, then 3s delays', async () => {
    let now = 0;
    const controlReady = vi.fn()
      .mockResolvedValueOnce(succeeded({ ready: false, phase: 'starting', retryable: true }))
      .mockResolvedValueOnce(succeeded({ ready: false, phase: 'starting', retryable: true }))
      .mockResolvedValueOnce(succeeded({ ready: false, phase: 'starting', retryable: true }))
      .mockResolvedValueOnce(succeeded({ ready: false, phase: 'starting', retryable: true }))
      .mockResolvedValueOnce(succeeded({ ready: true, phase: 'ready', retryable: false }));
    const delay = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(waitForGatewayControlReady(
      createProbeDeps(controlReady, () => now, delay),
      controlReadyBudgetMs,
    )).resolves.toBeUndefined();

    expect(delay).toHaveBeenNthCalledWith(1, 1_000);
    expect(delay).toHaveBeenNthCalledWith(2, 2_000);
    expect(delay).toHaveBeenNthCalledWith(3, 3_000);
    expect(delay).toHaveBeenNthCalledWith(4, 3_000);
  });

  it('clamps the final delay to the caller budget and makes no follow-up controlReady', async () => {
    let now = 0;
    const controlReady = vi.fn(async () => {
      now += 450;
      return succeeded({ ready: false, phase: 'starting', retryable: true });
    });
    const delay = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(waitForGatewayControlReady(
      createProbeDeps(controlReady, () => now, delay),
      500,
    )).rejects.toBeInstanceOf(GatewayControlReadinessBudgetError);

    expect(controlReady).toHaveBeenCalledTimes(1);
    expect(controlReady).toHaveBeenCalledWith({ timeoutMs: 500 });
    expect(delay).toHaveBeenCalledWith(50);
    expect(now).toBe(500);
  });

  it('uses the short controlReady timeout rather than the former 15-second ceiling', async () => {
    const controlReady = vi.fn(async () => (
      succeeded({ ready: true, phase: 'ready', retryable: false })
    ));
    const delay = vi.fn();

    await expect(waitForGatewayControlReady(
      createProbeDeps(controlReady, () => 0, delay),
      controlReadyBudgetMs,
    )).resolves.toBeUndefined();

    const controlReadyTimeoutMs = controlReady.mock.calls[0]?.[0]?.timeoutMs;
    expect(controlReadyTimeoutMs).toBe(3_000);
    expect(controlReadyTimeoutMs).toBeLessThan(15_000);
    expect(delay).not.toHaveBeenCalled();
  });

  it('does not retry an unavailable status', async () => {
    const controlReady = vi.fn(async () => (
      succeeded({ ready: false, phase: 'unavailable', retryable: true })
    ));
    const delay = vi.fn();

    await expect(waitForGatewayControlReady(
      createProbeDeps(controlReady, () => 0, delay),
      controlReadyBudgetMs,
    )).rejects.toThrow('Gateway control is unavailable.');

    expect(controlReady).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('rejects invalid or unsafe controlReady results without exposing raw payload fields', async () => {
    const rawToken = 'gateway-external-token';
    const rawEndpoint = 'http://127.0.0.1:18789';
    const controlReady = vi.fn(async () => succeeded({
      ready: false,
      phase: 'unavailable',
      retryable: false,
      rawToken,
      rawEndpoint,
    }));
    const delay = vi.fn();

    const error = await waitForGatewayControlReady(
      createProbeDeps(controlReady, () => 0, delay),
      controlReadyBudgetMs,
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Gateway control readiness response was invalid.');
    expect((error as Error).message).not.toContain(rawToken);
    expect((error as Error).message).not.toContain(rawEndpoint);
    expect(controlReady).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('preserves runtime-control request timeout for outer recovery', async () => {
    const transportError = new Error('runtime-control transport failed');
    const controlReady = vi.fn(async () => {
      throw transportError;
    });
    const delay = vi.fn();

    await expect(waitForGatewayControlReady(
      createProbeDeps(controlReady, () => 0, delay),
      controlReadyBudgetMs,
    )).rejects.toBe(transportError);

    expect(controlReady).toHaveBeenCalledWith({ timeoutMs: 3_000 });
    expect(delay).not.toHaveBeenCalled();
  });

  it('treats a non-200 runtime-control response as a safe readiness failure', async () => {
    const controlReady = vi.fn(async () => ({ status: 503 as const, body: { success: false, error: 'Runtime control is unavailable' } }));
    const delay = vi.fn();

    await expect(waitForGatewayControlReady(
      createProbeDeps(controlReady, () => 0, delay),
      controlReadyBudgetMs,
    )).rejects.toThrow('Gateway control readiness command was rejected.');

    expect(controlReady).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});
