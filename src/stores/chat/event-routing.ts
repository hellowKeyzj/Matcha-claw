export type RuntimeEventState = 'started' | 'delta' | 'final' | 'error' | 'aborted' | '';
export type RuntimeEventKind = Exclude<RuntimeEventState, ''> | 'unknown';

export interface RuntimeEventMeta {
  runId: string;
  eventState: string;
  eventSessionKey: string | null;
  resolvedState: RuntimeEventState;
}

export interface NormalizedRuntimeEvent extends RuntimeEventMeta {
  kind: RuntimeEventKind;
  message: unknown;
  event: Record<string, unknown>;
}

export interface RuntimeEventFilterInput {
  activeRunId: string | null;
  currentSessionKey: string;
  runId: string;
  eventSessionKey: string | null;
}

export function resolveRuntimeEventState(
  eventState: string,
  message: unknown,
): RuntimeEventState {
  const normalizedState = eventState.trim().toLowerCase();
  if (
    normalizedState === 'completed'
    || normalizedState === 'done'
    || normalizedState === 'finished'
    || normalizedState === 'end'
  ) {
    return 'final';
  }
  if (
    normalizedState === 'start'
    || normalizedState === 'started'
  ) {
    return 'started';
  }
  if (
    normalizedState === 'abort'
    || normalizedState === 'aborted'
    || normalizedState === 'cancelled'
    || normalizedState === 'canceled'
  ) {
    return 'aborted';
  }
  if (normalizedState) {
    if (
      normalizedState === 'delta'
      || normalizedState === 'final'
      || normalizedState === 'error'
      || normalizedState === 'started'
      || normalizedState === 'aborted'
    ) {
      return normalizedState;
    }
    return '';
  }
  if (!message || typeof message !== 'object') {
    return '';
  }
  const messageRecord = message as Record<string, unknown>;
  const stopReason = messageRecord.stopReason ?? messageRecord.stop_reason;
  if (stopReason) {
    return 'final';
  }
  if (messageRecord.role || messageRecord.content) {
    return 'delta';
  }
  return '';
}

export function extractRuntimeEventMeta(event: Record<string, unknown>): RuntimeEventMeta {
  const runId = String(event.runId || '').trim();
  const eventState = String(event.state || '');
  const rawSessionKey = event.sessionKey != null ? String(event.sessionKey).trim() : '';
  const eventSessionKey = rawSessionKey || null;
  const resolvedState = resolveRuntimeEventState(eventState, event.message);
  return {
    runId,
    eventState,
    eventSessionKey,
    resolvedState,
  };
}

export function normalizeRuntimeEvent(event: Record<string, unknown>): NormalizedRuntimeEvent {
  const meta = extractRuntimeEventMeta(event);
  return {
    ...meta,
    kind: meta.resolvedState || 'unknown',
    message: event.message,
    event,
  };
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
