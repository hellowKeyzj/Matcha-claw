import type { RuntimeJobEnqueueOptions } from '../common/runtime-contracts';
import type {
  RuntimeJobSubmissionQueuePort,
  RuntimeLongTaskSubmission,
  RuntimeLongTaskSubmissionPort,
} from './runtime-task-ports';

export class RuntimeLongTaskService implements RuntimeLongTaskSubmissionPort {
  constructor(private readonly jobQueue: RuntimeJobSubmissionQueuePort) {}

  submit(
    type: string,
    payload: unknown,
    options: RuntimeJobEnqueueOptions = {},
  ): RuntimeLongTaskSubmission {
    return {
      success: true,
      job: this.jobQueue.enqueue(type, payload, options),
    };
  }
}
