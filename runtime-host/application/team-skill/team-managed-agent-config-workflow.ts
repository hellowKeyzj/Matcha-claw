import type { OpenClawConfigRepositoryPort } from '../adapters/openclaw/infrastructure/openclaw-config-repository';
import type { TeamManagedAgentConfigProjection, TeamRoleAgentConfigProjection } from '../../../packages/openclaw-team-runtime-plugin/src/domain/team-role';

export type { TeamManagedAgentConfigProjection, TeamRoleAgentConfigProjection };

const TEAM_LEADER_ROLE_ID = 'leader';
const TEAM_MANAGED_AGENT_CONFIG_KIND = 'matchaclaw-team-managed-openclaw-agents';
const TEAM_MANAGED_AGENT_CONFIG_VERSION = 1;
const TEAM_MANAGED_AGENT_CONFIG_SOURCE = 'matchaclaw.team-runtime';
const TEAM_MANAGED_AGENT_KIND = 'team-role-agent';
const TEAM_MANAGED_AGENT_TOOLS_PROFILE = 'full';
const TEAM_LEADER_RUNTIME_TOOLS = ['team_plan_workflow'] as const;
const TEAM_ROLE_RUNTIME_TOOLS = ['team_submit_artifact', 'team_send_message', 'team_request_approval', 'team_update_task'] as const;
const TEAM_LEADER_MANAGED_DENIED_TOOLS = ['sessions_yield', 'subagents'] as const;
const TEAM_ROLE_MANAGED_DENIED_TOOLS = ['sessions_spawn', 'sessions_yield', 'subagents'] as const;
const OPENCLAW_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SANDBOX_MODES = new Set<string>(['off', 'non-main', 'all']);
const SANDBOX_SCOPES = new Set<string>(['session', 'agent', 'shared']);
const SANDBOX_WORKSPACE_ACCESSES = new Set<string>(['none', 'ro', 'rw']);
const LEADER_REQUIRED_TOOLS = new Set<string>([...TEAM_LEADER_RUNTIME_TOOLS, ...TEAM_ROLE_RUNTIME_TOOLS]);
const LEADER_DENIED_TOOLS = new Set<string>(TEAM_LEADER_MANAGED_DENIED_TOOLS);
const ROLE_DENIED_TOOLS = new Set<string>(TEAM_ROLE_MANAGED_DENIED_TOOLS);

export interface TeamManagedAgentConfigWorkflowDeps {
  readonly configRepository: Pick<OpenClawConfigRepositoryPort, 'updateDirty'>;
}

export class TeamManagedAgentConfigWorkflow {
  constructor(private readonly deps: TeamManagedAgentConfigWorkflowDeps) {}

  async apply(managedAgentConfig: TeamManagedAgentConfigProjection): Promise<{ changed: boolean; agentIds: string[] }> {
    this.assertManagedAgentConfig(managedAgentConfig);
    const agentIds = managedAgentConfig.agents.map((agent) => agent.id);
    return await this.deps.configRepository.updateDirty((config) => {
      const agents = readRecord(config.agents);
      const existingList = Array.isArray(agents.list) ? agents.list : [];
      const nextManagedAgents = managedAgentConfig.agents.map((agent) => this.toOpenClawAgentConfig(agent));
      const nextManagedIds = new Set(nextManagedAgents.map((agent) => readString(agent.id)));
      for (const item of existingList) {
        const record = readRecord(item);
        const id = readString(record.id);
        if (nextManagedIds.has(id) && this.hasForeignManagedOwnership(record, managedAgentConfig.runId)) {
          throw new Error(`Team managed agent id collides with unmanaged OpenClaw agent: ${id}`);
        }
      }
      const retained = existingList.filter((item) => !nextManagedIds.has(readString(readRecord(item).id)));
      const merged = upsertAgents(retained, nextManagedAgents);
      const nextAgents = { ...agents, list: merged };
      const changed = config.agents !== agents || JSON.stringify(agents.list ?? []) !== JSON.stringify(nextAgents.list);
      if (changed) {
        config.agents = nextAgents;
      }
      return {
        result: { changed, agentIds },
        changed,
      };
    });
  }

