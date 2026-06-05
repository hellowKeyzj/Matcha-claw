import type { ApplicationResponseOf } from '../common/application-response';
import type { TaskSnapshotEvent } from '../../shared/session-adapter-types';
import type { TaskOperationsWorkflow } from '../workflows/task-runtime/task-operations-workflow';

export class TaskManagerService {
  constructor(private readonly operationsWorkflow: Pick<
    TaskOperationsWorkflow,
    'invokeTool' | 'output' | 'stop' | 'buildTaskSnapshot' | 'emitSnapshot'
  >) {}

  async invokeTool(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.operationsWorkflow.invokeTool(payload);
  }

  async output(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.operationsWorkflow.output(payload);
  }

  async stop(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.operationsWorkflow.stop(payload);
  }

  async buildTaskSnapshot(input: string | { sessionKey: string; teamKey?: string }): Promise<TaskSnapshotEvent | null> {
    return await this.operationsWorkflow.buildTaskSnapshot(input);
  }

  emitSnapshot(event: TaskSnapshotEvent): void {
    this.operationsWorkflow.emitSnapshot(event);
  }
}
