import type { GatewayRpcPort } from '../gateway/gateway-runtime-port';
import {
  TASK_MANAGER_GATEWAY_PLUGIN,
  type GatewayPluginCapabilityPort,
} from '../gateway/gateway-capability-service';
import { badRequest, ok, type ApplicationResponseOf } from '../common/application-response';
import type { RuntimeClockPort } from '../common/runtime-ports';
import type { BackgroundTaskManager } from '../../services/background-task-manager';
import type { TaskData, TaskSnapshotEvent, TodoItem } from '../../shared/session-adapter-types';

const TASK_RPC_TIMEOUT_MS = 60_000;
const TASK_CAPABILITY_TIMEOUT_MS = 5_000;

export class TaskManagerService {
  constructor(private readonly deps: {
    readonly gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
    readonly capabilities: GatewayPluginCapabilityPort;
    readonly clock: RuntimeClockPort;
    readonly backgroundTasks?: BackgroundTaskManager;
    readonly emitTaskSnapshot?: (event: TaskSnapshotEvent) => void;
  }) {}

  async list(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const sessionKey = this.readSessionKey(body);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    return await this.callTaskTool('TaskList', sessionKey, {
      sessionKey,
      ...this.readOptionalScopePayload(body),
    });
  }

  async get(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const sessionKey = this.readSessionKey(body);
    const taskId = this.readString(body.taskId);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (!taskId) {
      return badRequest('taskId is required');
    }
    return await this.callTaskTool('TaskGet', sessionKey, {
      sessionKey,
      taskId,
      ...this.readOptionalScopePayload(body),
    });
  }

  async create(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const sessionKey = this.readSessionKey(body);
    const subject = this.readString(body.subject);
    const description = typeof body.description === 'string' ? body.description : '';
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (!subject) {
      return badRequest('subject is required');
    }
    return await this.callTaskTool('TaskCreate', sessionKey, {
      sessionKey,
      subject,
      description,
      ...(this.readString(body.activeForm) ? { activeForm: this.readString(body.activeForm) } : {}),
      ...(this.readString(body.owner) ? { owner: this.readString(body.owner) } : {}),
      ...(this.isRecord(body.metadata) ? { metadata: body.metadata } : {}),
      ...this.readOptionalScopePayload(body),
    });
  }