  async removeRun(managedAgentConfig: TeamManagedAgentConfigProjection): Promise<{ changed: boolean; agentIds: string[] }> {
    this.assertManagedAgentConfig(managedAgentConfig);
    const targetAgentIds = new Set(managedAgentConfig.agents.map((agent) => agent.id));
    return await this.deps.configRepository.updateDirty((config) => {
      const agents = readRecord(config.agents);
      const existingList = Array.isArray(agents.list) ? agents.list : [];
      const removedAgentIds: string[] = [];
      const retained = existingList.filter((item) => {
        const id = readString(readRecord(item).id);
        if (!targetAgentIds.has(id)) {
          return true;
        }
        removedAgentIds.push(id);
        return false;
      });
      const changed = removedAgentIds.length > 0;
      if (changed) {
        config.agents = { ...agents, list: retained };
      }
      return {
        result: { changed, agentIds: removedAgentIds },
        changed,
      };
    });
  }

  readManagedAgentConfig(value: unknown): TeamManagedAgentConfigProjection | null {
    if (value === undefined || value === null) {
      return null;
    }
    const record = readRecord(value);
    if (record.kind !== TEAM_MANAGED_AGENT_CONFIG_KIND || record.version !== TEAM_MANAGED_AGENT_CONFIG_VERSION || record.source !== TEAM_MANAGED_AGENT_CONFIG_SOURCE) {
      throw new Error('Invalid Team managed agent config projection');
    }
    const runId = readString(record.runId);
    const leaderAgentId = readString(record.leaderAgentId);
    if (!Array.isArray(record.agents)) {
      throw new Error('Team managed agent config projection is incomplete');
    }
    const agents: TeamRoleAgentConfigProjection[] = [];
    for (const agentValue of record.agents) {
      const agent = this.readAgentConfig(agentValue);
      if (!agent) {
        throw new Error('Team managed agent config projection is incomplete');
      }
      agents.push(agent);
    }
    if (!runId || !leaderAgentId || agents.length === 0) {
      throw new Error('Team managed agent config projection is incomplete');
    }
    this.assertManagedAgentConfig({
      kind: TEAM_MANAGED_AGENT_CONFIG_KIND,
      version: TEAM_MANAGED_AGENT_CONFIG_VERSION,
      source: TEAM_MANAGED_AGENT_CONFIG_SOURCE,
      runId,
      leaderAgentId,
      agents,
    });
    return {
      kind: TEAM_MANAGED_AGENT_CONFIG_KIND,
      version: TEAM_MANAGED_AGENT_CONFIG_VERSION,
      source: TEAM_MANAGED_AGENT_CONFIG_SOURCE,
      runId,
      leaderAgentId,
      agents,
    };
  }

