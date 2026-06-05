import { describe, expect, it, vi } from 'vitest';
import {
  getGatewayStartupRecoveryAction,
  hasInvalidConfigFailureSignal,
  isGatewayStillStartingError,
  isInvalidConfigSignal,
  shouldAttemptConfigAutoRepair,
  waitForGatewayControlReadyWithStartupRetry,
} from '@electron/gateway/startup-recovery';

describe('gateway startup recovery heuristics', () => {
  it('detects invalid-config signal from stderr lines', () => {
    const lines = [
      'Invalid config at C:\\Users\\pc\\.openclaw\\openclaw.json:\\n- skills: Unrecognized key: "enabled"',
      'Run: openclaw doctor --fix',
    ];
    expect(hasInvalidConfigFailureSignal(new Error('gateway start failed'), lines)).toBe(true);
  });

  it('detects invalid-config signal from error message fallback', () => {
    expect(
      hasInvalidConfigFailureSignal(
        new Error('Config invalid. Run: openclaw doctor --fix'),
        [],
      ),
    ).toBe(true);
  });

  it('does not treat unrelated startup failures as invalid-config failures', () => {
    const lines = [
      'Gateway process exited (code=1, expected=no)',
      'WebSocket closed before handshake',
    ];
    expect(
      hasInvalidConfigFailureSignal(
        new Error('Gateway process exited before becoming ready (code=1)'),
        lines,
      ),
    ).toBe(false);
  });

  it('attempts auto-repair only once per startup flow', () => {
    const lines = ['Config invalid', '- skills: Unrecognized key: "enabled"'];
    expect(shouldAttemptConfigAutoRepair(new Error('start failed'), lines, false)).toBe(true);
    expect(shouldAttemptConfigAutoRepair(new Error('start failed'), lines, true)).toBe(false);
  });

  it('matches common invalid-config phrases robustly', () => {
    expect(isInvalidConfigSignal('Config invalid')).toBe(true);
    expect(isInvalidConfigSignal('skills: Unrecognized key: "enabled"')).toBe(true);
    expect(isInvalidConfigSignal('Run: openclaw doctor --fix')).toBe(true);
    expect(isInvalidConfigSignal('Gateway ready after 3 attempts')).toBe(false);
  });

  it('端口仍被占用属于可重试的瞬态启动错误', () => {
    const action = getGatewayStartupRecoveryAction({
      startupError: new Error('Port 18789 still occupied after 30000ms'),
      startupStderrLines: [],
      configRepairAttempted: false,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(action).toBe('retry');
  });

  it('识别 OpenClaw 启动中拒绝控制面连接的错误', () => {
    expect(isGatewayStillStartingError(new Error('gateway starting; retry shortly'))).toBe(true);
    expect(isGatewayStillStartingError(new Error('Gateway control ready check failed'))).toBe(false);
  });

  it('控制面仍在启动时会原地重试到成功', async () => {
    const waitForControlReady = vi.fn()
      .mockRejectedValueOnce(new Error('gateway starting; retry shortly'))
      .mockResolvedValueOnce(undefined);
    const delay = vi.fn().mockResolvedValue(undefined);

    await waitForGatewayControlReadyWithStartupRetry({
      waitForControlReady,
      port: 18789,
      delay,
      retryDelaysMs: [5],
    });

    expect(waitForControlReady).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(5);
  });
});
