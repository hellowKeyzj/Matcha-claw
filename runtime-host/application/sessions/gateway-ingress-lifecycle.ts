import {
  normalizeString,
} from './session-value-normalization';
import type {
  GatewayConversationLifecyclePayload,
  SessionInfoIngressEvent,
} from './gateway-ingress-types';
import type { RuntimeClockPort } from '../common/runtime-ports';

function normalizeSessionPhase(value: unknown): SessionInfoIngressEvent['phase'] {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'started' || normalized === 'start') {
    return 'started';
  }
  if (normalized === 'completed' || normalized === 'done' || normalized === 'finished' || normalized === 'final' || normalized === 'end') {
    return 'final';
  }
  if (normalized === 'error' || normalized === 'failed') {
    return 'error';
  }
  if (normalized === 'aborted' || normalized === 'abort' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'aborted';
  }
  return 'unknown';
}

export function buildLifecycleIngressEvent(
  payload: GatewayConversationLifecyclePayload,
  clock: RuntimeClockPort,
): SessionInfoIngressEvent {
  const errorMessage = normalizeString(payload.errorMessage) || normalizeString(payload.error);
  return {
    sessionUpdate: 'session_info_update',
    sessionKey: normalizeString(payload.sessionKey) || null,
    runId: normalizeString(payload.runId) || null,
    phase: normalizeSessionPhase(payload.phase),
    error: errorMessage || null,
    ...(errorMessage
      ? {
          transportIssue: {
            message: errorMessage,
            source: 'runtime' as const,
            at: clock.nowMs(),
            ...(normalizeString((payload as Record<string, unknown>).errorCode)
              ? { code: normalizeString((payload as Record<string, unknown>).errorCode) }
              : {}),
            ...((payload as Record<string, unknown>).errorDetails !== undefined
              ? { details: (payload as Record<string, unknown>).errorDetails }
              : {}),
          },
        }
      : {}),
  };
}
