import { describe, expect, it, vi } from 'vitest';
import {
  GatewayControlReadinessBudgetError,
  waitForGatewayControlReady,
} from '../../electron/main/gateway-control-ready-probe';
import { RuntimeHostControlError } from '../../electron/main/runtime-host-delivery/control';

const controlReadyBudgetMs = 60_000;

type DirectCommand = ReturnType<typeof vi.fn>;

function succeeded(result: unknown) {
  return { kind: 'succeeded' as const, result };
}

function createProbeDeps(command: DirectCommand, nowMs: () => number, delay: ReturnType<typeof vi.fn>) {
  return {
    directHost: { command },
    nowMs,
    delay,
  };
}

describe('gateway control ready probe', () => {
  it('uses direct framed control and retries a starting status before ready', async () => {
    let now = 0;
    const command = vi.fn()
      .mockResolvedValueOnce(succeeded({ ready: false, phase: 'starting', retryable: true }))
      .mockResolvedValueOnce(succeeded({ ready: true, phase: 'ready', retryable: false }));
    const delay = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(waitForGatewayControlReady(
      createProbeDeps(command, () => now, delay),
      controlReadyBudgetMs,
    )).resolves.toBeUndefined();

    expect(command).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledWith(
      { name: 'openclaw.control.ready' },
      { timeoutMs: 3_000 },
    );
    expect(delay).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(1_000);
  });

  it('backs off retryable starting statuses with 1s, 2s, then 3s delays', async () => {
    let now = 0;
    const command = vi.fn()
      .mockResolvedValueOnce(succeeded({ ready: false, phase: 'starting', retryable: true }))
      .mockResolvedValueOnce(succeeded({ ready: false, phase: 'starting', retryable: true }))
      .mockResolvedValueOnce(succeeded({ ready: false, phase: 'starting', retryable: true }))
      .mockResolvedValueOnce(succeeded({ ready: false, phase: 'starting', retryable: true }))
      .mockResolvedValueOnce(succeeded({ ready: true, phase: 'ready', retryable: false }));
    const delay = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(waitForGatewayControlReady(
      createProbeDeps(command, () => now, delay),
      controlReadyBudgetMs,
    )).resolves.toBeUndefined();

    expect(delay).toHaveBeenNthCalledWith(1, 1_000);
    expect(delay).toHaveBeenNthCalledWith(2, 2_000);
    expect(delay).toHaveBeenNthCalledWith(3, 3_000);
    expect(delay).toHaveBeenNthCalledWith(4, 3_000);
  });

  it('clamps the final delay to the caller budget and makes no follow-up command', async () => {
    let now = 0;
    const command = vi.fn(async () => {
      now += 450;
      return succeeded({ ready: false, phase: 'starting', retryable: true });
    });
    const delay = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(waitForGatewayControlReady(
      createProbeDeps(command, () => now, delay),
      500,
    )).rejects.toBeInstanceOf(GatewayControlReadinessBudgetError);

    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith(
      { name: 'openclaw.control.ready' },
      { timeoutMs: 500 },
    );
    expect(delay).toHaveBeenCalledWith(50);
    expect(now).toBe(500);
  });

  it('uses the short command timeout rather than the former 15-second ceiling', async () => {
    const command = vi.fn(async () => (
      succeeded({ ready: true, phase: 'ready', retryable: false })
    ));
    const delay = vi.fn();

    await expect(waitForGatewayControlReady(
      createProbeDeps(command, () => 0, delay),
      controlReadyBudgetMs,
    )).resolves.toBeUndefined();

    const commandTimeoutMs = command.mock.calls[0]?.[1]?.timeoutMs;
    expect(commandTimeoutMs).toBe(3_000);
    expect(commandTimeoutMs).toBeLessThan(15_000);
    expect(delay).not.toHaveBeenCalled();
  });

  it('does not retry an unavailable status', async () => {
    const command = vi.fn(async () => (
      succeeded({ ready: false, phase: 'unavailable', retryable: true })
    ));
    const delay = vi.fn();

    await expect(waitForGatewayControlReady(
      createProbeDeps(command, () => 0, delay),
      controlReadyBudgetMs,
    )).rejects.toThrow('Gateway control is unavailable.');

    expect(command).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('rejects invalid or unsafe command results without exposing raw payload fields', async () => {
    const rawToken = 'gateway-external-token';
    const rawEndpoint = 'http://127.0.0.1:18789';
    const command = vi.fn(async () => succeeded({
      ready: false,
      phase: 'unavailable',
      retryable: false,
      rawToken,
      rawEndpoint,
    }));
    const delay = vi.fn();

    const error = await waitForGatewayControlReady(
      createProbeDeps(command, () => 0, delay),
      controlReadyBudgetMs,
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Gateway control readiness response was invalid.');
    expect((error as Error).message).not.toContain(rawToken);
    expect((error as Error).message).not.toContain(rawEndpoint);
    expect(command).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('preserves direct-control timeout and delivery uncertainty for outer recovery', async () => {
    const deliveryError = new RuntimeHostControlError('timeout-exceeded', 'unknown-delivery');
    const command = vi.fn(async () => {
      throw deliveryError;
    });
    const delay = vi.fn();

    await expect(waitForGatewayControlReady(
      createProbeDeps(command, () => 0, delay),
      controlReadyBudgetMs,
    )).rejects.toBe(deliveryError);

    expect(deliveryError.delivery).toBe('unknown-delivery');
    expect(command).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('treats a timed-out command outcome as a safe readiness failure', async () => {
    const command = vi.fn(async () => ({ kind: 'timed-out' as const }));
    const delay = vi.fn();

    await expect(waitForGatewayControlReady(
      createProbeDeps(command, () => 0, delay),
      controlReadyBudgetMs,
    )).rejects.toThrow('Gateway control readiness command timed out.');

    expect(command).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});
