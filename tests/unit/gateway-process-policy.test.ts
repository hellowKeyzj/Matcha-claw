import { describe, expect, it } from 'vitest';
import {
  getDeferredRestartAction,
  shouldDeferRestart,
} from '@electron/main/process-runtime/openclaw-gateway/process-policy';

describe('gateway process policy helpers', () => {
  describe('restart deferral policy', () => {
    it('defers restart while startup or reconnect is in progress', () => {
      expect(shouldDeferRestart({ processState: 'starting' })).toBe(true);
      expect(shouldDeferRestart({ processState: 'control_connecting' })).toBe(true);
      expect(shouldDeferRestart({ processState: 'reconnecting' })).toBe(true);
    });

    it('does not defer restart for stable states', () => {
      expect(shouldDeferRestart({ processState: 'running' })).toBe(false);
      expect(shouldDeferRestart({ processState: 'stopped' })).toBe(false);
      expect(shouldDeferRestart({ processState: 'error' })).toBe(false);
    });

    it('returns none when no restart is pending', () => {
      expect(
        getDeferredRestartAction({
          hasPendingRestart: false,
          processState: 'running',
        }),
      ).toBe('none');
    });

    it('executes deferred restart after lifecycle recovers to running', () => {
      expect(
        getDeferredRestartAction({
          hasPendingRestart: true,
          processState: 'running',
        }),
      ).toBe('execute');
    });

    it('waits deferred restart while lifecycle is still busy', () => {
      expect(
        getDeferredRestartAction({
          hasPendingRestart: true,
          processState: 'starting',
        }),
      ).toBe('wait');
    });

    it('executes deferred restart when manager is idle and not running', () => {
      expect(
        getDeferredRestartAction({
          hasPendingRestart: true,
          processState: 'error',
        }),
      ).toBe('execute');
    });

    it('drops deferred restart when gateway is already stopped', () => {
      expect(
        getDeferredRestartAction({
          hasPendingRestart: true,
          processState: 'stopped',
        }),
      ).toBe('drop');
    });
  });
});
