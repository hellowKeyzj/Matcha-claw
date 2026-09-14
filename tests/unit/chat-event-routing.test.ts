import { describe, expect, it } from 'vitest';
import {
  canRuntimeEventReuseActiveRunId,
  isRuntimeEventUsefulForPolling,
  isUnboundLifecycleEvent,
  shouldIgnoreRuntimeEvent,
} from '@/stores/chat/event-routing';

describe('chat runtime event routing helpers', () => {
  it('ignores events for a different backend session', () => {
    expect(shouldIgnoreRuntimeEvent({
      eventSessionKey: 'agent:other:main',
      targetEventSessionKey: 'agent:main:main',
    })).toBe(true);

    expect(shouldIgnoreRuntimeEvent({
      eventSessionKey: 'agent:main:main',
      targetEventSessionKey: 'agent:main:main',
    })).toBe(false);
  });

  it('does not compare backend event keys against renderer record keys', () => {
    expect(shouldIgnoreRuntimeEvent({
      eventSessionKey: 'agent:main:session-1',
      targetEventSessionKey: 'agent:main:session-1',
    })).toBe(false);
  });

  it('routes cron base and run-scoped keys as the same session', () => {
    expect(shouldIgnoreRuntimeEvent({
      eventSessionKey: 'agent:main:cron:job-1:run:run-1',
      targetEventSessionKey: 'agent:main:cron:job-1',
    })).toBe(false);

    expect(shouldIgnoreRuntimeEvent({
      eventSessionKey: 'agent:main:cron:job-1:run:run-1',
      targetEventSessionKey: 'agent:main:cron:job-2',
    })).toBe(true);

    expect(shouldIgnoreRuntimeEvent({
      eventSessionKey: 'agent:main:main:run:run-1',
      targetEventSessionKey: 'agent:main:main',
    })).toBe(true);
  });

  it('only delta/final/error/aborted are useful for poll switching', () => {
    expect(isRuntimeEventUsefulForPolling('delta')).toBe(true);
    expect(isRuntimeEventUsefulForPolling('final')).toBe(true);
    expect(isRuntimeEventUsefulForPolling('error')).toBe(true);
    expect(isRuntimeEventUsefulForPolling('aborted')).toBe(true);
    expect(isRuntimeEventUsefulForPolling('started')).toBe(false);
    expect(isRuntimeEventUsefulForPolling('unknown')).toBe(false);
  });

  it('only started/delta/unknown can reuse the active run id', () => {
    expect(canRuntimeEventReuseActiveRunId('started')).toBe(true);
    expect(canRuntimeEventReuseActiveRunId('delta')).toBe(true);
    expect(canRuntimeEventReuseActiveRunId('unknown')).toBe(true);
    expect(canRuntimeEventReuseActiveRunId('final')).toBe(false);
    expect(canRuntimeEventReuseActiveRunId('error')).toBe(false);
    expect(canRuntimeEventReuseActiveRunId('aborted')).toBe(false);
  });

  it('treats unbound final/error/aborted as lifecycle reconcile events', () => {
    expect(isUnboundLifecycleEvent('final', '')).toBe(true);
    expect(isUnboundLifecycleEvent('error', '')).toBe(true);
    expect(isUnboundLifecycleEvent('aborted', '')).toBe(true);
    expect(isUnboundLifecycleEvent('delta', '')).toBe(false);
    expect(isUnboundLifecycleEvent('final', 'run-1')).toBe(false);
  });
});
