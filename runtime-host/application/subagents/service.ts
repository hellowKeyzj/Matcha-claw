import { badRequest, type ApplicationResponseOf } from '../common/application-response';
import type { SubagentRuntimeWorkflow } from '../workflows/subagent-runtime/subagent-runtime-workflow';

export class SubagentRuntimeService {
  constructor(private readonly deps: {
    readonly runtimeWorkflow: Pick<SubagentRuntimeWorkflow, 'snapshot' | 'call' | 'seedWorkspaceIdentity'>;
  }) {}

  async listAgents(): Promise<ApplicationResponseOf> {
    return await this.deps.runtimeWorkflow.snapshot('agents.list', { agents: [] });
  }

  async getConfig(): Promise<ApplicationResponseOf> {
    return await this.deps.runtimeWorkflow.snapshot('config.get', { config: undefined });
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
    return await this.deps.runtimeWorkflow.call('config.set', {
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
    await this.deps.runtimeWorkflow.seedWorkspaceIdentity(workspace);
    return await this.deps.runtimeWorkflow.call('agents.create', {
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
    return await this.deps.runtimeWorkflow.call('agents.update', {
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
    return await this.deps.runtimeWorkflow.call('agents.delete', {
      agentId,
      deleteFiles: body.deleteFiles === true,
    }, { invalidateSnapshots: true });
  }

  async getAgentFile(payload: unknown): Promise<ApplicationResponseOf> {
    const file = this.readAgentFileIdentity(payload);
    if (!file.ok) {
      return badRequest(file.error);
    }
    return await this.deps.runtimeWorkflow.call('agents.files.get', file.params);
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
    return await this.deps.runtimeWorkflow.call('agents.files.set', {
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
    return await this.deps.runtimeWorkflow.call('agents.files.list', { agentId });
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
