import type { GatewayRpcPort } from '../gateway/gateway-runtime-port';
import {
  TASK_MANAGER_GATEWAY_PLUGIN,
  type GatewayPluginCapabilityPort,
} from '../gateway/gateway-capability-service';
import { badRequest, ok, type ApplicationResponseOf } from '../common/application-response';
import type { RuntimeClockPort } from '../common/runtime-ports';

const TASK_RPC_TIMEOUT_MS = 60_000;
const TASK_CAPABILITY_TIMEOUT_MS = 5_000;

export class TaskManagerService {
  private listSnapshotByScope = new Map<string, {
    value: unknown;
    updatedAt: number;
  }>();
  private listRefreshTaskByScope = new Map<string, Promise<unknown>>();
  private listErrorByScope = new Map<string, string>();

  constructor(private readonly deps: {
    readonly gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
    readonly capabilities: GatewayPluginCapabilityPort;
    readonly clock: RuntimeClockPort;
  }) {}

  async list(payload: unknown): Promise<ApplicationResponseOf> {
    const params = this.readScopePayload(payload);
    const unavailable = await this.deps.capabilities.requirePluginMethod(
      TASK_MANAGER_GATEWAY_PLUGIN,
      'task_manager.list',
      TASK_CAPABILITY_TIMEOUT_MS,
    );
    if (unavailable) {
      return unavailable;
    }

    const scopeKey = this.listScopeKey(params);
    const cached = this.listSnapshotByScope.get(scopeKey);
    void this.refreshListSnapshot(scopeKey, params);
    if (cached) {
      return ok(this.toSnapshotPayload(cached.value, {
        ready: true,
        refreshing: this.listRefreshTaskByScope.has(scopeKey),
        updatedAt: cached.updatedAt,
        error: this.listErrorByScope.get(scopeKey) ?? null,
      }));
    }

    return ok({
      success: true,
      tasks: [],
      ready: false,
      refreshing: true,
      updatedAt: null,
      error: this.listErrorByScope.get(scopeKey) ?? null,
    });
  }

  async get(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const taskId = this.readString(body.taskId);
    if (!taskId) {
      return badRequest('taskId is required');
    }
    return await this.call('task_manager.get', {
      taskId,
      ...this.readScopePayload(payload),
    });
  }

  async create(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const subject = this.readString(body.subject);
    const description = typeof body.description === 'string' ? body.description : '';
    if (!subject) {
      return badRequest('subject is required');
    }
    return await this.call('task_manager.create', {
      subject,
      description,
      ...(this.readString(body.activeForm) ? { activeForm: this.readString(body.activeForm) } : {}),
      ...(this.isRecord(body.metadata) ? { metadata: body.metadata } : {}),
      ...this.readScopePayload(payload),
    }, { invalidateListSnapshots: true });
  }

  async update(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const taskId = this.readString(body.taskId);
    if (!taskId) {
      return badRequest('taskId is required');
    }
    return await this.call('task_manager.update', {
      taskId,
      ...(this.readString(body.status) ? { status: this.readString(body.status) } : {}),
      ...(this.readString(body.subject) ? { subject: this.readString(body.subject) } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(body.activeForm !== undefined ? { activeForm: body.activeForm } : {}),
      ...(body.owner !== undefined ? { owner: body.owner } : {}),
      ...(Array.isArray(body.addBlockedBy) ? { addBlockedBy: body.addBlockedBy } : {}),
      ...(Array.isArray(body.addBlocks) ? { addBlocks: body.addBlocks } : {}),
      ...(this.isRecord(body.metadata) ? { metadata: body.metadata } : {}),
      ...this.readScopePayload(payload),
    }, { invalidateListSnapshots: true });
  }

  async claim(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const taskId = this.readString(body.taskId);
    if (!taskId) {
      return badRequest('taskId is required');
    }
    return await this.call('task_manager.claim', {
      taskId,
      ...(this.readString(body.owner) ? { owner: this.readString(body.owner) } : {}),
      ...(this.readString(body.sessionKey) ? { sessionKey: this.readString(body.sessionKey) } : {}),
      ...this.readScopePayload(payload),
    }, { invalidateListSnapshots: true });
  }

  private async call(
    method: string,
    params: Record<string, unknown>,
    options?: { invalidateListSnapshots?: boolean },
  ): Promise<ApplicationResponseOf> {
    const unavailable = await this.deps.capabilities.requirePluginMethod(
      TASK_MANAGER_GATEWAY_PLUGIN,
      method,
      TASK_CAPABILITY_TIMEOUT_MS,
    );
    if (unavailable) {
      return unavailable;
    }
    const result = await this.deps.gateway.gatewayRpc(method, params, TASK_RPC_TIMEOUT_MS);
    if (options?.invalidateListSnapshots === true) {
      this.clearListSnapshots();
    }
    return ok(result);
  }

  private refreshListSnapshot(scopeKey: string, params: Record<string, unknown>): Promise<unknown> {
    const current = this.listRefreshTaskByScope.get(scopeKey);
    if (current) {
      return current;
    }

    const task = this.deps.gateway.gatewayRpc('task_manager.list', params, TASK_RPC_TIMEOUT_MS)
      .then((value) => {
        this.listSnapshotByScope.set(scopeKey, {
          value,
          updatedAt: this.deps.clock.nowMs(),
        });
        this.listErrorByScope.delete(scopeKey);
        return value;
      })
      .catch((error) => {
        this.listErrorByScope.set(scopeKey, error instanceof Error ? error.message : String(error));
        return null;
      })
      .finally(() => {
        if (this.listRefreshTaskByScope.get(scopeKey) === task) {
          this.listRefreshTaskByScope.delete(scopeKey);
        }
      });

    this.listRefreshTaskByScope.set(scopeKey, task);
    return task;
  }

  private toSnapshotPayload(
    value: unknown,
    meta: { ready: boolean; refreshing: boolean; updatedAt: number | null; error: string | null },
  ): Record<string, unknown> {
    return {
      success: true,
      ...(this.isRecord(value) ? value : { result: value }),
      ...meta,
    };
  }

  private clearListSnapshots(): void {
    this.listSnapshotByScope.clear();
    this.listErrorByScope.clear();
  }

  private listScopeKey(params: Record<string, unknown>): string {
    return [
      this.readString(params.workspaceDir),
      this.readString(params.taskListId),
    ].join('\n');
  }

  private readScopePayload(payload: unknown): Record<string, unknown> {
    const body = this.readRecord(payload);
    return {
      ...(this.readString(body.workspaceDir) ? { workspaceDir: this.readString(body.workspaceDir) } : {}),
      ...(this.readString(body.taskListId) ? { taskListId: this.readString(body.taskListId) } : {}),
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
}
