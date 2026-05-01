export type RuntimeEventKind = 'started' | 'delta' | 'final' | 'error' | 'aborted' | 'unknown';

export interface RuntimeEventFilterInput {
  activeRunId: string | null;
  currentSessionKey: string;
  runId: string;
  eventSessionKey: string | null;
}

export function shouldIgnoreRuntimeEvent(input: RuntimeEventFilterInput): boolean {
  if (input.eventSessionKey != null && input.eventSessionKey !== input.currentSessionKey) {
    return true;
  }
  if (input.activeRunId && input.runId && input.runId !== input.activeRunId) {
    return true;
  }
  return false;
}

export function isRuntimeEventUsefulForPolling(kind: RuntimeEventKind): boolean {
  return kind === 'delta'
    || kind === 'final'
    || kind === 'error'
    || kind === 'aborted';
}

export function canRuntimeEventReuseActiveRunId(kind: RuntimeEventKind): boolean {
  return kind === 'started'
    || kind === 'delta'
    || kind === 'unknown';
}

export function isUnboundLifecycleEvent(kind: RuntimeEventKind, runId: string): boolean {
  if (runId) {
    return false;
  }
  return kind === 'final'
    || kind === 'error'
    || kind === 'aborted';
}
