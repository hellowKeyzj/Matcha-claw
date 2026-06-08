import { badRequest, type ApplicationResponseOf } from '../common/application-response';
import type { SubagentRuntimeWorkflow } from '../workflows/subagent-runtime/subagent-runtime-workflow';
import type { SkillRuntimeWorkflow } from '../workflows/skill-runtime/skill-runtime-workflow';

const SUBAGENT_CONFIG_FILE_NAMES = new Set(['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md']);

export class SubagentRuntimeService {
  constructor(private readonly deps: {
    readonly runtimeWorkflow: Pick<SubagentRuntimeWorkflow, 'snapshot' | 'call' | 'seedWorkspaceIdentity'>;
    readonly skillRuntimeWorkflow: Pick<SkillRuntimeWorkflow, 'resolveCanonicalSkillKeys' | 'resolveCanonicalSkillKeyMap' | 'validateCanonicalSkillKeys'>;
  }) {}

  async listAgents(): Promise<ApplicationResponseOf> {
    const response = await this.deps.runtimeWorkflow.snapshot('agents.list', { agents: [] });
    return {
      ...response,
      data: await this.canonicalizeAgentsPayload(response.data),
    };
  }

  async getConfig(): Promise<ApplicationResponseOf> {
    const response = await this.deps.runtimeWorkflow.snapshot('config.get', { config: undefined });
    return {
      ...response,
      data: await this.canonicalizeConfigPayload(response.data),
    };
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
    const canonicalRaw = await this.validateConfigRaw(body.raw);
    if (!canonicalRaw.ok) {
      return badRequest(canonicalRaw.error);
    }
    return await this.deps.runtimeWorkflow.call('config.set', {
      raw: canonicalRaw.raw,
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
    const manageableAgent = await this.ensureManageableAgentId(file.params.agentId);
    if (!manageableAgent.ok) {
      return badRequest(manageableAgent.error);
    }
    const response = await this.deps.runtimeWorkflow.call('agents.files.get', file.params);
    return {
      ...response,
      data: { file: { content: this.readAgentFileContent(response.data) } },
    };
  }

  async setAgentFile(payload: unknown): Promise<ApplicationResponseOf> {
    const file = this.readAgentFileIdentity(payload);
    if (!file.ok) {
      return badRequest(file.error);
    }
    const manageableAgent = await this.ensureManageableAgentId(file.params.agentId);
    if (!manageableAgent.ok) {
      return badRequest(manageableAgent.error);
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
    if (!this.isSafeAgentId(agentId)) {
      return badRequest('agentId is invalid');
    }
    const manageableAgent = await this.ensureManageableAgentId(agentId);
    if (!manageableAgent.ok) {
      return badRequest(manageableAgent.error);
    }
    const response = await this.deps.runtimeWorkflow.call('agents.files.list', { agentId });
    return {
      ...response,
      data: this.filterAgentFilesListPayload(response.data),
    };
  }

  private readAgentFileContent(payload: unknown): string {
    const record = this.readRecord(payload);
    const file = this.readRecord(record.file);
    return this.readString(file.content);
  }

  private filterAgentFilesListPayload(payload: unknown): unknown {
    if (Array.isArray(payload)) {
      return { files: this.filterAgentFilesList(payload) };
    }
    if (!this.isRecord(payload)) {
      return payload;
    }
    if ('files' in payload) {
      return { files: this.filterAgentFilesList(payload.files) };
    }
    return 'result' in payload ? this.filterAgentFilesListPayload(payload.result) : { files: [] };
  }

  private filterAgentFilesList(files: unknown): unknown[] {
    if (!Array.isArray(files)) {
      return [];
    }
    return files.flatMap((file) => {
      if (typeof file === 'string') {
        return SUBAGENT_CONFIG_FILE_NAMES.has(file) ? [file] : [];
      }
      if (!this.isRecord(file)) {
        return [];
      }
      const name = this.readString(file.name) || this.readString(file.path);
      if (!SUBAGENT_CONFIG_FILE_NAMES.has(name)) {
        return [];
      }
      return [{ name }];
    });
  }

  private async canonicalizeAgentsPayload(payload: unknown): Promise<unknown> {
    const record = this.readRecord(payload);
    if (!Array.isArray(record.agents)) {
      return payload;
    }
    return {
      ...record,
      agents: await this.canonicalizeAgentList(record.agents),
    };
  }

  private async canonicalizeConfigPayload(payload: unknown): Promise<unknown> {
    const record = this.readRecord(payload);
    if (!('config' in record)) {
      return payload;
    }
    return {
      ...record,
      config: await this.canonicalizeConfig(record.config),
    };
  }

  private async validateConfigRaw(raw: string): Promise<{ ok: true; raw: string } | { ok: false; error: string }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'raw must be valid JSON' };
    }
    const validatedConfig = await this.validateConfig(parsed);
    if (!validatedConfig.ok) {
      return { ok: false, error: validatedConfig.error };
    }
    return {
      ok: true,
      raw: JSON.stringify(validatedConfig.config),
    };
  }

  private async canonicalizeConfig(config: unknown): Promise<unknown> {
    if (!this.isRecord(config)) {
      return config;
    }
    const agents = this.isRecord(config.agents) ? config.agents : null;
    if (!agents || !Array.isArray(agents.list)) {
      return config;
    }
    return {
      ...config,
      agents: {
        ...agents,
        list: await this.canonicalizeAgentList(agents.list),
      },
    };
  }

