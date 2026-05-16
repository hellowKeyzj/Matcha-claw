import type {
  SessionStateSnapshot,
} from '../../shared/session-adapter-types';

export type SessionOperationKind = 'prompt' | 'abort' | 'patch-model' | 'resume' | 'reconcile';

export interface SessionOperationResult {
  sessionKey: string;
  operationId: string;
  kind: SessionOperationKind;
  snapshot: SessionStateSnapshot;
}

export class SessionOperationCoordinator {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly latestResults = new Map<string, SessionOperationResult>();
  private nextOperationSequence = 0;

  getLatestResult(sessionKey: string): SessionOperationResult | null {
    return this.latestResults.get(sessionKey) ?? null;
  }

  private readSnapshot(value: unknown): SessionStateSnapshot | null {
    if (this.isSessionStateSnapshot(value)) {
      return value;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const snapshot = record.snapshot;
    if (this.isSessionStateSnapshot(snapshot)) {
      return snapshot;
    }
    const data = record.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const dataSnapshot = (data as Record<string, unknown>).snapshot;
      if (this.isSessionStateSnapshot(dataSnapshot)) {
        return dataSnapshot;
      }
    }
    return null;
  }

  private isSessionStateSnapshot(value: unknown): value is SessionStateSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record.sessionKey === 'string'
      && Boolean(record.runtime)
      && Array.isArray(record.items);
  }

  private rememberResult(input: {
    sessionKey: string;
    operationId: string;
    kind: SessionOperationKind;
    snapshot: SessionStateSnapshot | null;
  }): void {
    if (!input.snapshot) {
      return;
    }
    this.latestResults.set(input.sessionKey, {
      sessionKey: input.sessionKey,
      operationId: input.operationId,
      kind: input.kind,
      snapshot: input.snapshot,
    });
  }

  async run<T>(sessionKey: string, operation: () => Promise<T>): Promise<T>;
  async run<T>(sessionKey: string, kind: SessionOperationKind, operation: () => Promise<T>): Promise<T>;
  async run<T>(
    sessionKey: string,
    kindOrOperation: SessionOperationKind | (() => Promise<T>),
    maybeOperation?: () => Promise<T>,
  ): Promise<T> {
    const kind = typeof kindOrOperation === 'function' ? 'reconcile' : kindOrOperation;
    const operation = typeof kindOrOperation === 'function' ? kindOrOperation : maybeOperation;
    if (!operation) {
      throw new Error('session operation is required');
    }
    const operationId = `${kind}:${++this.nextOperationSequence}`;
    const previous = this.queues.get(sessionKey) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    this.queues.set(sessionKey, tail);
    await previous.catch(() => undefined);
    try {
      const result = await operation();
      this.rememberResult({
        sessionKey,
        operationId,
        kind,
        snapshot: this.readSnapshot(result),
      });
      return result;
    } finally {
      release();
      if (this.queues.get(sessionKey) === tail) {
        this.queues.delete(sessionKey);
      }
    }
  }
}
