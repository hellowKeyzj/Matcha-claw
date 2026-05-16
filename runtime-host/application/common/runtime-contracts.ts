export type RuntimeLifecycleState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export type RuntimeJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type RuntimeJobQueueName = 'critical' | 'default' | 'low';

export interface RuntimeJobProgress {
  readonly updatedAt: number;
  readonly percent?: number;
  readonly message?: string;
}

export interface RuntimeJobSnapshot {
  readonly id: string;
  readonly type: string;
  readonly queue: RuntimeJobQueueName;
  readonly status: RuntimeJobStatus;
  readonly queuedAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly progress?: RuntimeJobProgress;
  readonly result?: unknown;
  readonly error?: string;
}

export interface RuntimeJobQueueSnapshot {
  readonly stopped: boolean;
  readonly concurrency: number;
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly totalCount: number;
  readonly queues: Record<RuntimeJobQueueName, {
    readonly pendingCount: number;
  }>;
}

export interface RuntimeJobEnqueueOptions {
  readonly queue?: RuntimeJobQueueName;
  readonly dedupeKey?: string;
  readonly dedupeCooldownMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
}
