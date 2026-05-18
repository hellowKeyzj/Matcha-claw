import type { GatewayRpcPort } from '../gateway/gateway-runtime-port';
import {
  SUBAGENT_GATEWAY_PLUGIN,
  type GatewayPluginCapabilityPort,
} from '../gateway/gateway-capability-service';
import { badRequest, ok, type ApplicationResponseOf } from '../common/application-response';
import type { RuntimeClockPort } from '../common/runtime-ports';
import type { OpenClawWorkspacePort } from '../openclaw/openclaw-workspace-service';

const SUBAGENT_RPC_TIMEOUT_MS = 60_000;
const SUBAGENT_CAPABILITY_TIMEOUT_MS = 5_000;
type SnapshotKind = 'agents.list' | 'config.get';

export class SubagentRuntimeService {
  private snapshotByMethod = new Map<SnapshotKind, {
    value: unknown;
    updatedAt: number;
  }>();
  private refreshTaskByMethod = new Map<SnapshotKind, Promise<unknown>>();
  private errorByMethod = new Map<SnapshotKind, string>();

  constructor(private readonly deps: {
    readonly gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
    readonly capabilities: GatewayPluginCapabilityPort;
    readonly workspace: Pick<OpenClawWorkspacePort, 'ensureIdentityFile'>;
    readonly clock: RuntimeClockPort;
  }) {}

  async listAgents(): Promise<ApplicationResponseOf> {
    return await this.snapshot('agents.list', { agents: [] });
  }

  async getConfig(): Promise<ApplicationResponseOf> {
    return await this.snapshot('config.get', { config: undefined });
  }

  async setConfig(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    if (typeof body.raw !== 'string' || !body.raw.trim()) {
      return badRequest('raw is required');
    }
    const baseHash = this.readString(body.baseHash);
    if (!baseHash) {
      return badRequest('baseHash is required');
    }
    return await this.call('config.set', {
      raw: body.raw,
      baseHash,
    }, { invalidateSnapshots: true });
  }

  async createAgent(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const name = this.readString(body.name);
    const workspace = this.readString(body.workspace);
    if (!name) {
      return badRequest('name is required');
    }
    if (!workspace) {
      return badRequest('workspace is required');
    }
    await this.deps.workspace.ensureIdentityFile(workspace, { createDir: true });
    return await this.call('agents.create', {
      name,
      workspace,
    }, { invalidateSnapshots: true });
  }

  async updateAgent(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const agentId = this.readString(body.agentId);
    if (!agentId) {
      return badRequest('agentId is required');
    }
    return await this.call('agents.update', {
      agentId,
      ...(this.readString(body.name) ? { name: this.readString(body.name) } : {}),
      ...(this.readString(body.workspace) ? { workspace: this.readString(body.workspace) } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
    }, { invalidateSnapshots: true });
  }

  async deleteAgent(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const agentId = this.readString(body.agentId);
    if (!agentId) {
      return badRequest('agentId is required');
    }
    return await this.call('agents.delete', {
      agentId,
      deleteFiles: body.deleteFiles === true,
    }, { invalidateSnapshots: true });
  }

  async getAgentFile(payload: unknown): Promise<ApplicationResponseOf> {
    const file = this.readAgentFileIdentity(payload);
    if (!file.ok) {
      return badRequest(file.error);
    }
    return await this.call('agents.files.get', file.params);
  }

  async setAgentFile(payload: unknown): Promise<ApplicationResponseOf> {
    const file = this.readAgentFileIdentity(payload);
    if (!file.ok) {
      return badRequest(file.error);
    }
    const body = this.readRecord(payload);
    if (typeof body.content !== 'string') {
      return badRequest('content is required');
    }
    return await this.call('agents.files.set', {
      ...file.params,
      content: body.content,
    });
  }

  async listAgentFiles(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const agentId = this.readString(body.agentId);
    if (!agentId) {
      return badRequest('agentId is required');
    }
    return await this.call('agents.files.list', { agentId });
  }

  async waitAgent(payload: unknown): Promise<ApplicationResponseOf> {
    const body = this.readRecord(payload);
    const runId = this.readString(body.runId);
    if (!runId) {
      return badRequest('runId is required');
    }
    const timeoutMs = typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
      ? Math.max(1000, Math.floor(body.timeoutMs))
      : 30_000;
    const unavailable = await this.deps.capabilities.requirePluginMethod(
      SUBAGENT_GATEWAY_PLUGIN,
      'agent.wait',
      SUBAGENT_CAPABILITY_TIMEOUT_MS,
    );
    if (unavailable) {
      return unavailable;
    }
    return ok(await this.deps.gateway.gatewayRpc('agent.wait', { runId, timeoutMs }, timeoutMs + 10_000));
  }

  private async call(
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

  private async snapshot(method: SnapshotKind, emptyPayload: Record<string, unknown>): Promise<ApplicationResponseOf> {
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

  private refreshSnapshot(method: SnapshotKind): Promise<unknown> {
    const current = this.refreshTaskByMethod.get(method);
    if (current) {
      return current;
    }

    const task = this.deps.gateway.gatewayRpc(method, {}, SUBAGENT_RPC_TIMEOUT_MS)
      .then((value) => {
        this.snapshotByMethod.set(method, {
          value,
          updatedAt: this.deps.clock.nowMs(),
        });
        this.errorByMethod.delete(method);
        return value;
      })
      .catch((error) => {
        this.errorByMethod.set(method, error instanceof Error ? error.message : String(error));
        return null;
      })
      .finally(() => {
        if (this.refreshTaskByMethod.get(method) === task) {
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
    this.snapshotByMethod.clear();
    this.errorByMethod.clear();
  }

  private readAgentFileIdentity(payload: unknown):
    | { ok: true; params: { agentId: string; name: string } }
    | { ok: false; error: string } {
    const body = this.readRecord(payload);
    const agentId = this.readString(body.agentId);
    const name = this.readString(body.name);
    if (!agentId) {
      return { ok: false, error: 'agentId is required' };
    }
    if (!name) {
      return { ok: false, error: 'name is required' };
    }
    return { ok: true, params: { agentId, name } };
  }

  private readRecord(value: unknown): Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }
}
