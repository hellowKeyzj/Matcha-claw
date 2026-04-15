import { describe, expect, it } from 'vitest';
import {
  extractRuntimeEventMeta,
  isRuntimeEventUsefulForPolling,
  normalizeRuntimeEvent,
  resolveRuntimeEventState,
  shouldIgnoreRuntimeEvent,
} from '@/stores/chat/event-routing';

describe('chat runtime event routing helpers', () => {
  it('normalizes completed aliases to final', () => {
    expect(resolveRuntimeEventState('COMPLETED', null)).toBe('final');
    expect(resolveRuntimeEventState('done', null)).toBe('final');
  });

  it('infers final or delta from message payload when state is empty', () => {
    expect(resolveRuntimeEventState('', { stopReason: 'end_turn' })).toBe('final');
    expect(resolveRuntimeEventState('', { role: 'assistant' })).toBe('delta');
  });

  it('extracts trimmed run/session meta', () => {
    const meta = extractRuntimeEventMeta({
      runId: ' run-1 ',
      sessionKey: ' agent:main:main ',
      state: 'START',
    });

    expect(meta.runId).toBe('run-1');
    expect(meta.eventSessionKey).toBe('agent:main:main');
    expect(meta.resolvedState).toBe('started');
  });

  it('normalizes runtime event to discriminated kind', () => {
    const normalized = normalizeRuntimeEvent({
      runId: ' run-1 ',
      sessionKey: ' agent:main:main ',
      state: 'Done',
      message: { role: 'assistant', content: 'ok' },
    });

    expect(normalized.kind).toBe('final');
    expect(normalized.runId).toBe('run-1');
    expect(normalized.eventSessionKey).toBe('agent:main:main');
    expect(normalized.message).toEqual({ role: 'assistant', content: 'ok' });
  });

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
});

