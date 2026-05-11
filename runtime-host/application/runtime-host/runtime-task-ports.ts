import type {
  RuntimeJobEnqueueOptions,
  RuntimeJobQueueSnapshot,
  RuntimeJobSnapshot,
} from '../common/runtime-contracts';

export interface RuntimeLongTaskSubmission {
  readonly success: true;
  readonly job: RuntimeJobSnapshot;
}

export interface RuntimeLongTaskSubmissionPort {
  submit(type: string, payload: unknown, options?: RuntimeJobEnqueueOptions): RuntimeLongTaskSubmission;
}

export interface RuntimeJobSubmissionQueuePort {
  enqueue(type: string, payload: unknown, options?: RuntimeJobEnqueueOptions): RuntimeJobSnapshot;
}

export interface RuntimeLongTaskLookupPort {
  latestByType(type: string): RuntimeJobSnapshot | null;
}

export interface RuntimeJobQueryPort {
  snapshotQueue(): RuntimeJobQueueSnapshot;
  listRegisteredTypes(): string[];
  list(): RuntimeJobSnapshot[];
  listByType(type: string): RuntimeJobSnapshot[];
  get(jobId: string): RuntimeJobSnapshot | null;
}
