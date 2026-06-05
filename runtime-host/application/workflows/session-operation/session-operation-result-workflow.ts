import type {
  SessionStateSnapshot,
} from '../../../shared/session-adapter-types';
import type {
  SessionOperationKind,
  SessionOperationResult,
} from '../../sessions/session-operation-coordinator';

export class SessionOperationResultWorkflow {
  private readonly latestResults = new Map<string, SessionOperationResult>();

  getLatestResult(sessionKey: string): SessionOperationResult | null {
    return this.latestResults.get(sessionKey) ?? null;
  }

  rememberResult(input: {
    sessionKey: string;
    operationId: string;
    kind: SessionOperationKind;
    result: unknown;
  }): void {
    const snapshot = this.readSnapshot(input.result);
    if (!snapshot) {
      return;
    }
    this.latestResults.set(input.sessionKey, {
      sessionKey: input.sessionKey,
      operationId: input.operationId,
      kind: input.kind,
      snapshot,
    });
  }

  private readSnapshot(value: unknown): SessionStateSnapshot | null {
    if (isSessionStateSnapshot(value)) {
      return value;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const snapshot = record.snapshot;
    if (isSessionStateSnapshot(snapshot)) {
      return snapshot;
    }
    const data = record.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const dataSnapshot = (data as Record<string, unknown>).snapshot;
      if (isSessionStateSnapshot(dataSnapshot)) {
        return dataSnapshot;
      }
    }
    return null;
  }
}

function isSessionStateSnapshot(value: unknown): value is SessionStateSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.sessionKey === 'string'
    && Boolean(record.runtime)
    && Array.isArray(record.items);
}
