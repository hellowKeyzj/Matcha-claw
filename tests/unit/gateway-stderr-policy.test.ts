import { describe, expect, it } from 'vitest';
import { classifyGatewayStderrMessage } from '@electron/gateway/stderr-policy';

describe('gateway stderr policy', () => {
  it('drops empty messages', () => {
    expect(classifyGatewayStderrMessage('   ').level).toBe('drop');
  });

  it('keeps config schema warnings visible (not silently dropped)', () => {
    const line = '2026-03-07 [config/schema] possibly sensitive key found: (secrets.providers.*.source)';
    const result = classifyGatewayStderrMessage(line);
    expect(result.level).toBe('warn');
  });

  it('downgrades non-fatal websocket pre-connect close to debug', () => {
    const line = '2026-03-07 [ws] closed before connect conn=abc code=1005 reason=n/a';
    const result = classifyGatewayStderrMessage(line);
    expect(result.level).toBe('debug');
  });

  it('drops known control-ui token mismatch noise', () => {
    const line = 'openclaw-control-ui connect token_mismatch';
    expect(classifyGatewayStderrMessage(line).level).toBe('drop');
  });

  it('keeps unknown stderr as warn', () => {
    const line = 'some unexpected stderr line';
    expect(classifyGatewayStderrMessage(line).level).toBe('warn');
  });
});
