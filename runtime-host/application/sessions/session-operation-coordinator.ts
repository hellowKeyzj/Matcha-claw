import type {
  SessionStateSnapshot,
} from '../../shared/session-adapter-types';
import {
  buildSessionIdentityKey,
  type SessionIdentity,
} from '../agent-runtime/contracts/runtime-address';
import type { SessionOperationResultWorkflow } from '../workflows/session-operation/session-operation-result-workflow';

export type SessionOperationKind = 'prompt' | 'abort' | 'patch-model' | 'resume' | 'reconcile';

export interface SessionOperationResult {
  identityKey: string;
  sessionIdentity: SessionIdentity;
  sessionKey: string;
  operationId: string;
  kind: SessionOperationKind;
  snapshot: SessionStateSnapshot;
}

export class SessionOperationCoordinator {
  private readonly queues = new Map<string, Promise<void>>();
  private nextOperationSequence = 0;

  constructor(
    private readonly resultWorkflow: Pick<SessionOperationResultWorkflow, 'getLatestResult' | 'rememberResult'>,
  ) {}

  getLatestResult(sessionIdentity: SessionIdentity): SessionOperationResult | null {
    return this.resultWorkflow.getLatestResult(sessionIdentity);
  }

  async run<T>(sessionIdentity: SessionIdentity, operation: () => Promise<T>): Promise<T>;
  async run<T>(sessionIdentity: SessionIdentity, kind: SessionOperationKind, operation: () => Promise<T>): Promise<T>;
  async run<T>(
    sessionIdentity: SessionIdentity,
    kindOrOperation: SessionOperationKind | (() => Promise<T>),
    maybeOperation?: () => Promise<T>,
  ): Promise<T> {
    const kind = typeof kindOrOperation === 'function' ? 'reconcile' : kindOrOperation;
    const operation = typeof kindOrOperation === 'function' ? kindOrOperation : maybeOperation;
    if (!operation) {
      throw new Error('session operation is required');
    }
    const identityKey = buildSessionIdentityKey(sessionIdentity);
    const operationId = `${kind}:${++this.nextOperationSequence}`;
    const previous = this.queues.get(identityKey) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    this.queues.set(identityKey, tail);
    await previous.catch(() => undefined);
    try {
      const result = await operation();
      this.resultWorkflow.rememberResult({
        identityKey,
        sessionIdentity,
        operationId,
        kind,
        result,
      });
      return result;
    } finally {
      release();
      if (this.queues.get(identityKey) === tail) {
        this.queues.delete(identityKey);
      }
    }
  }
}
