import type { RuntimeJobQueryPort } from './runtime-task-ports';
import type { RuntimeJobQueueSnapshot, RuntimeJobSnapshot } from '../common/runtime-contracts';

export interface RuntimeJobsListResult {
  readonly success: true;
  readonly queue: RuntimeJobQueueSnapshot;
  readonly registeredTypes: string[];
  readonly jobs: RuntimeJobSnapshot[];
}

export interface RuntimeJobLookupResult {
  readonly success: true;
  readonly job: RuntimeJobSnapshot | null;
}

export class RuntimeJobsService {
  constructor(private readonly jobs: RuntimeJobQueryPort) {}

  list(type?: string): RuntimeJobsListResult {
    const normalizedType = typeof type === 'string' && type.trim() ? type.trim() : '';
    return {
      success: true,
      queue: this.jobs.snapshotQueue(),
      registeredTypes: this.jobs.listRegisteredTypes(),
      jobs: normalizedType ? this.jobs.listByType(normalizedType) : this.jobs.list(),
    };
  }

  get(jobId: string): RuntimeJobLookupResult {
    return {
      success: true,
      job: this.jobs.get(jobId),
    };
  }
}
