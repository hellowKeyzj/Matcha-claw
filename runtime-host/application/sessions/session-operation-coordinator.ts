import type {
  SessionStateSnapshot,
} from '../../shared/session-adapter-types';
import type { SessionOperationResultWorkflow } from '../workflows/session-operation/session-operation-result-workflow';

export type SessionOperationKind = 'prompt' | 'abort' | 'patch-model' | 'resume' | 'reconcile';

export interface SessionOperationResult {
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

  getLatestResult(sessionKey: string): SessionOperationResult | null {
    return this.resultWorkflow.getLatestResult(sessionKey);
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
      this.resultWorkflow.rememberResult({
        sessionKey,
        operationId,
        kind,
        result,
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
