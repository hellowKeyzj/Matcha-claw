export type RuntimeEventKind = 'started' | 'delta' | 'final' | 'error' | 'aborted' | 'unknown';

export interface RuntimeEventFilterInput {
  eventSessionKey: string | null;
  targetSessionKey: string;
}

export function shouldIgnoreRuntimeEvent(input: RuntimeEventFilterInput): boolean {
  if (input.eventSessionKey != null && input.eventSessionKey !== input.targetSessionKey) {
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