  async update(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const sessionKey = this.readSessionKey(body);
    const taskId = this.readString(body.taskId);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (!taskId) {
      return badRequest('taskId is required');
    }
    return await this.callTaskTool('TaskUpdate', sessionKey, {
      sessionKey,
      taskId,
      ...(this.readString(body.status) ? { status: this.readString(body.status) } : {}),
      ...(this.readString(body.subject) ? { subject: this.readString(body.subject) } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(this.readString(body.activeForm) ? { activeForm: this.readString(body.activeForm) } : {}),
      ...(this.readString(body.owner) ? { owner: this.readString(body.owner) } : {}),
      ...(Array.isArray(body.addBlockedBy) ? { addBlockedBy: body.addBlockedBy } : {}),
      ...(Array.isArray(body.addBlocks) ? { addBlocks: body.addBlocks } : {}),
      ...(this.isRecord(body.metadata) ? { metadata: body.metadata } : {}),
      ...this.readOptionalScopePayload(body),
    });
  }

  async todoWrite(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const sessionKey = this.readSessionKey(body);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (!Array.isArray(body.newTodos)) {
      return badRequest('newTodos is required');
    }
    return await this.callTaskTool('TodoWrite', sessionKey, {
      sessionKey,
      ...(Array.isArray(body.oldTodos) ? { oldTodos: body.oldTodos } : {}),
      newTodos: body.newTodos,
      ...this.readOptionalScopePayload(body),
    });
  }

  async todoGet(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const sessionKey = this.readSessionKey(body);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    return await this.callTaskTool('TodoGet', sessionKey, {
      sessionKey,
      ...this.readOptionalScopePayload(body),
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

  async buildTaskSnapshot(sessionKey: string): Promise<TaskSnapshotEvent | null> {
    const normalizedSessionKey = this.readString(sessionKey);
    if (!normalizedSessionKey) {
      return null;
    }
    const unavailable = await this.deps.capabilities.requirePluginMethod(
      TASK_MANAGER_GATEWAY_PLUGIN,
      'TaskList',
      TASK_CAPABILITY_TIMEOUT_MS,
    );
    if (unavailable) {
      return null;
    }
    const data = await this.deps.gateway.gatewayRpc('TaskList', { sessionKey: normalizedSessionKey }, TASK_RPC_TIMEOUT_MS);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }
    const record = data as Record<string, unknown>;
    return {
      sessionKey: normalizedSessionKey,
      tasks: this.readTaskList(record.tasks),
      todos: this.readTodoList(record.todos),
      source: 'replay',
      enableEdit: false,
      uri: `agent:///${normalizedSessionKey}/tasks/${normalizedSessionKey}`,
    };
  }

  emitSnapshot(event: TaskSnapshotEvent): void {
    this.deps.emitTaskSnapshot?.(event);
  }

  private async callTaskTool(
    method: string,
    sessionKey: string,
    params: Record<string, unknown>,
  ): Promise<ApplicationResponseOf> {
    const unavailable = await this.deps.capabilities.requirePluginMethod(
      TASK_MANAGER_GATEWAY_PLUGIN,
      method,
      TASK_CAPABILITY_TIMEOUT_MS,
    );
    if (unavailable) {
      return unavailable;
    }
    const data = await this.deps.gateway.gatewayRpc(method, params, TASK_RPC_TIMEOUT_MS);
    this.emitSnapshotFromToolResult(method, sessionKey, data);
    return ok(data);
  }

  private emitSnapshotFromToolResult(method: string, sessionKey: string, data: unknown): void {
    if (!this.deps.emitTaskSnapshot || !data || typeof data !== 'object' || Array.isArray(data)) {
      return;
    }
    const record = data as Record<string, unknown>;
    const tasks = [
      ...this.readTaskList(record.tasks),
      ...this.readTaskList(record.task ? [record.task] : []),
    ];
    const todos = this.readTodoList(record.todos);
    const deletedTaskId = record.deleted === true ? this.readString(record.taskId) : '';
    const eventTasks = deletedTaskId
      ? [{ id: deletedTaskId, subject: deletedTaskId, description: '', status: 'deleted' as const, blocks: [], blockedBy: [] }]
      : tasks;
    if (eventTasks.length === 0 && todos.length === 0) {
      return;
    }
    this.deps.emitTaskSnapshot({
      sessionKey,
      tasks: eventTasks,
      ...(todos.length > 0 || method === 'TodoWrite' || method === 'TodoGet' ? { todos } : {}),
      source: method === 'TodoWrite' || method === 'TodoGet' ? 'todo' : 'tool',
    });
  }

  private readOptionalScopePayload(body: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(this.readString(body.workspaceDir) ? { workspaceDir: this.readString(body.workspaceDir) } : {}),
      ...(this.readString(body.teamKey) ? { teamKey: this.readString(body.teamKey) } : {}),
    };
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

  private readTaskList(value: unknown): TaskData[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.flatMap((item): TaskData[] => {
      const task = this.readRecord(item);
      const id = this.readString(task.id);
      const subject = this.readString(task.subject ?? task.content);
      if (!id || !subject) {
        return [];
      }
      const status = task.status === 'in_progress' || task.status === 'completed' || task.status === 'deleted'
        ? task.status
        : 'pending';
      return [{
        id,
        subject,
        description: typeof task.description === 'string' ? task.description : '',
        ...(this.readString(task.activeForm) ? { activeForm: this.readString(task.activeForm) } : {}),
        status,
        ...(this.isRecord(task.metadata) ? { metadata: task.metadata } : {}),
        ...(this.readString(task.owner) ? { owner: this.readString(task.owner) } : {}),
        blocks: Array.isArray(task.blocks) ? task.blocks.filter((entry): entry is string => typeof entry === 'string') : [],
        blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.filter((entry): entry is string => typeof entry === 'string') : [],
        ...(typeof task.createdAt === 'number' ? { createdAt: task.createdAt } : {}),
        ...(typeof task.updatedAt === 'number' ? { updatedAt: task.updatedAt } : {}),
      }];
    });
  }

  private readTodoList(value: unknown): TodoItem[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.flatMap((item): TodoItem[] => {
      const todo = this.readRecord(item);
      const content = this.readString(todo.content ?? todo.subject);
      if (!content) {
        return [];
      }
      const status = todo.status === 'in_progress' || todo.status === 'completed' || todo.status === 'deleted'
        ? todo.status
        : 'pending';
      return [{
        ...(this.readString(todo.id) ? { id: this.readString(todo.id) } : {}),
        content,
        ...(this.readString(todo.activeForm) ? { activeForm: this.readString(todo.activeForm) } : {}),
        status,
        ...(this.readString(todo.owner) ? { owner: this.readString(todo.owner) } : {}),
      }];
    });
  }
}
