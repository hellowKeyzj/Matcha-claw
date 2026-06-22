import { ok, type ApplicationResponseOf } from '../../common/application-response';
import type { RuntimeClockPort } from '../../common/runtime-ports';
import {
  SUBAGENT_GATEWAY_PLUGIN,
  type GatewayPluginCapabilityPort,
} from '../../gateway/gateway-capability-service';
import type { GatewayRpcPort } from '../../gateway/gateway-runtime-port';
const SUBAGENT_RPC_TIMEOUT_MS = 60_000;
const SUBAGENT_CAPABILITY_TIMEOUT_MS = 5_000;
type SnapshotKind = 'agents.list' | 'config.get';
export type SubagentWorkspaceInitialization = 'mainAgentTemplate' | 'emptyWorkspace';

export interface SubagentWorkspacePort {
  initializeAgentWorkspace(workspaceDir: string, options: { createDir?: boolean; workspaceInitialization: SubagentWorkspaceInitialization }): Promise<unknown>;
}

export interface SubagentRuntimeWorkflowDeps {
  readonly gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
  readonly capabilities: GatewayPluginCapabilityPort;
  readonly workspace: SubagentWorkspacePort;
  readonly clock: RuntimeClockPort;
}

export class SubagentRuntimeWorkflow {
  private snapshotByMethod = new Map<SnapshotKind, {
    value: unknown;
    updatedAt: number;
  }>();
  private refreshTaskByMethod = new Map<SnapshotKind, Promise<unknown>>();
  private errorByMethod = new Map<SnapshotKind, string>();
  private snapshotGeneration = 0;

  constructor(private readonly deps: SubagentRuntimeWorkflowDeps) {}

  async snapshot(method: SnapshotKind, emptyPayload: Record<string, unknown>): Promise<ApplicationResponseOf> {
    const unavailable = await this.deps.capabilities.requirePluginMethod(
      SUBAGENT_GATEWAY_PLUGIN,
      method,
      SUBAGENT_CAPABILITY_TIMEOUT_MS,
    );
    if (unavailable) {
      return unavailable;
    }

    const cached = this.snapshotByMethod.get(method);
    void this.refreshSnapshot(method);
    if (cached) {
      return ok(this.toSnapshotPayload(cached.value, {
        ready: true,
        refreshing: this.refreshTaskByMethod.has(method),
        updatedAt: cached.updatedAt,
        error: this.errorByMethod.get(method) ?? null,
      }));
    }

    return ok({
      success: true,
      ...emptyPayload,
      ready: false,
      refreshing: true,
      updatedAt: null,
      error: this.errorByMethod.get(method) ?? null,
    });
  }

  async call(
    method: string,
    params: Record<string, unknown>,
    options?: { invalidateSnapshots?: boolean },
  ): Promise<ApplicationResponseOf> {
    const unavailable = await this.deps.capabilities.requirePluginMethod(
      SUBAGENT_GATEWAY_PLUGIN,
      method,
      SUBAGENT_CAPABILITY_TIMEOUT_MS,
    );
    if (unavailable) {
      return unavailable;
    }
    const result = await this.deps.gateway.gatewayRpc(method, params, SUBAGENT_RPC_TIMEOUT_MS);
    if (options?.invalidateSnapshots === true) {
      this.clearSnapshots();
    }
    return ok(result);
  }

  async createAgent(
    params: Record<string, unknown>,
    options: { workspaceDir: string; workspaceInitialization: SubagentWorkspaceInitialization },
  ): Promise<ApplicationResponseOf> {
    const response = await this.call('agents.create', params, { invalidateSnapshots: true });
    if (response.status !== 200) {
      return response;
    }
    await this.deps.workspace.initializeAgentWorkspace(options.workspaceDir, {
      createDir: true,
      workspaceInitialization: options.workspaceInitialization,
    });
    return response;
  }

  private refreshSnapshot(method: SnapshotKind): Promise<unknown> {
    const current = this.refreshTaskByMethod.get(method);
    if (current) {
      return current;
    }

    const generation = this.snapshotGeneration;
    const task = this.deps.gateway.gatewayRpc(method, {}, SUBAGENT_RPC_TIMEOUT_MS)
      .then((value) => {
        if (generation !== this.snapshotGeneration) {
          return value;
        }
        this.snapshotByMethod.set(method, {
          value,
          updatedAt: this.deps.clock.nowMs(),
        });
        this.errorByMethod.delete(method);
        return value;
      })
      .catch((error) => {
        if (generation === this.snapshotGeneration) {
          this.errorByMethod.set(method, error instanceof Error ? error.message : String(error));
        }
        return null;
      })
      .finally(() => {
        if (generation === this.snapshotGeneration && this.refreshTaskByMethod.get(method) === task) {
          this.refreshTaskByMethod.delete(method);
        }
      });

    this.refreshTaskByMethod.set(method, task);
    return task;
  }

  private toSnapshotPayload(
    value: unknown,
    meta: { ready: boolean; refreshing: boolean; updatedAt: number | null; error: string | null },
  ): Record<string, unknown> {
    return {
      success: true,
      ...(this.readRecord(value)),
      ...meta,
    };
  }

  private clearSnapshots(): void {
    this.snapshotGeneration += 1;
    this.snapshotByMethod.clear();
    this.errorByMethod.clear();
    this.refreshTaskByMethod.clear();
  }

  private readRecord(value: unknown): Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }
}
