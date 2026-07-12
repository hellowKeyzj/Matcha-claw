import { describe, expect, it } from 'vitest';
import {
  getLocalProcessRestartDecision,
  type LocalProcessRestartPolicyInput,
} from '../../electron/main/process-runtime/restart-policy';
import {
  createProcessOutputLineBuffer,
  formatProcessLogPrefix,
  normalizeProcessOutputChunk,
} from '../../electron/main/process-runtime/log-tail';

const baseRestartInput: LocalProcessRestartPolicyInput = {
  autoRestartOnCrash: true,
  shouldKeepAlive: true,
  hasRestartTimer: false,
  hasChildProcess: false,
  nowMs: 10_000,
  crashTimestamps: [],
  windowMs: 60_000,
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
};

describe('local process restart policy', () => {
  it('skips restart when auto restart is disabled', () => {
    expect(getLocalProcessRestartDecision({
      ...baseRestartInput,
      autoRestartOnCrash: false,
    })).toEqual({ action: 'skip', reason: 'disabled' });
  });

  it('skips restart when the runner was intentionally stopped', () => {
    expect(getLocalProcessRestartDecision({
      ...baseRestartInput,
      shouldKeepAlive: false,
    })).toEqual({ action: 'skip', reason: 'stopped' });
  });

  it('skips restart when another restart is already scheduled', () => {
    expect(getLocalProcessRestartDecision({
      ...baseRestartInput,
      hasRestartTimer: true,
    })).toEqual({ action: 'skip', reason: 'already-scheduled' });
  });

  it('skips restart when a child process is still alive', () => {
    expect(getLocalProcessRestartDecision({
      ...baseRestartInput,
      hasChildProcess: true,
    })).toEqual({ action: 'skip', reason: 'process-alive' });
  });

  it('halts restart when crashes exceed the attempt window', () => {
    expect(getLocalProcessRestartDecision({
      ...baseRestartInput,
      crashTimestamps: [8_000, 9_000],
      maxAttempts: 2,
    })).toEqual({
      action: 'halt',
      crashTimestamps: [8_000, 9_000, 10_000],
      maxAttempts: 2,
      windowMs: 60_000,
    });
  });

  it('schedules restart with exponential delay and max delay cap', () => {
    expect(getLocalProcessRestartDecision({
      ...baseRestartInput,
      crashTimestamps: [-100_000, 9_000],
    })).toEqual({
      action: 'schedule',
      delayMs: 200,
      attempt: 2,
      crashTimestamps: [9_000, 10_000],
    });

    expect(getLocalProcessRestartDecision({
      ...baseRestartInput,
      crashTimestamps: [7_000, 8_000, 9_000],
      maxAttempts: 4,
      maxDelayMs: 250,
    })).toEqual({
      action: 'schedule',
      delayMs: 250,
      attempt: 4,
      crashTimestamps: [7_000, 8_000, 9_000, 10_000],
    });
  });
});

describe('local process log tail', () => {
  it('strips ANSI escapes, normalizes CRLF and filters empty lines', () => {
    expect(normalizeProcessOutputChunk(
      '[31mred[0m\r\nplain\rlegacy-cr\n\n   \n  keep-leading-space  ',
    )).toEqual([
      'red',
      'plain',
      'legacy-cr',
      '  keep-leading-space',
    ]);
  });

  it('returns no lines for empty chunks', () => {
    expect(normalizeProcessOutputChunk(null)).toEqual([]);
    expect(normalizeProcessOutputChunk(Buffer.from(''))).toEqual([]);
  });

  it('preserves multibyte UTF-8 characters split across process output chunks', () => {
    const buffer = createProcessOutputLineBuffer();
    const payload = Buffer.from('[ws] 📤 res ✅ health 750ms cached=true\n');
    const splitAt = payload.indexOf(Buffer.from('✅')) + 1;

    expect(buffer.push(payload.subarray(0, splitAt))).toEqual([]);
    expect(buffer.push(payload.subarray(splitAt))).toEqual([
      '[ws] 📤 res ✅ health 750ms cached=true',
    ]);
    expect(buffer.flush()).toEqual([]);
  });

  it('buffers incomplete lines until newline or stream flush', () => {
    const buffer = createProcessOutputLineBuffer();

    expect(buffer.push(Buffer.from('partial'))).toEqual([]);
    expect(buffer.push(Buffer.from('-line\nnext'))).toEqual(['partial-line']);
    expect(buffer.flush()).toEqual(['next']);
  });

  it('adds stderr suffix only for stderr log prefix', () => {
    expect(formatProcessLogPrefix('runtime-host-child', 'stdout')).toBe('[runtime-host-child]');
    expect(formatProcessLogPrefix('runtime-host-child', 'stderr')).toBe('[runtime-host-child:stderr]');
  });
});
