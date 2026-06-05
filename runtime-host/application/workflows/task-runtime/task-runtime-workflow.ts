import { ok, type ApplicationResponseOf } from '../../common/application-response';
import type { GatewayPluginCapabilityPort } from '../../gateway/gateway-capability-service';
import { TASK_MANAGER_GATEWAY_PLUGIN } from '../../gateway/gateway-capability-service';
import type { GatewayRpcPort } from '../../gateway/gateway-runtime-port';
import type { TaskData, TaskScopeSnapshot, TaskSnapshotEvent, TodoItem } from '../../../shared/session-adapter-types';
import { isTraceLogLevelEnabled } from '../../../shared/trace-log-level';
import { isTodoTaskToolName } from '../../../shared/task-tool-contract';

const TASK_RPC_TIMEOUT_MS = 60_000;
const TASK_CAPABILITY_TIMEOUT_MS = 5_000;
const TASK_WRITE_METHODS = new Set(['TaskCreate', 'TaskUpdate']);
const TODO_WRITE_METHODS = new Set(['TodoWrite']);

export interface TaskWorkspacePort {
  getWorkspaceDirForSession(sessionKey: string): Promise<string>;
}

export interface TaskRuntimeWorkflowDeps {
  readonly gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
  readonly capabilities: GatewayPluginCapabilityPort;
  readonly workspace: TaskWorkspacePort;
  readonly emitTaskSnapshot?: (event: TaskSnapshotEvent) => void;
}

export class TaskRuntimeWorkflow {
  constructor(private readonly deps: TaskRuntimeWorkflowDeps) {}

  async callTaskTool(
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
    logTaskPipeline('rpc.start', {
      method,
      sessionKey,
      paramSessionKey: typeof params.sessionKey === 'string' ? params.sessionKey : null,
      hasTeamKey: typeof params.teamKey === 'string' && params.teamKey.trim().length > 0,
    });
    const scopedParams = await this.buildScopedParams(sessionKey, params);
    const data = await this.deps.gateway.gatewayRpc(method, scopedParams, TASK_RPC_TIMEOUT_MS);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      logTaskPipeline('rpc.result', {
        method,
        sessionKey,
        tasksCount: Array.isArray(record.tasks) ? record.tasks.length : 0,
        taskCount: record.task ? 1 : 0,
        todosCount: Array.isArray(record.todos) ? record.todos.length : 0,
        deleted: record.deleted === true,
      });
    } else {
      logTaskPipeline('rpc.result', {
        method,
        sessionKey,
        resultType: Array.isArray(data) ? 'array' : typeof data,
      });
    }
    if (TASK_WRITE_METHODS.has(method)) {
      const scopedParams = this.extractSnapshotScopeParams(sessionKey, params);
      await this.emitAuthoritativeSnapshot(method, scopedParams);
    }
    if (TODO_WRITE_METHODS.has(method) && this.deps.emitTaskSnapshot && data && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      this.deps.emitTaskSnapshot({
        sessionKey,
        todos: this.readTodoList(record.todos),
        tasks: [],
        source: 'todo',
      });
    }
    return ok(data);
  }

  async buildTaskSnapshot(input: string | { sessionKey: string; teamKey?: string }): Promise<TaskSnapshotEvent | null> {
    const normalizedSessionKey = typeof input === 'string'
      ? this.readString(input)
      : this.readString(input.sessionKey);
    if (!normalizedSessionKey) {
      return null;
    }
    const scopePayload = typeof input === 'string'
      ? {}
      : { ...(this.readString(input.teamKey) ? { teamKey: this.readString(input.teamKey) } : {}) };
    const unavailable = await this.deps.capabilities.requirePluginMethod(
      TASK_MANAGER_GATEWAY_PLUGIN,
      'TaskList',
      TASK_CAPABILITY_TIMEOUT_MS,
    );
    if (unavailable) {
      return null;
    }
    const data = await this.deps.gateway.gatewayRpc(
      'TaskList',
      await this.buildScopedParams(normalizedSessionKey, { sessionKey: normalizedSessionKey, ...scopePayload }),
      TASK_RPC_TIMEOUT_MS,
    );
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }
    const record = data as Record<string, unknown>;
    const scope = this.readTaskScope(record.scope, normalizedSessionKey);
    return {
      sessionKey: normalizedSessionKey,
      scope,
      tasks: this.readTaskList(record.tasks),
      todos: this.readTodoList(record.todos),
      source: 'replay',
      enableEdit: false,
      uri: `agent:///${scope.key}/tasks/${scope.key}`,
    };
  }

  emitSnapshot(event: TaskSnapshotEvent): void {
    this.deps.emitTaskSnapshot?.(event);
  }

  private async emitAuthoritativeSnapshot(
    method: string,
    scopeParams: { sessionKey: string; teamKey?: string },
  ): Promise<void> {
    if (!this.deps.emitTaskSnapshot) {
      return;
    }
    const snapshot = await this.buildTaskSnapshot(scopeParams);
    if (!snapshot) {
      return;
    }
    const source: TaskSnapshotEvent['source'] = isTodoTaskToolName(method) ? 'todo' : 'tool';
    logTaskPipeline('snapshot.emit', {
      method,
      sessionKey: scopeParams.sessionKey,
      teamKey: scopeParams.teamKey ?? null,
      scopeKey: snapshot.scope?.key ?? null,
      tasksCount: snapshot.tasks.length,
      todosCount: snapshot.todos?.length ?? 0,
      source,
    });
    this.deps.emitTaskSnapshot({ ...snapshot, source });
  }

  private extractSnapshotScopeParams(
    sessionKey: string,
    params: Record<string, unknown>,
  ): { sessionKey: string; teamKey?: string } {
    const teamKey = this.readString(params.teamKey);
    return {
      sessionKey,
      ...(teamKey ? { teamKey } : {}),
    };
  }

  private async buildScopedParams(sessionKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {
      ...params,
      workspaceDir: this.readString(params.workspaceDir) || await this.deps.workspace.getWorkspaceDirForSession(sessionKey),
    };
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

  private readTaskScope(value: unknown, fallbackSessionKey: string): TaskScopeSnapshot {
    if (this.isRecord(value)) {
      const key = this.readString(value.key);
      const type = value.type === 'team' ? 'team' : 'session';
      const label = this.readString(value.label) || key || fallbackSessionKey;
      if (key) {
        return {
          type,
          key,
          label,
          ...(this.readString(value.sessionKey) ? { sessionKey: this.readString(value.sessionKey) } : {}),
          ...(this.readString(value.teamKey) ? { teamKey: this.readString(value.teamKey) } : {}),
          ...(this.readString(value.agentId) ? { agentId: this.readString(value.agentId) } : {}),
        };
      }
    }
    const agentId = /^agent:([^:]+):/.exec(fallbackSessionKey)?.[1];
    return {
      type: 'session',
      key: fallbackSessionKey,
      label: agentId ? `${agentId} · ${fallbackSessionKey.split(':').slice(2).join(':') || 'main'}` : fallbackSessionKey,
      sessionKey: fallbackSessionKey,
      ...(agentId ? { agentId } : {}),
    };
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

function logTaskPipeline(event: string, payload: Record<string, unknown>): void {
  if (!isTraceLogLevelEnabled(process.env.MATCHACLAW_TRACE_LOG_LEVEL, 2)) {
    return;
  }
  console.info(`[task-pipeline] runtime-host.${event}`, payload);
}
