import { trackUiEvent, trackUiTiming } from '@/lib/telemetry';

interface ChatRunTelemetryState {
  startedAt: number;
  runId: string | null;
  firstTokenTracked: boolean;
  finalEventAt: number | null;
}

const chatRunTelemetryBySession = new Map<string, ChatRunTelemetryState>();

function nowTelemetryMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function beginChatRunTelemetry(
  sessionKey: string,
  payload: { hasText: boolean; attachmentCount: number },
): void {
  chatRunTelemetryBySession.set(sessionKey, {
    startedAt: nowTelemetryMs(),
    runId: null,
    firstTokenTracked: false,
    finalEventAt: null,
  });
  trackUiEvent('chat.send_submitted', {
    sessionKey,
    hasText: payload.hasText,
    attachmentCount: payload.attachmentCount,
  });
}

export function bindChatRunIdTelemetry(sessionKey: string, runId: string | null | undefined): void {
  const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
  if (!normalizedRunId) {
    return;
  }
  const current = chatRunTelemetryBySession.get(sessionKey);
  if (!current) {
    return;
  }
  if (current.runId === normalizedRunId) {
    return;
  }
  chatRunTelemetryBySession.set(sessionKey, {
    ...current,
    runId: normalizedRunId,
  });
}

export function maybeTrackSendToFirstToken(
  sessionKey: string,
  source: 'delta' | 'final',
): void {
  const current = chatRunTelemetryBySession.get(sessionKey);
  if (!current || current.firstTokenTracked) {
    return;
  }
  const durationMs = Math.max(0, nowTelemetryMs() - current.startedAt);
  trackUiTiming('chat.send_to_first_token', durationMs, {
    sessionKey,
    source,
    hasRunId: Boolean(current.runId),
  });
  chatRunTelemetryBySession.set(sessionKey, {
    ...current,
    firstTokenTracked: true,
  });
}

export function beginFinalToHistoryTelemetry(sessionKey: string): void {
  const current = chatRunTelemetryBySession.get(sessionKey);
  if (!current) {
    return;
  }
  chatRunTelemetryBySession.set(sessionKey, {
    ...current,
    finalEventAt: nowTelemetryMs(),
  });
}

export function maybeTrackFinalToHistoryVisible(
  sessionKey: string,
  payload: { rowCount: number; changed: boolean },
): void {
  const current = chatRunTelemetryBySession.get(sessionKey);
  if (!current || current.finalEventAt == null) {
    return;
  }
  const durationMs = Math.max(0, nowTelemetryMs() - current.finalEventAt);
  trackUiTiming('chat.final_to_history_visible', durationMs, {
    sessionKey,
    rowCount: payload.rowCount,
    messageListChanged: payload.changed,
    hadFirstToken: current.firstTokenTracked,
    hasRunId: Boolean(current.runId),
  });
  chatRunTelemetryBySession.set(sessionKey, {
    ...current,
    finalEventAt: null,
  });
}

export function finishChatRunTelemetry(
  sessionKey: string,
  reason: 'completed' | 'failed' | 'aborted',
  extra: Record<string, unknown> = {},
): void {
  const current = chatRunTelemetryBySession.get(sessionKey);
  if (!current) {
    return;
  }
  trackUiEvent('chat.send_lifecycle_end', {
    sessionKey,
    reason,
    hasRunId: Boolean(current.runId),
    gotFirstToken: current.firstTokenTracked,
    ...extra,
  });
  chatRunTelemetryBySession.delete(sessionKey);
}