  stripManagedAgentConfig<T>(value: T): T {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }
    const { managedAgentConfig: _managedAgentConfig, ...rest } = value as Record<string, unknown>;
    return rest as T;
  }

  private assertManagedAgentConfig(config: TeamManagedAgentConfigProjection): void {
    if (config.kind !== TEAM_MANAGED_AGENT_CONFIG_KIND || config.version !== TEAM_MANAGED_AGENT_CONFIG_VERSION || config.source !== TEAM_MANAGED_AGENT_CONFIG_SOURCE) {
      throw new Error('Invalid Team managed agent config projection');
    }
    if (!config.runId.trim() || !config.leaderAgentId.trim() || config.agents.length === 0) {
      throw new Error('Team managed agent config projection is incomplete');
    }
    const ids = new Set<string>();
    const agentsById = new Map<string, TeamRoleAgentConfigProjection>();
    for (const agent of config.agents) {
      if (!OPENCLAW_AGENT_ID_PATTERN.test(agent.id)) {
        throw new Error(`Team managed agent id is invalid for OpenClaw config: ${agent.id}`);
      }
      if (ids.has(agent.id)) {
        throw new Error(`Duplicate Team managed agent id: ${agent.id}`);
      }
      ids.add(agent.id);
      agentsById.set(agent.id, agent);
      if (agent.managedBy !== TEAM_MANAGED_AGENT_CONFIG_SOURCE || agent.source !== TEAM_MANAGED_AGENT_CONFIG_SOURCE || agent.managedRunId !== config.runId || agent.managedKind !== TEAM_MANAGED_AGENT_KIND) {
        throw new Error(`Team managed agent ownership is invalid: ${agent.id}`);
      }
      if (!agent.managedRoleId.trim()) {
        throw new Error(`Team managed agent role ownership is invalid: ${agent.id}`);
      }
      this.assertTools(agent);
      this.assertSandbox(agent);
    }
    const leader = agentsById.get(config.leaderAgentId);
    if (!leader) {
      throw new Error('Team managed leader agent is missing from projection agents');
    }
    if (leader.managedRoleId !== TEAM_LEADER_ROLE_ID) {
      throw new Error(`Team managed leader agent role ownership is invalid: ${leader.id}`);
    }
    if (!leader.subagents) {
      throw new Error('Team managed leader agent subagents are incomplete');
    }
    const roleAgentIds = new Set(config.agents.filter((agent) => agent.id !== leader.id).map((agent) => agent.id));
    for (const allowedAgentId of leader.subagents.allowAgents) {
      if (!roleAgentIds.has(allowedAgentId)) {
        throw new Error(`Team managed leader allowAgents contains non-role agent: ${allowedAgentId}`);
      }
    }
    for (const agent of config.agents) {
      if (agent.id !== leader.id && agent.subagents) {
        throw new Error(`Team managed role agent cannot define subagents: ${agent.id}`);
      }
    }
  }

  private toOpenClawAgentConfig(agent: TeamRoleAgentConfigProjection): Record<string, unknown> {
    return {
      id: agent.id,
      name: agent.name,
      workspace: agent.workspace,
      agentDir: agent.agentDir,
      skills: agent.skills,
      tools: agent.tools,
      sandbox: agent.sandbox,
      ...(agent.subagents ? { subagents: agent.subagents } : {}),
    };
  }

  private readAgentConfig(value: unknown): TeamRoleAgentConfigProjection | null {
    const record = readRecord(value);
    const id = readString(record.id);
    const name = readString(record.name);
    const workspace = readString(record.workspace);
    const agentDir = readString(record.agentDir);
    const managedBy = readString(record.managedBy);
    const source = readString(record.source);
    const managedRunId = readString(record.managedRunId);
    const managedRoleId = readString(record.managedRoleId);
    const managedKind = readString(record.managedKind);
    if (!isStringArray(record.skills)) {
      return null;
    }
    const tools = this.readTools(record.tools);
    const sandbox = this.readSandbox(record.sandbox);
    if (!id || !name || !workspace || !agentDir || !managedBy || !source || !managedRunId || !managedRoleId || !managedKind || !tools || !sandbox) {
      return null;
    }
    const subagents = this.readSubagents(record.subagents);
    if (record.subagents !== undefined && !subagents) {
      return null;
    }
    return {
      id,
      name,
      workspace,
      agentDir,
      skills: readStringArray(record.skills),
      managedBy: managedBy as TeamRoleAgentConfigProjection['managedBy'],
      source: source as TeamRoleAgentConfigProjection['source'],
      managedRunId,
      managedRoleId,
      managedKind: managedKind as TeamRoleAgentConfigProjection['managedKind'],
      tools,
      sandbox,
      ...(subagents ? { subagents } : {}),
    };
  }

  private readTools(value: unknown): TeamRoleAgentConfigProjection['tools'] | null {
    const record = readRecord(value);
    const profile = readString(record.profile);
    if (!profile || !isStringArray(record.deny)) {
      return null;
    }
    if (record.allow !== undefined && !isStringArray(record.allow)) {
      return null;
    }
    if (record.alsoAllow !== undefined && !isStringArray(record.alsoAllow)) {
      return null;
    }
    return {
      profile,
      ...(Array.isArray(record.allow) ? { allow: readStringArray(record.allow) } : {}),
      ...(Array.isArray(record.alsoAllow) ? { alsoAllow: readStringArray(record.alsoAllow) } : {}),
      deny: readStringArray(record.deny),
    };
  }

  private readSandbox(value: unknown): TeamRoleAgentConfigProjection['sandbox'] | null {
    const record = readRecord(value);
    const mode = readString(record.mode);
    const scope = readString(record.scope);
    const workspaceAccess = readString(record.workspaceAccess);
    return mode && scope && workspaceAccess ? { mode, scope, workspaceAccess } : null;
  }

  private readSubagents(value: unknown): TeamRoleAgentConfigProjection['subagents'] | null {
    const record = readRecord(value);
    if (!isStringArray(record.allowAgents) || typeof record.requireAgentId !== 'boolean') {
      return null;
    }
    return {
      allowAgents: readStringArray(record.allowAgents),
      requireAgentId: record.requireAgentId,
    };
  }

  private hasForeignManagedOwnership(agent: Record<string, unknown>, runId: string): boolean {
    const hasOwnershipFields = agent.managedBy !== undefined || agent.source !== undefined || agent.managedRunId !== undefined || agent.managedRoleId !== undefined || agent.managedKind !== undefined;
    if (!hasOwnershipFields) {
      return false;
    }
    return readString(agent.managedBy) !== TEAM_MANAGED_AGENT_CONFIG_SOURCE
      || readString(agent.source) !== TEAM_MANAGED_AGENT_CONFIG_SOURCE
      || readString(agent.managedRunId) !== runId
      || readString(agent.managedKind) !== TEAM_MANAGED_AGENT_KIND;
  }

  private assertTools(agent: TeamRoleAgentConfigProjection): void {
    const isLeader = agent.managedRoleId === TEAM_LEADER_ROLE_ID;
    if (agent.tools.profile !== TEAM_MANAGED_AGENT_TOOLS_PROFILE) {
      throw new Error(`Team managed agent tools.profile is invalid: ${agent.id}`);
    }
    const allow = agent.tools.allow ?? [];
    const alsoAllow = agent.tools.alsoAllow ?? [];
    if (isLeader) {
      if (!containsStringSet(allow, LEADER_REQUIRED_TOOLS) || hasIntersection(allow, LEADER_DENIED_TOOLS) || alsoAllow.length > 0 || !sameStringSet(agent.tools.deny, LEADER_DENIED_TOOLS)) {
        throw new Error(`Team managed leader tools are invalid: ${agent.id}`);
      }
      if (!agent.subagents || agent.subagents.requireAgentId !== true) {
        throw new Error(`Team managed leader subagent routing is invalid: ${agent.id}`);
      }
      return;
    }
    if (alsoAllow.length > 0) {
      throw new Error(`Team managed role agent tools.alsoAllow is invalid: ${agent.id}`);
    }
    if (allow.length === 0 || hasIntersection(allow, ROLE_DENIED_TOOLS) || !sameStringSet(agent.tools.deny, ROLE_DENIED_TOOLS)) {
      throw new Error(`Team managed role agent tools are invalid: ${agent.id}`);
    }
  }

  private assertSandbox(agent: TeamRoleAgentConfigProjection): void {
    if (!SANDBOX_MODES.has(agent.sandbox.mode) || !SANDBOX_SCOPES.has(agent.sandbox.scope) || !SANDBOX_WORKSPACE_ACCESSES.has(agent.sandbox.workspaceAccess)) {
      throw new Error(`Team managed agent sandbox is invalid: ${agent.id}`);
    }
  }
}

function upsertAgents(existing: unknown[], managedAgents: Record<string, unknown>[]): unknown[] {
  const byId = new Map<string, unknown>();
  const order: string[] = [];
  for (const item of existing) {
    const id = readString(readRecord(item).id);
    if (!id) {
      order.push(`__anonymous:${order.length}`);
      byId.set(order[order.length - 1]!, item);
      continue;
    }
    if (!byId.has(id)) {
      order.push(id);
    }
    byId.set(id, item);
  }
  for (const agent of managedAgents) {
    const id = readString(agent.id);
    if (!byId.has(id)) {
      order.push(id);
    }
    byId.set(id, agent);
  }
  return order.map((id) => byId.get(id));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function sameStringSet(values: string[], expected: Set<string>): boolean {
  return values.length === expected.size && values.every((value) => expected.has(value));
}

function containsStringSet(values: string[], expected: Set<string>): boolean {
  const actual = new Set(values);
  return Array.from(expected).every((value) => actual.has(value));
}

function hasIntersection(values: string[], disallowed: Set<string>): boolean {
  return values.some((value) => disallowed.has(value));
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
}
