import type { SessionUpdateEvent } from '../../../runtime-host/shared/session-adapter-types';

export const UNKNOWN_ABORTED_RUN_MARKER = '*';
const MAX_BLOCKED_SESSION_UPDATES_PER_RUN = 100;

export interface StoreSessionRunCache {
  nextSendGeneration: (sessionKey: string) => number;
  getSendGeneration: (sessionKey: string) => number;
  setAbortedRunMarker: (sessionKey: string, runId: string | null) => void;
  getAbortedRunMarker: (sessionKey: string) => string | null;
  queueBlockedSessionUpdate: (sessionKey: string, runId: string, event: SessionUpdateEvent) => void;
  takeBlockedSessionUpdates: (sessionKey: string, runId: string) => SessionUpdateEvent[];
}

export function createStoreSessionRunCache(): StoreSessionRunCache {
  const sendGenerationBySession = new Map<string, number>();
  const abortedRunMarkerBySession = new Map<string, string>();
  const blockedSessionUpdatesBySession = new Map<string, Map<string, SessionUpdateEvent[]>>();

  return {
    nextSendGeneration: (sessionKey) => {
      const nextGeneration = (sendGenerationBySession.get(sessionKey) ?? 0) + 1;
      sendGenerationBySession.set(sessionKey, nextGeneration);
      return nextGeneration;
    },
    getSendGeneration: (sessionKey) => sendGenerationBySession.get(sessionKey) ?? 0,
    setAbortedRunMarker: (sessionKey, runId) => {
      const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
      if (!normalizedRunId) {
        abortedRunMarkerBySession.delete(sessionKey);
        return;
      }
      abortedRunMarkerBySession.set(sessionKey, normalizedRunId);
    },
    getAbortedRunMarker: (sessionKey) => abortedRunMarkerBySession.get(sessionKey) ?? null,
    queueBlockedSessionUpdate: (sessionKey, runId, event) => {
      const normalizedRunId = runId.trim();
      if (!normalizedRunId) {
        return;
      }
      const byRunId = blockedSessionUpdatesBySession.get(sessionKey) ?? new Map<string, SessionUpdateEvent[]>();
      const queued = byRunId.get(normalizedRunId) ?? [];
      queued.push(event);
      if (queued.length > MAX_BLOCKED_SESSION_UPDATES_PER_RUN) {
        queued.shift();
      }
      byRunId.set(normalizedRunId, queued);
      blockedSessionUpdatesBySession.set(sessionKey, byRunId);
    },
    takeBlockedSessionUpdates: (sessionKey, runId) => {
      const normalizedRunId = runId.trim();
      if (!normalizedRunId) {
        return [];
      }
      const byRunId = blockedSessionUpdatesBySession.get(sessionKey);
      if (!byRunId) {
        return [];
      }
      const queued = byRunId.get(normalizedRunId) ?? [];
      byRunId.delete(normalizedRunId);
      if (byRunId.size === 0) {
        blockedSessionUpdatesBySession.delete(sessionKey);
      }
      return queued;
    },
  };
}