  private async validateConfig(config: unknown): Promise<
    { ok: true; config: unknown }
    | { ok: false; error: string }
  > {
    if (!this.isRecord(config)) {
      return { ok: true, config };
    }
    const agents = this.isRecord(config.agents) ? config.agents : null;
    if (!agents || !Array.isArray(agents.list)) {
      return { ok: true, config };
    }
    const validatedAgents = await this.validateAgentList(agents.list);
    if (!validatedAgents.ok) {
      return validatedAgents;
    }
    return {
      ok: true,
      config: {
        ...config,
        agents: {
          ...agents,
          list: validatedAgents.agents,
        },
      },
    };
  }

  private async canonicalizeAgentList(agents: unknown[]): Promise<unknown[]> {
    const skillIds = this.collectStringSkillIds(agents);
    if (skillIds.length === 0) {
      return agents;
    }
    const canonicalKeyBySkillId = await this.deps.skillRuntimeWorkflow.resolveCanonicalSkillKeyMap(skillIds);
    return agents.map((agent) => {
      if (!this.isRecord(agent) || !Array.isArray(agent.skills)) {
        return agent;
      }
      return {
        ...agent,
        skills: this.canonicalizeAgentSkills(agent.skills, canonicalKeyBySkillId),
      };
    });
  }

  private async validateAgentList(agents: unknown[]): Promise<
    { ok: true; agents: unknown[] }
    | { ok: false; error: string }
  > {
    const skillIds: string[] = [];
    for (const agent of agents) {
      if (!this.isRecord(agent) || !Array.isArray(agent.skills)) {
        continue;
      }
      for (const skill of agent.skills) {
        if (typeof skill !== 'string') {
          return { ok: false, error: 'skillKey must be a string' };
        }
        const trimmedSkill = skill.trim();
        if (!trimmedSkill) {
          return { ok: false, error: 'skillKey is required' };
        }
        skillIds.push(trimmedSkill);
      }
    }

    const validatedSkills = await this.deps.skillRuntimeWorkflow.validateCanonicalSkillKeys(skillIds);
    if (!validatedSkills.ok) {
      return validatedSkills;
    }

    return {
      ok: true,
      agents: agents.map((agent) => {
        if (!this.isRecord(agent) || !Array.isArray(agent.skills)) {
          return agent;
        }
        return {
          ...agent,
          skills: this.dedupeStrings(agent.skills.map((skill) => (skill as string).trim())),
        };
      }),
    };
  }

  private collectStringSkillIds(agents: unknown[]): string[] {
    const skillIds: string[] = [];
    for (const agent of agents) {
      if (!this.isRecord(agent) || !Array.isArray(agent.skills)) {
        continue;
      }
      for (const skill of agent.skills) {
        if (typeof skill === 'string' && skill.trim()) {
          skillIds.push(skill.trim());
        }
      }
    }
    return skillIds;
  }

  private canonicalizeAgentSkills(skills: unknown[], canonicalKeyBySkillId: Record<string, string>): unknown[] {
    const canonicalSkills: unknown[] = [];
    const seenStringSkills = new Set<string>();
    for (const skill of skills) {
      if (typeof skill !== 'string') {
        canonicalSkills.push(skill);
        continue;
      }
      const trimmedSkill = skill.trim();
      if (!trimmedSkill) {
        continue;
      }
      const canonicalSkill = canonicalKeyBySkillId[trimmedSkill] ?? trimmedSkill;
      if (seenStringSkills.has(canonicalSkill)) {
        continue;
      }
      seenStringSkills.add(canonicalSkill);
      canonicalSkills.push(canonicalSkill);
    }
    return canonicalSkills;
  }

  private dedupeStrings(values: string[]): string[] {
    const result: string[] = [];
    for (const value of values) {
      if (!result.includes(value)) {
        result.push(value);
      }
    }
    return result;
  }

  private async ensureManageableAgentId(agentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const response = await this.deps.runtimeWorkflow.call('agents.list', {});
    if (response.status !== 200) {
      return { ok: false, error: 'agentId is not manageable' };
    }
    const agents = this.readAgentsList(response.data);
    const normalizedAgentId = this.normalizeAgentId(agentId);
    if (!normalizedAgentId || !agents.some((agent) => this.normalizeAgentId(agent) === normalizedAgentId)) {
      return { ok: false, error: 'agentId is not manageable' };
    }
    return { ok: true };
  }

  private readAgentsList(payload: unknown): string[] {
    const record = this.readRecord(payload);
    if (Array.isArray(record.agents)) {
      return record.agents.flatMap((agent) => {
        if (!this.isRecord(agent)) {
          return [];
        }
        const agentId = this.readString(agent.id);
        return agentId ? [agentId] : [];
      });
    }
    return 'result' in record ? this.readAgentsList(record.result) : [];
  }

  private normalizeAgentId(agentId: string): string {
    return agentId.trim().toLowerCase();
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
    if (!this.isSafeAgentId(agentId)) {
      return { ok: false, error: 'agentId is invalid' };
    }
    if (!SUBAGENT_CONFIG_FILE_NAMES.has(name)) {
      return { ok: false, error: 'name must be a supported subagent config file' };
    }
    return { ok: true, params: { agentId, name } };
  }

  private isSafeAgentId(agentId: string): boolean {
    return !agentId.includes('/')
      && !agentId.includes('\\')
      && !agentId.includes('\0')
      && !agentId.includes('..')
      && !/^[A-Za-z]:/.test(agentId);
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
