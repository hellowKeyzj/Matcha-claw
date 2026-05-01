import { describe, expect, it } from 'vitest';
import {
  canRuntimeEventReuseActiveRunId,
  isRuntimeEventUsefulForPolling,
  isUnboundLifecycleEvent,
  shouldIgnoreRuntimeEvent,
} from '@/stores/chat/event-routing';

describe('chat runtime event routing helpers', () => {
  it('ignores events for another session or another active run', () => {
    expect(shouldIgnoreRuntimeEvent({
      activeRunId: null,
      currentSessionKey: 'agent:main:main',
      runId: '',
      eventSessionKey: 'agent:other:main',
    })).toBe(true);

    expect(shouldIgnoreRuntimeEvent({
      activeRunId: 'run-a',
      currentSessionKey: 'agent:main:main',
      runId: 'run-b',
      eventSessionKey: 'agent:main:main',
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
