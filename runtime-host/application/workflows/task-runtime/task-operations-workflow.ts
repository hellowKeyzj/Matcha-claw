import { badRequest, ok, type ApplicationResponseOf } from '../../common/application-response';
import type { BackgroundTaskManager } from '../../../services/background-task-manager';
import type { TaskSnapshotEvent } from '../../../shared/session-adapter-types';
import type { TaskRuntimeWorkflow } from './task-runtime-workflow';

const TASK_TOOL_METHODS = new Set(['TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate', 'TodoWrite', 'TodoGet']);

export interface TaskOperationsWorkflowDeps {
  readonly runtimeWorkflow: Pick<TaskRuntimeWorkflow, 'callTaskTool' | 'buildTaskSnapshot' | 'emitSnapshot'>;
  readonly backgroundTasks?: BackgroundTaskManager;
}

export class TaskOperationsWorkflow {
  constructor(private readonly deps: TaskOperationsWorkflowDeps) {}

  async invokeTool(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const method = this.readString(body.method);
    if (!method) {
      return badRequest('method is required');
    }
    if (!TASK_TOOL_METHODS.has(method)) {
      return badRequest(`Task tool method not supported: ${method}`);
    }
    const params = this.readRecord(body.params);
    const sessionKey = this.readSessionKey(params) || this.readSessionKey(body);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    const validationError = this.validateTaskToolParams(method, params);
    if (validationError) {
      return badRequest(validationError);
    }
    return await this.deps.runtimeWorkflow.callTaskTool(method, sessionKey, {
      ...params,
      sessionKey,
    });
  }

  async output(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const taskId = this.readString(body.taskId);
    if (!taskId) {
      return badRequest('taskId is required');
    }
    const task = await this.deps.backgroundTasks?.output(taskId, {
      wait: body.wait === true,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
    }) ?? null;
    if (!task) {
      return ok({
        success: false,
        status: 'not_found',
        taskId,
        message: `Background task not found: ${taskId}`,
      });
    }
    return ok({
      success: true,
      task,
      ...(task.status === 'running'
        ? { message: 'Task is still running. Call TaskOutput again to read later output.' }
        : {}),
    });
  }

  async stop(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const taskId = this.readString(body.taskId);
    if (!taskId) {
      return badRequest('taskId is required');
    }
    const result = await this.deps.backgroundTasks?.stop(taskId) ?? { success: false, task: null };
    return ok({
      success: result.success,
      task: result.task,
      ...(result.success ? {} : { message: `Background task cannot be stopped or was not found: ${taskId}` }),
    });
  }

  async buildTaskSnapshot(input: string | { sessionKey: string; teamKey?: string }): Promise<TaskSnapshotEvent | null> {
    return await this.deps.runtimeWorkflow.buildTaskSnapshot(input);
  }

  emitSnapshot(event: TaskSnapshotEvent): void {
    this.deps.runtimeWorkflow.emitSnapshot(event);
  }

  private validateTaskToolParams(method: string, params: Record<string, unknown>): string | null {
    if (method === 'TaskGet' || method === 'TaskUpdate') {
      return this.readString(params.taskId) ? null : 'taskId is required';
    }
    if (method === 'TaskCreate') {
      return this.readString(params.subject) ? null : 'subject is required';
    }
    if (method === 'TodoWrite') {
      if (!Array.isArray(params.oldTodos)) {
        return 'oldTodos is required';
      }
      if (!Array.isArray(params.newTodos)) {
        return 'newTodos is required';
      }
    }
    return null;
  }

  private readSessionKey(body: Record<string, unknown>): string {
    return this.readString(body.sessionKey);
  }

  private readRecord(value: unknown): Record<string, unknown> {
    return this.isRecord(value) ? value : {};
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }
}
