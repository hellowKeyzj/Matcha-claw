import { describe, expect, it } from 'vitest';
import {
  getGatewayStartupRecoveryAction,
  hasInvalidConfigFailureSignal,
  isInvalidConfigSignal,
  isTransientGatewayStartError,
  shouldAttemptConfigAutoRepair,
} from '@electron/main/process-runtime/openclaw-gateway/startup-recovery';

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

  it('retries transient startup failures without stopping the current Gateway', () => {
    const transientStartErrors = [
      new Error('Gateway process exited before becoming ready (code=1)'),
      new Error('connect ECONNREFUSED 127.0.0.1:18789'),
      new Error('Port 18789 still occupied after 60000ms'),
    ];

    for (const startupError of transientStartErrors) {
      expect(isTransientGatewayStartError(startupError)).toBe(true);
      expect(getGatewayStartupRecoveryAction({
        startupError,
        startupStderrLines: [],
        configRepairAttempted: false,
        attempt: 1,
        maxAttempts: 3,
      })).toEqual({
        action: 'retry',
        cleanup: 'keep-current',
      });
    }
  });
});
