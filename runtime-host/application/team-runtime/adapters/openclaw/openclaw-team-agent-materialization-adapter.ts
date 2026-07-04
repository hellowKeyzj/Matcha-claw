import path from 'node:path';
import { buildTeamManagedAgentId, teamManagedAgentTeamPrefix } from '../../domain/team-managed-agent';
import type { TeamManagedAgentConfigRestore, TeamManagedAgentRecord } from '../../domain/team-instance';
import type { RuntimeFileSystemPort } from '../../../common/runtime-ports';
import type { GatewayPluginCapabilityPort, GatewayPluginCapabilityDefinition } from '../../../gateway/gateway-capability-service';
import type { GatewayRpcPort } from '../../../gateway/gateway-runtime-port';
import type { RuntimeEndpointRef } from '../../../agent-runtime/contracts/runtime-address';
import { isTeamRuntimeDebugLoggingEnabled } from '../../team-runtime-debug-logging';
import type {
  RemoveTeamAgentsInput,
  TeamAgentMaterializationPort,
  TeamAgentMaterializationResult,
  TeamAgentMaterializationSpec,
  TeamRoleAgentMaterializationSpec,
} from '../../ports/team-agent-materialization-port';
import {
  OPENCLAW_TEAM_AGENT_SANDBOX,
  projectTeamRoleToolPolicyToOpenClawTools,
} from './openclaw-team-agent-policy-projection';

const OPENCLAW_AGENT_MATERIALIZATION_RPC_TIMEOUT_MS = 60_000;
const OPENCLAW_AGENT_MATERIALIZATION_CAPABILITY_TIMEOUT_MS = 5_000;
const OPENCLAW_AGENT_MATERIALIZATION_PLUGIN: GatewayPluginCapabilityDefinition = {
  pluginId: 'subagents',
  methods: [
    'agents.list',
    'config.get',
    'config.set',
    'agents.create',
    'agents.update',
    'agents.delete',
  ],
};
const TEAMBUDDY_DIRECTORY_NAME = 'teambuddy';
const OPENCLAW_GENERATED_AGENT_FILES = ['IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'] as const;

interface OpenClawTeamAgentMaterializationLogger {
  readonly debug: (message: string) => void;
  readonly error?: (message: string) => void;
}

interface OpenClawTeamAgentMaterializationAdapterDeps {
  readonly gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
  readonly capabilities: GatewayPluginCapabilityPort;
  readonly fileSystem: Pick<RuntimeFileSystemPort, 'exists' | 'ensureDirectory' | 'readTextFile' | 'writeTextFile' | 'removeFile' | 'removeDirectory'>;
  readonly openClawConfigDir: string;
  readonly logger?: OpenClawTeamAgentMaterializationLogger;
}

type TeamAgentMaterializationLogValue = string | number | boolean | null | undefined | Readonly<Record<string, string | number | boolean | null | undefined>>;
type TeamAgentMaterializationLogFields = Readonly<Record<string, TeamAgentMaterializationLogValue>>;

interface TeamAgentMaterializationLogContext {
  readonly teamId: string;
}

type TeamAgentOwnership = 'team-owned' | 'external';

type TeamBuddyProjectionWriteMode = 'replace' | 'append-teamrun-block';

interface MaterializedRoleAgent {
  readonly role: TeamRoleAgentMaterializationSpec;
  readonly agentId: string;
  readonly ownership: TeamAgentOwnership;
}

interface ExistingOpenClawAgentRecord {
  readonly agentId: string;
  readonly workspace?: string;
}

interface MaterializedRoleAgentConfigPatch {
  readonly roleAgent: MaterializedRoleAgent;
  readonly workspacePath: string;
}

interface TeamBuddyProjectionFile {
  readonly filePath: string;
  readonly content: string;
  readonly writeMode: TeamBuddyProjectionWriteMode;
}

interface TeamBuddyRoleProjection {
  readonly roleAgent: MaterializedRoleAgent;
  readonly roleWorkspacePath: string;
  readonly files: readonly TeamBuddyProjectionFile[];
}

interface TeamBuddyProjection {
  readonly leader: MaterializedRoleAgent;
  readonly leaderWorkspacePath: string;
  readonly roleWorkspacePaths: ReadonlyMap<string, string>;
  readonly leaderFiles: readonly TeamBuddyProjectionFile[];
  readonly roleProjections: readonly TeamBuddyRoleProjection[];
}

function replaceProjectionFile(filePath: string, content: string): TeamBuddyProjectionFile {
  return { filePath, content, writeMode: 'replace' };
}

function appendTeamRunBlockProjectionFile(filePath: string, content: string): TeamBuddyProjectionFile {
  return { filePath, content, writeMode: 'append-teamrun-block' };
}

export class OpenClawTeamAgentMaterializationAdapter implements TeamAgentMaterializationPort {
  constructor(private readonly deps: OpenClawTeamAgentMaterializationAdapterDeps) {}

  async materialize(input: TeamAgentMaterializationSpec): Promise<TeamAgentMaterializationResult> {
    const startedAt = Date.now();
    const logContext: TeamAgentMaterializationLogContext = { teamId: input.teamId };
    const leader = this.materializedRoleAgent(input.teamId, input.leader);
    const roles = input.roles.map((role) => this.materializedRoleAgent(input.teamId, role));
    const roleAgents = [leader, ...roles];
    this.logDebug(logContext, {
      stage: 'materialize.start',
      method: 'materialize',
      roleCount: roles.length,
      managedAgentCount: roles.length + 1,
      durationMs: 0,
    });

    try {
      await this.requireMethod('agents.list', logContext);
      const existingAgents = await this.readExistingAgents(logContext);
      const projection = this.buildTeamBuddyProjection(input, leader, roles);
      if (roleAgents.some((roleAgent) => roleAgent.ownership === 'team-owned')) {
        await this.requireMethod('agents.create', logContext);
        await this.requireMethod('agents.update', logContext);
      }
      await this.requireMethod('config.get', logContext);
      await this.requireMethod('config.set', logContext);
      await this.createOrUpdateAgent(leader, projection.leaderWorkspacePath, existingAgents, logContext);
      const configPatches: MaterializedRoleAgentConfigPatch[] = [{ roleAgent: leader, workspacePath: projection.leaderWorkspacePath }];
      for (const roleAgent of roles) {
        const roleWorkspacePath = projection.roleWorkspacePaths.get(roleAgent.role.roleId);
        if (!roleWorkspacePath) {
          throw new Error(`Team role workspace projection was not created for role ${roleAgent.role.roleId}`);
        }
        await this.createOrUpdateAgent(roleAgent, roleWorkspacePath, existingAgents, logContext);
        configPatches.push({ roleAgent, workspacePath: roleWorkspacePath });
      }
      await this.writeTeamBuddyProjection(input, projection, logContext);
      const configRestores = await this.writeTeamAgentConfigPatches(configPatches, roleAgents, logContext);

      const result = this.toMaterializationResult(input, leader, roles, projection, configRestores);
      this.logDebug(logContext, {
        stage: 'materialize.complete',
        method: 'materialize',
        roleCount: roles.length,
        managedAgentCount: result.managedAgents.length,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.logError(logContext, {
        stage: 'materialize.error',
        method: 'materialize',
        roleCount: roles.length,
        managedAgentCount: roles.length + 1,
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: safeTeamAgentMaterializationErrorMessage(error, 'Team agent materialization failed'),
      });
      throw error;
    }
  }

  async removeTeamAgents(input: RemoveTeamAgentsInput): Promise<void> {
    if (input.managedAgents.length === 0) {
      return;
    }
    const externalAgents = input.managedAgents.filter((agent) => agent.lifecycle === 'external');
    if (externalAgents.length > 0) {
      await this.removeSelectedAgentProjectionBlocks(input.teamId, externalAgents);
      await this.restoreExternalTeamAgentConfig(input.teamId, externalAgents);
    }

    const teamOwnedAgents = input.managedAgents.filter((agent) => agent.lifecycle !== 'external');
    if (teamOwnedAgents.length === 0) {
      return;
    }
    await this.requireMethod('agents.delete');
    const managedTeamAgentIdPrefix = teamManagedAgentTeamPrefix(input.teamId);
    for (const agent of teamOwnedAgents) {
      if (!agent.agentId.startsWith(managedTeamAgentIdPrefix)) {
        throw new Error(`Refusing to remove non-Team OpenClaw agent for team ${input.teamId}: ${agent.agentId}`);
      }
      try {
        await this.callGateway('agents.delete', {
          agentId: agent.agentId,
          deleteFiles: true,
        });
      } catch (error) {
        if (!this.isAgentNotFoundError(error, agent.agentId)) {
          throw error;
        }
      }
    }
    await this.removeTeamBuddyWorkspaces(teamOwnedAgents.map((agent) => agent.workspace));
  }

  private toMaterializationResult(
    input: TeamAgentMaterializationSpec,
    leader: MaterializedRoleAgent,
    roles: readonly MaterializedRoleAgent[],
    projection: { readonly leaderWorkspacePath: string; readonly roleWorkspacePaths: ReadonlyMap<string, string> },
    configRestores: ReadonlyMap<string, TeamManagedAgentConfigRestore>,
  ): TeamAgentMaterializationResult {
    return {
      teamId: input.teamId,
      managedAgents: [
        this.toManagedAgentRecord(input.teamId, input.endpoint, leader, projection.leaderWorkspacePath, configRestores),
        ...roles.map((roleAgent) => {
          const workspace = projection.roleWorkspacePaths.get(roleAgent.role.roleId);
          if (!workspace) {
            throw new Error(`Team role workspace projection was not created for role ${roleAgent.role.roleId}`);
          }
          return this.toManagedAgentRecord(input.teamId, input.endpoint, roleAgent, workspace, configRestores);
        }),
      ],
    };
  }

  private async createOrUpdateAgent(
    roleAgent: MaterializedRoleAgent,
    workspacePath: string,
    existingAgents: ReadonlyMap<string, ExistingOpenClawAgentRecord>,
    logContext: TeamAgentMaterializationLogContext,
  ): Promise<void> {
    const existingAgent = existingAgents.get(roleAgent.agentId);
    if (existingAgent) {
      this.logExistingAgent(roleAgent, existingAgent, logContext);
    }
    if (roleAgent.ownership === 'external') {
      if (!existingAgent) {
        throw new Error(`Selected Team agent is not available: ${roleAgent.agentId}`);
      }
      return;
    }
    if (existingAgent) {
      this.assertExistingTeamOwnedAgentCanBeMaterialized(roleAgent, existingAgent, logContext);
    } else {
      const createPayload = this.buildAgentCreatePayload(roleAgent, workspacePath);
      try {
        const createResult = await this.callGateway('agents.create', createPayload, logContext, {
          stage: 'agent.create',
          roleId: roleAgent.role.roleId,
          agentId: roleAgent.agentId,
          workspacePath,
        });
        const returnedAgentId = this.readAgentId(createResult);
        if (!returnedAgentId) {
          throw new Error(`OpenClaw agents.create did not confirm agentId for Team role ${roleAgent.role.roleId}: ${roleAgent.agentId}`);
        }
        if (returnedAgentId !== roleAgent.agentId) {
          throw new Error(`OpenClaw agents.create returned unexpected agentId for Team role ${roleAgent.role.roleId}: ${returnedAgentId}`);
        }
      } catch (error) {
        if (!this.isAgentAlreadyExistsError(error, roleAgent.agentId)) {
          throw error;
        }
        this.logDebug(logContext, {
          stage: 'agent.create.already_exists',
          method: 'agents.create',
          roleId: roleAgent.role.roleId,
          agentId: roleAgent.agentId,
          workspacePath,
        });
      }
    }

    await this.callGateway('agents.update', this.buildAgentUpdatePayload(roleAgent, workspacePath), logContext, {
      stage: 'agent.update',
      roleId: roleAgent.role.roleId,
      agentId: roleAgent.agentId,
      workspacePath,
    });
    await this.removeGeneratedOpenClawFiles(workspacePath, roleAgent, logContext);
  }

  private logExistingAgent(
    roleAgent: MaterializedRoleAgent,
    existingAgent: ExistingOpenClawAgentRecord,
    logContext: TeamAgentMaterializationLogContext,
  ): void {
    this.logDebug(logContext, {
      stage: 'agent.existing',
      method: 'agents.list',
      roleId: roleAgent.role.roleId,
      agentId: roleAgent.agentId,
      workspacePath: existingAgent.workspace,
    });
  }

  private buildAgentCreatePayload(roleAgent: MaterializedRoleAgent, workspacePath: string): Record<string, unknown> {
    if (roleAgent.ownership !== 'team-owned') {
      throw new Error(`Selected Team agent is not available: ${roleAgent.agentId}`);
    }
    return {
      name: roleAgent.agentId,
      workspace: workspacePath,
    };
  }

  private buildAgentUpdatePayload(roleAgent: MaterializedRoleAgent, workspacePath: string): Record<string, unknown> {
    return {
      agentId: roleAgent.agentId,
      name: roleAgent.role.agentName,
      workspace: workspacePath,
      ...(roleAgent.role.model ? { model: roleAgent.role.model } : {}),
    };
  }

  private async writeTeamAgentConfigPatches(
    patches: readonly MaterializedRoleAgentConfigPatch[],
    roleAgents: readonly MaterializedRoleAgent[],
    logContext: TeamAgentMaterializationLogContext,
  ): Promise<ReadonlyMap<string, TeamManagedAgentConfigRestore>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const payload = await this.callGateway('config.get', {}, logContext, {
        stage: 'config.get',
        patchCount: patches.length,
        roleCount: roleAgents.length,
        attempt: attempt + 1,
      });
      const configGetResult = this.readConfigGetResult(payload);
      if (!configGetResult.hash) {
        throw new Error('OpenClaw config.get returned missing hash for Team agent configuration update');
      }
      const patchResult = this.patchTeamAgentsConfig(configGetResult.config, patches, roleAgents, logContext);
      try {
        await this.callGateway('config.set', {
          raw: JSON.stringify(patchResult.config),
          baseHash: configGetResult.hash,
        }, logContext, {
          stage: 'config.set',
          patchCount: patches.length,
          roleCount: roleAgents.length,
          attempt: attempt + 1,
        });
        return patchResult.configRestores;
      } catch (error) {
        if (attempt === 0 && this.isConfigChangedSinceLastLoadError(error)) {
          this.logDebug(logContext, {
            stage: 'config.set.retry',
            method: 'config.set',
            patchCount: patches.length,
            roleCount: roleAgents.length,
            attempt: attempt + 1,
          });
          continue;
        }
        throw error;
      }
    }
    throw new Error('OpenClaw config.set retry loop exhausted for Team agent configuration update');
  }

  private patchTeamAgentsConfig(
    config: unknown,
    patches: readonly MaterializedRoleAgentConfigPatch[],
    roleAgents: readonly MaterializedRoleAgent[],
    logContext: TeamAgentMaterializationLogContext,
  ): { readonly config: Record<string, unknown>; readonly configRestores: ReadonlyMap<string, TeamManagedAgentConfigRestore> } {
    const startedAt = Date.now();
    const nextConfig = this.readRecord(config);
    const agents = this.readRecord(nextConfig.agents);
    const list = Array.isArray(agents.list) ? [...agents.list] : [];
    const originalEntryCount = list.length;
    const configRestores = new Map<string, TeamManagedAgentConfigRestore>();
    for (const patch of patches) {
      const restore = this.upsertTeamAgentConfigEntry(list, patch, logContext);
      configRestores.set(patch.roleAgent.agentId, restore);
    }
    nextConfig.agents = {
      ...agents,
      list,
    };
    this.logDebug(logContext, {
      stage: 'config.patch',
      method: 'config.set',
      patchCount: patches.length,
      roleCount: roleAgents.length,
      originalEntryCount,
      nextEntryCount: list.length,
      durationMs: Date.now() - startedAt,
    });
    return { config: nextConfig, configRestores };
  }

  private upsertTeamAgentConfigEntry(
    list: unknown[],
    patch: MaterializedRoleAgentConfigPatch,
    logContext: TeamAgentMaterializationLogContext,
  ): TeamManagedAgentConfigRestore {
    const targetIndex = list.findIndex((entry) => this.readString(this.readRecord(entry).id) === patch.roleAgent.agentId);
    const current = targetIndex >= 0 ? this.readRecord(list[targetIndex]) : {};
    const restore: TeamManagedAgentConfigRestore = targetIndex >= 0
      ? { entryExisted: true, entry: cloneRecord(current) }
      : { entryExisted: false };
    const nextEntry = this.buildTeamAgentConfigEntry(current, patch);
    this.logDebug(logContext, {
      stage: targetIndex >= 0 ? 'config.patch.update' : 'config.patch.create',
      method: 'config.set',
      roleId: patch.roleAgent.role.roleId,
      agentId: patch.roleAgent.agentId,
      workspacePath: patch.workspacePath,
      toolAllowCount: Array.isArray(this.readRecord(nextEntry.tools).allow) ? (this.readRecord(nextEntry.tools).allow as unknown[]).length : 0,
      skillCount: Array.isArray(nextEntry.skills) ? nextEntry.skills.length : 0,
      subagentCount: Array.isArray(nextEntry.subagents) ? nextEntry.subagents.length : 0,
    });
    if (targetIndex >= 0) {
      list[targetIndex] = nextEntry;
      return restore;
    }
    list.push(nextEntry);
    return restore;
  }

  private buildTeamAgentConfigEntry(
    current: Readonly<Record<string, unknown>>,
    patch: MaterializedRoleAgentConfigPatch,
  ): Record<string, unknown> {
    return patch.roleAgent.ownership === 'external'
      ? this.buildExternalAgentConfigEntry(current, patch)
      : this.buildTeamOwnedAgentConfigEntry(current, patch);
  }

  private buildExternalAgentConfigEntry(
    current: Readonly<Record<string, unknown>>,
    patch: MaterializedRoleAgentConfigPatch,
  ): Record<string, unknown> {
    return {
      ...current,
      id: patch.roleAgent.agentId,
      tools: projectTeamRoleToolPolicyToOpenClawTools(patch.roleAgent.role),
      sandbox: OPENCLAW_TEAM_AGENT_SANDBOX,
    };
  }

  private buildTeamOwnedAgentConfigEntry(
    current: Readonly<Record<string, unknown>>,
    patch: MaterializedRoleAgentConfigPatch,
  ): Record<string, unknown> {
    const nextEntry: Record<string, unknown> = {
      ...current,
      id: patch.roleAgent.agentId,
      name: patch.roleAgent.role.agentName,
      workspace: patch.workspacePath,
      tools: projectTeamRoleToolPolicyToOpenClawTools(patch.roleAgent.role),
      sandbox: OPENCLAW_TEAM_AGENT_SANDBOX,
    };
    delete nextEntry.skipBootstrap;
    delete nextEntry.subagents;
    if (patch.roleAgent.role.model) {
      nextEntry.model = patch.roleAgent.role.model;
    } else {
      delete nextEntry.model;
    }
    if (patch.roleAgent.role.skills) {
      nextEntry.skills = [...patch.roleAgent.role.skills];
    } else {
      delete nextEntry.skills;
    }
    return nextEntry;
  }

  private assertExistingTeamOwnedAgentCanBeMaterialized(
    roleAgent: MaterializedRoleAgent,
    existingAgent: ExistingOpenClawAgentRecord,
    logContext: TeamAgentMaterializationLogContext,
  ): void {
    if (!existingAgent.workspace || !isPathInsideDirectory(existingAgent.workspace, this.teamBuddyRootPath())) {
      this.logError(logContext, {
        stage: 'agent.existing.collision',
        method: 'agents.list',
        roleId: roleAgent.role.roleId,
        agentId: roleAgent.agentId,
        workspacePath: existingAgent.workspace,
      });
      throw new Error(`Team managed agent id collides with non-Team OpenClaw agent: ${roleAgent.agentId}`);
    }
  }

  private async readExistingAgents(logContext: TeamAgentMaterializationLogContext): Promise<ReadonlyMap<string, ExistingOpenClawAgentRecord>> {
    const payload = await this.callGateway('agents.list', {}, logContext, { stage: 'agents.list' });
    const record = this.readRecord(payload);
    const agents = Array.isArray(record.agents) ? record.agents : [];
    const byAgentId = new Map<string, ExistingOpenClawAgentRecord>();
    for (const agent of agents) {
      const agentRecord = this.readRecord(agent);
      const agentId = this.readString(agentRecord.id) || this.readString(agentRecord.agentId);
      if (agentId) {
        byAgentId.set(agentId, {
          agentId,
          ...(this.readString(agentRecord.workspace) ? { workspace: this.readString(agentRecord.workspace)! } : {}),
        });
      }
    }
    this.logDebug(logContext, {
      stage: 'agents.list.read',
      method: 'agents.list',
      existingAgentCount: byAgentId.size,
      returnedAgentCount: agents.length,
    });
    return byAgentId;
  }

  private buildTeamBuddyProjection(
    input: TeamAgentMaterializationSpec,
    leader: MaterializedRoleAgent,
    roles: readonly MaterializedRoleAgent[],
  ): TeamBuddyProjection {
    const teamSkillDirectoryName = sanitizePathSegment(input.teamSkill.name);
    const defaultLeaderWorkspacePath = path.join(this.deps.openClawConfigDir, TEAMBUDDY_DIRECTORY_NAME, teamSkillDirectoryName);
    const leaderWorkspacePath = this.workspacePathForRole(input, leader, defaultLeaderWorkspacePath);
    const teamSkillPackagePath = path.join(leaderWorkspacePath, 'skills', teamSkillDirectoryName);
    const leaderFiles: TeamBuddyProjectionFile[] = leader.ownership === 'external'
      ? [
          appendTeamRunBlockProjectionFile(path.join(leaderWorkspacePath, 'AGENTS.md'), this.buildSelectedLeaderAgentsMd(input, roles)),
          appendTeamRunBlockProjectionFile(path.join(leaderWorkspacePath, 'TOOLS.md'), this.buildSelectedLeaderToolsMd()),
        ]
      : [
          replaceProjectionFile(path.join(leaderWorkspacePath, 'AGENTS.md'), this.buildLeaderAgentsMd(input, roles, teamSkillDirectoryName)),
          replaceProjectionFile(path.join(leaderWorkspacePath, 'TOOLS.md'), this.buildLeaderToolsMd()),
          replaceProjectionFile(path.join(leaderWorkspacePath, 'dependencies.json'), `${JSON.stringify(input.teamSkill.dependencies, null, 2)}\n`),
          replaceProjectionFile(path.join(teamSkillPackagePath, 'SKILL.md'), input.teamSkill.skillMarkdown),
          replaceProjectionFile(path.join(teamSkillPackagePath, 'workflow.md'), input.teamSkill.workflowMarkdown),
          replaceProjectionFile(path.join(teamSkillPackagePath, 'dependencies.yaml'), input.teamSkill.dependenciesYaml),
          ...(input.teamSkill.bindMarkdown === undefined ? [] : [replaceProjectionFile(path.join(teamSkillPackagePath, 'bind.md'), input.teamSkill.bindMarkdown)]),
        ];
    const roleWorkspacePaths = new Map<string, string>();
    const roleProjections = roles.map((roleAgent): TeamBuddyRoleProjection => {
      const roleDirectoryName = sanitizePathSegment(roleAgent.role.roleId);
      const roleWorkspacePath = this.workspacePathForRole(input, roleAgent, path.join(leaderWorkspacePath, 'roles', roleDirectoryName));
      const roleMarkdown = roleAgent.role.roleMarkdown ?? '';
      roleWorkspacePaths.set(roleAgent.role.roleId, roleWorkspacePath);
      return {
        roleAgent,
        roleWorkspacePath,
        files: roleAgent.ownership === 'external'
          ? [
              appendTeamRunBlockProjectionFile(path.join(roleWorkspacePath, 'AGENTS.md'), this.buildSelectedRoleAgentsMd(roleMarkdown)),
              appendTeamRunBlockProjectionFile(path.join(roleWorkspacePath, 'TOOLS.md'), this.buildSelectedRoleToolsMd()),
            ]
          : [
              replaceProjectionFile(path.join(teamSkillPackagePath, 'roles', `${roleDirectoryName}.md`), roleMarkdown),
              replaceProjectionFile(path.join(roleWorkspacePath, 'AGENTS.md'), this.buildRoleAgentsMd(roleMarkdown)),
              replaceProjectionFile(path.join(roleWorkspacePath, 'TOOLS.md'), this.buildRoleToolsMd()),
            ],
      };
    });
    return { leader, leaderWorkspacePath, roleWorkspacePaths, leaderFiles, roleProjections };
  }

  private async writeTeamBuddyProjection(
    input: TeamAgentMaterializationSpec,
    projection: TeamBuddyProjection,
    logContext: TeamAgentMaterializationLogContext,
  ): Promise<void> {
    const startedAt = Date.now();
    const roleProjectionFileCount = projection.roleProjections.reduce((count, roleProjection) => count + roleProjection.files.length, 0);
    this.logDebug(logContext, {
      stage: 'projection.write.start',
      method: 'fileSystem.writeTextFile',
      roleId: projection.leader.role.roleId,
      agentId: projection.leader.agentId,
      workspacePath: projection.leaderWorkspacePath,
      roleCount: projection.roleProjections.length,
      fileCount: projection.leaderFiles.length,
      durationMs: 0,
    });
    await this.deps.fileSystem.ensureDirectory(projection.leaderWorkspacePath);
    for (const file of projection.leaderFiles) {
      await this.writeProjectionFile(input.teamId, file);
    }

    for (const roleProjection of projection.roleProjections) {
      const roleProjectionStartedAt = Date.now();
      await this.deps.fileSystem.ensureDirectory(roleProjection.roleWorkspacePath);
      for (const file of roleProjection.files) {
        await this.writeProjectionFile(input.teamId, file);
      }
      this.logDebug(logContext, {
        stage: 'projection.write.role',
        method: 'fileSystem.writeTextFile',
        roleId: roleProjection.roleAgent.role.roleId,
        agentId: roleProjection.roleAgent.agentId,
        workspacePath: roleProjection.roleWorkspacePath,
        fileCount: roleProjection.files.length,
        durationMs: Date.now() - roleProjectionStartedAt,
      });
    }

    this.logDebug(logContext, {
      stage: 'projection.write.complete',
      method: 'fileSystem.writeTextFile',
      roleId: projection.leader.role.roleId,
      agentId: projection.leader.agentId,
      workspacePath: projection.leaderWorkspacePath,
      roleCount: projection.roleProjections.length,
      fileCount: projection.leaderFiles.length + roleProjectionFileCount,
      durationMs: Date.now() - startedAt,
    });
  }

  private async writeProjectionFile(teamId: string, file: TeamBuddyProjectionFile): Promise<void> {
    await this.deps.fileSystem.ensureDirectory(path.dirname(file.filePath));
    if (file.writeMode === 'append-teamrun-block') {
      const currentContent = await this.readTextFileIfExists(file.filePath) ?? '';
      await this.deps.fileSystem.writeTextFile(file.filePath, appendTeamRunProjectionBlock(currentContent, teamId, file.content));
      return;
    }
    await this.deps.fileSystem.writeTextFile(file.filePath, file.content);
  }

  private async readTextFileIfExists(filePath: string): Promise<string | null> {
    if (!await this.deps.fileSystem.exists(filePath)) {
      return null;
    }
    return await this.deps.fileSystem.readTextFile(filePath);
  }

  private async removeSelectedAgentProjectionBlocks(teamId: string, agents: readonly TeamManagedAgentRecord[]): Promise<void> {
    for (const agent of agents) {
      await this.removeProjectionBlockFromFile(path.join(agent.workspace, 'AGENTS.md'), teamId);
      await this.removeProjectionBlockFromFile(path.join(agent.workspace, 'TOOLS.md'), teamId);
    }
  }

  private async removeProjectionBlockFromFile(filePath: string, teamId: string): Promise<void> {
    const currentContent = await this.readTextFileIfExists(filePath);
    if (currentContent === null) {
      return;
    }
    const nextContent = removeTeamRunProjectionBlock(currentContent, teamId);
    if (nextContent !== currentContent) {
      await this.deps.fileSystem.writeTextFile(filePath, nextContent);
    }
  }

  private async restoreExternalTeamAgentConfig(teamId: string, agents: readonly TeamManagedAgentRecord[]): Promise<void> {
    await this.requireMethod('config.get');
    await this.requireMethod('config.set');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const payload = await this.callGateway('config.get', {});
      const configGetResult = this.readConfigGetResult(payload);
      if (!configGetResult.hash) {
        throw new Error('OpenClaw config.get returned missing hash for selected Team agent configuration restore');
      }
      const nextConfig = this.restoreExternalTeamAgentConfigEntries(teamId, configGetResult.config, agents);
      try {
        await this.callGateway('config.set', {
          raw: JSON.stringify(nextConfig),
          baseHash: configGetResult.hash,
        });
        return;
      } catch (error) {
        if (attempt === 0 && this.isConfigChangedSinceLastLoadError(error)) {
          continue;
        }
        throw error;
      }
    }
    throw new Error('OpenClaw config.set retry loop exhausted for selected Team agent configuration restore');
  }

  private restoreExternalTeamAgentConfigEntries(teamId: string, config: unknown, agentsToRestore: readonly TeamManagedAgentRecord[]): Record<string, unknown> {
    const nextConfig = this.readRecord(config);
    const agents = this.readRecord(nextConfig.agents);
    const list = Array.isArray(agents.list) ? [...agents.list] : [];
    for (const agent of agentsToRestore) {
      if (!agent.configRestore) {
        throw new Error(`Config restore snapshot is required before removing TeamRun projection from selected agent ${agent.agentId} for team ${teamId}`);
      }
      const targetIndex = list.findIndex((entry) => this.readString(this.readRecord(entry).id) === agent.agentId);
      if (agent.configRestore.entryExisted) {
        const restoredEntry = cloneRecord(agent.configRestore.entry ?? { id: agent.agentId });
        if (targetIndex >= 0) {
          list[targetIndex] = restoredEntry;
        } else {
          list.push(restoredEntry);
        }
      } else if (targetIndex >= 0) {
        list.splice(targetIndex, 1);
      }
    }
    nextConfig.agents = {
      ...agents,
      list,
    };
    return nextConfig;
  }

  private async removeGeneratedOpenClawFiles(
    workspacePath: string,
    roleAgent: MaterializedRoleAgent,
    logContext: TeamAgentMaterializationLogContext,
  ): Promise<void> {
    const startedAt = Date.now();
    let removedFileCount = 0;
    let missingFileCount = 0;
    for (const fileName of OPENCLAW_GENERATED_AGENT_FILES) {
      try {
        await this.deps.fileSystem.removeFile(path.join(workspacePath, fileName));
        removedFileCount += 1;
      } catch {
        missingFileCount += 1;
        continue;
      }
    }
    this.logDebug(logContext, {
      stage: 'generated_files.remove',
      method: 'fileSystem.removeFile',
      roleId: roleAgent.role.roleId,
      agentId: roleAgent.agentId,
      workspacePath,
      fileCount: OPENCLAW_GENERATED_AGENT_FILES.length,
      removedFileCount,
      missingFileCount,
      durationMs: Date.now() - startedAt,
    });
  }

  private async removeTeamBuddyWorkspaces(workspacePaths: readonly string[]): Promise<void> {
    for (const workspacePath of selectTopLevelTeamBuddyWorkspacePaths(workspacePaths, this.teamBuddyRootPath())) {
      await this.deps.fileSystem.removeDirectory(workspacePath);
    }
  }

  private teamBuddyRootPath(): string {
    return path.resolve(this.deps.openClawConfigDir, TEAMBUDDY_DIRECTORY_NAME);
  }

  private buildLeaderAgentsMd(input: TeamAgentMaterializationSpec, roles: readonly MaterializedRoleAgent[], teamSkillDirectoryName: string): string {
    return [
      '# TeamSkill Leader',
      '',
      '你是这个 Team 的 leader agent。你有两个工作模式：个人模式和团队模式。默认个人模式；只有收到明确 TeamRun node/graph 上下文时，才进入团队模式。',
      '',
      '## 事实来源',
      '',
      `这些文件用于理解 ${input.teamSkill.name} 的 Team 职责，不是 TeamRun 运行状态源。TeamRun 状态源是 runtime-host。`,
      '',
      '- AGENTS.md：leader 行为规则。',
      '- TOOLS.md：TeamRun 工具 SOP。',
      `- skills/${teamSkillDirectoryName}/SKILL.md：Team 能力入口和成功标准。`,
      `- skills/${teamSkillDirectoryName}/workflow.md：Team workflow 设计依据。`,
      `- skills/${teamSkillDirectoryName}/bind.md：role 绑定和约束；存在时必须参考。`,
      `- skills/${teamSkillDirectoryName}/dependencies.yaml：原始依赖清单。`,
      '- dependencies.json：解析后的依赖清单。',
      `- skills/${teamSkillDirectoryName}/roles/{roleId}.md：role 职责和可嵌入 node prompt 的 teammate persona。`,
      '',
      '不要把本地文件当成 live graph。live graph 只能通过 runtime-host TeamRun tools 读取或修改。',
      '',
      '## 工作模式',
      '',
      '### 个人模式',
      '',
      '触发场景：用户只是问能力、解释 workflow/role、讨论输入输出、让你总结或给轻量建议；没有给出 TeamRun node/graph 上下文。',
      '',
      '你应该：',
      '- 直接用短句回答。',
      '- 必要时读取 TeamSkill 文件确认事实。',
      '- 不调用 TeamRun tools。',
      '- 不声称 role agent、node 或 graph 已经运行。',
      '',
      '例子：',
      '- “这个 team 能做什么？” -> 个人模式，直接说明。',
      '- “有哪些 roles？” -> 个人模式，读取/总结 role。',
      '- “Analyze Series B investment in Anthropic...” -> 个人模式，除非 prompt 另外给出 TeamRun 上下文。',
      '',
      '### 团队模式',
      '',
      '触发场景：当前 prompt 提供 TeamRun 上下文字段：runId、runtimeKind/runtimeAdapterId/runtimeInstanceId 等扁平 endpoint 字段；执行某个 node 时还会提供 nodeExecutionId。不要用用户短语判定模式；是否进入团队模式只看当前 prompt 是否提供 TeamRun 上下文。',
      '',
      'TeamRun 工具门槛：',
      '- team_graph_context / team_graph_patch：需要 runId + 扁平 endpoint 字段。',
      '- team_node_event / current_node 查询：还需要 nodeExecutionId。',
      '- 缺少门槛字段时：停在个人模式，或说明缺少 TeamRun 上下文；不要探测 active run。',
      '- 禁止占位值：current、default、猜测 ID；endpoint 必须用 runtimeKind/runtimeAdapterId/runtimeInstanceId 等顶层字段；保持为顶层字段。',
      '',
      '你应该：',
      '- 修改 graph 前先用 team_graph_context 读取 compact graph context；不要盲改。',
      '- 需要新增或调整 graph 时，用 team_graph_patch。',
      '- 自己正在执行某个 nodeExecution 时，用 team_node_event 上报 progress/request/complete/reject。',
      '- command 成功前，不把计划说成完成。',
      '',
      '例子：',
      '- prompt 含 “TeamRun node”、runId、runtimeKind/runtimeAdapterId/runtimeInstanceId、nodeExecutionId -> 团队模式，完成当前 node 后调用 team_node_event。',
      '- prompt 含 runId、runtimeKind/runtimeAdapterId/runtimeInstanceId，且用户要求“把这个 run 的 graph 调整成先审查再汇总” -> 团队模式，先 team_graph_context，再 team_graph_patch。',
      '- 用户只给出投资分析任务 -> 个人模式，不调用 TeamRun tools，除非当前 prompt 另有 TeamRun 上下文。',
      '',
      '## Team role 分派决策',
      '',
      '触发场景：当前 prompt 表明你正在处理 TeamRun 中的 leader/coordinator node，且用户要求“分派任务”“并行派发”“让各角色执行/准备 prompt”“把任务交给某些 role”。',
      '',
      '必须做：',
      '1. 需要确认当前 node、输出端口或相邻下游边时，先用 team_graph_context view=current_node；只有设计或修改整体 graph topology/config 时才用 graph_summary。',
      '2. 把分派写入当前 node 的 NodeResult：result.assignments 使用 Role roster 里的 roleId，text 写给该 role 的完整任务说明。',
      '3. 用 team_node_event complete 提交当前 node result；outputPort 必须匹配 graph 里通向下游 role node 的 sourcePort。',
      '4. runtime-host reducer 会根据 edge action 和 payload.includeUpstreamResult 激活下游 role node；不要自己创建 OpenClaw 子会话。',
      '',
      '不要做：',
      '- 不调用 agents_list 查 agent id；Role roster 已经给出可用 roleId。',
      '- 不调用 sessions_spawn、subagents 或另开新 session 分派 Team role。',
      '- 不用 team_graph_patch 承载一次性分派内容；graph_patch 只改稳定 topology/config/template。',
      '- 不把“为每个角色准备 prompt”解释成 OpenClaw 原生 spawn。',
      '- 不把 managed agent id 当 roleId 写进 result.assignments。',
      '',
      '正例：用户说“并行派发给四个角色” -> team_graph_context current_node -> team_node_event complete，result.assignments 包含四个 roleId/text。',
      '反例：用户说“并行派发给四个角色” -> agents_list -> sessions_spawn 创建四个子智能体。这个路径违反 TeamRun。',
      '反例：用户说“并行派发给四个角色” -> team_graph_patch 临时新增四个任务节点来承载本次分派。这个路径把一次性分派错写成 graph topology。',
      '',
      '失败处理：team_graph_context 或 team_node_event 失败时，不要改用 OpenClaw spawn 或 graph_patch 兜底；按错误修正 TeamRun tool 参数，无法修正就说明失败边界。',
      '',
      '## TeamSkill preflight',
      '',
      '设计或修改 TeamRun graph 前，按顺序检查；读取 markdown 文件必须一次只发起一个 read，等上一个 read 返回后再读下一个，避免并发读取会话日志造成 file lock stale：',
      `1. 读取 skills/${teamSkillDirectoryName}/SKILL.md。`,
      `2. 读取 skills/${teamSkillDirectoryName}/workflow.md。`,
      `3. 存在 bind.md 时读取 skills/${teamSkillDirectoryName}/bind.md。`,
      '4. 读取 dependencies.yaml 和 dependencies.json。',
      `5. 只读取本次需要的 skills/${teamSkillDirectoryName}/roles/{roleId}.md。`,
      '6. 通过 TeamRun 工具门槛后，用 team_graph_context 确认 runtime-host graph context。',
      '7. 提交 graph patch 前核对：patch.operations 非空；nodeId/edgeId 稳定；没有 workflowTaskId 字段。',
      '',
      'OpenClaw read 工具参数字段是 path，不是 file_path。读取上述文件时使用 {"path":"..."}；如果误用 file_path 导致 schema 错误，改用 path 重试一次，不要把它当作文件不存在。',
      '',
      '缺少必要用户输入或必需依赖时，不提交假的 graph patch；直接说明缺什么。可选依赖缺失时，只有 TeamSkill 允许降级才继续，并在 node prompt 或最终输出中写明限制。',
      '',
      '## Role roster',
      '',
      'work/review node 的 roleId 只能使用下面这些值：',
      '',
      ...roles.map((roleAgent) => `- ${roleAgent.role.roleId}`),
      '',
      '不要使用 roleId "leader"、managed agent id、展示名、自造 helper/reviewer/integrator。',
      '',
      '## Node prompt 编写规则',
      '',
      '给 role 的 work/review node prompt 必须包含：用户任务、共享上下文、role assignment、期望输出、依赖/限制、完成标准。role 文件里有 “Inline Persona for Teammate” 时，把该段内容写进 node prompt；不要假设 role agent 会自己读取原始 role 文件。',
      '',
      '## 禁止行为',
      '',
      '- 不满足 TeamRun 工具门槛时，不调用 TeamRun tools。',
      '- 不用普通聊天文本代替 team_node_event。',
      '- 不用 team_node_event 修改稳定 graph topology/config；它只提交当前 node 的事件和 NodeResult。',
      '- 不用 team_graph_patch 承载一次性分派/产出；分派内容属于 team_node_event 的 NodeResult。',
      '- 不猜 runId、nodeExecutionId、roleId。',
      '- 不把本地 TeamSkill 文件说成当前 live graph。',
      '- 不创建 TeamSkill 未声明的 role。',
      '- 不用 sessions_spawn、subagents 或另开新 session 分派 Team role。',
      '- 满足成功标准后停止，不顺手扩展 graph。',
      '',
    ].join('\n');
  }

  private buildLeaderToolsMd(): string {
    return [
      '# TeamRun Tools',
      '',
      '这些工具只走 runtime-host TeamRun command/context 契约。',
      '',
      '## 工具优先级',
      '',
      '1. 当前 prompt 提供的 TeamRun 上下文字段。',
      '2. team_graph_context 读取的 runtime-host graph context。',
      '3. TeamSkill 文件中的 workflow/role 设计规则。',
      '4. team_graph_patch / team_node_event 写入命令。',
      '',
      '## 本地文件工具',
      '',
      '- OpenClaw read 工具读取文件时参数字段是 path，不是 file_path。',
      '- TeamSkill preflight 读 markdown 时必须串行：等一个 read 返回后，再发起下一个 read。',
      '- read 因参数字段错误失败时，改用 path 重试一次；不要把 schema 错误解释成文件不存在。',
      '',
      '## 共同调用前检查',
      '',
      '- team_graph_context / team_graph_patch：必须有 runId 和扁平 endpoint 字段。',
      '- team_node_event / current_node 查询：必须再有 nodeExecutionId。',
      '- native-runtime endpoint 使用 runtimeKind、runtimeAdapterId、runtimeInstanceId 三个顶层字段。',
      '- protocol-connector endpoint 使用 runtimeKind、protocolId、connectorId、endpointId 四个顶层字段。',
      '- 只复制上面的顶层 endpoint 字段，不要把 endpoint 字段合并成一个值。',
      '- 不要使用 current、default、猜测 ID，或自造 endpoint。',
      '- 缺少必填上下文时不要调用工具；回到个人模式，或说明缺少 TeamRun 上下文。',
      '',
      '正确参数片段：',
      '```json',
      '"runtimeKind": "native-runtime",',
      '"runtimeAdapterId": "openclaw",',
      '"runtimeInstanceId": "local"',
      '```',
      '',
      '## team_graph_context',
      '',
      '何时使用：',
      '- 准备修改 graph 前，需要读取当前 compact graph。',
      '- 执行当前 node，且需要确认上下游 edge、状态、等待输入、审批或最近事件。',
      '- 不确定 graph 是否已存在或已被其他命令推进。',
      '',
      '何时不要使用：',
      '- 普通问答、解释 TeamSkill、讨论假设方案。',
      '- 只需要读取本地 TeamSkill 文件。',
      '- 只是想探测有没有 active run。',
      '',
      '调用前检查：先通过共同调用前检查；view：设计/修改 graph 用 graph_summary；执行当前 node 用 current_node。',
      '',
      '调用后处理：',
      '- 先看 fieldGuide 理解字段含义；fieldGuide 是字段说明，不是运行状态。',
      '- 把返回值当作 runtime-host 当前状态。',
      '- 只依据返回的 compact 信息改 graph；不要假设完整 config/prompt 已返回。',
      '- 返回无 graph 时，先保存/创建 graph；不要 patch 不存在的 graph。',
      '',
      '失败处理：',
      '- 参数校验失败时，先修正参数后重试同一个工具；不要改用其他 TeamRun tool 汇报这个失败。',
      '- 如果错误提到 runtimeKind 或 endpoint 字段，按正确参数片段补齐顶层 endpoint 字段后重试。',
      '- 读取 graph context 失败时，不要继续提交 graph patch；说明失败边界或按错误修正后重试。',
      '',
      '## team_graph_patch',
      '',
      '何时使用：需要创建或修改 TeamRun graph topology/config。',
      '何时不要使用：上报当前 node 进度、请求输入、审批、完成或失败；或不满足共同调用前检查。',
      '',
      '调用前检查：',
      '- 先用 team_graph_context 确认当前 graph；读失败不要盲改。',
      '- summary 简短说明这次 graph 变化。',
      '- idempotencyKey 对同一语义变更稳定。',
      '- patch.operations 非空。',
      '- work/review node 的 roleId 来自 AGENTS.md Role roster。',
      '- node.config.prompt 放稳定执行说明；一次性分派/产出放 team_node_event 的 result。',
      '- edge 用 action 表达 activate/rework/gate/finish，用 payload.includeUpstreamResult 控制是否把上游 NodeResult 拼进下游 prompt。',
      '',
      '失败处理：patch 失败时不要声称 graph 已更新；按错误修正后用同一 idempotencyKey 重试同一意图。',
      '',
      '常见错误：',
      '- 提交 workflowTaskId 或 tasks/groups 字段。',
      '- 用 managed agent id / 展示名当 roleId。',
      '- 盲改 graph，不先读 team_graph_context。',
      '',
      '## team_node_event',
      '',
      '何时使用：leader 自己正在执行当前 nodeExecution，需要上报 progress、request_input、request_approval、reject 或 complete；分派角色任务时，用 complete 的 result.assignments 提交各 role 的任务说明。',
      '何时不要使用：修改稳定 graph topology/config、直接回答用户、没有当前 nodeExecutionId、当前 nodeExecutionId 已经 terminal、或不满足共同调用前检查。',
      '',
      '必填字段：runId、runtimeKind、endpoint 标识字段、nodeExecutionId、event、idempotencyKey、顶层 summary。result.summary 不能替代顶层 summary。',
      '',
      '调用前检查：',
      '- nodeExecutionId 必须从当前 node prompt 或 team_graph_context 复制；不要自造 attempt:2 或修改 attempt 后缀。',
      '- complete/reject 会提交当前 node 的 NodeResult，下游边可按 payload.includeUpstreamResult 拼进 prompt。',
      '- result.assignments 可承载本次分派给各 role 的任务文本；roleId 必须来自 AGENTS.md Role roster。',
      '- complete 只在当前 node 真正完成时使用。',
      '- reject 只在当前 node 应失败或走失败/返工边时使用。',
      '- outputPort 必须和 graph edge sourcePort 对齐。',
      '- evidenceRefs 只用 type=workspacePath、uri、artifact、inlineText；不要用 kind=file。',
      '',
      '调用后处理：',
      '- progress / request_input / request_approval 成功后，按当前 node 状态继续或等待。',
      '- complete / reject 返回 success=true 后，停止对这个 nodeExecutionId 调用 team_node_event；不要换新 idempotencyKey 再提交一次 terminal event。',
      '- 如果 review 要求 rework，等待 runtime-host 投递新的 node prompt；新 prompt 会带新的 nodeExecutionId，再开始新的事件序列。',
      '',
      '失败处理：命令失败时不要说 node 已完成；如果只是传输结果不确定，复用同一 idempotencyKey 重试同一事件；如果参数被拒绝，按错误修正后再提交。',
      '',
      '常见错误：',
      '- complete 已 success=true 后，又用 complete-003 这类新 idempotencyKey 重复提交。',
      '- review rework 后自己把 attempt:1 改成 attempt:2。',
      '- 只写 result.summary，不写顶层 summary。',
      '- evidenceRefs 使用 { kind: "file" }。',
      '',
    ].join('\n');
  }

  private buildRoleAgentsMd(roleMarkdown: string): string {
    const base = removeInlinePersonaForTeammateSection(roleMarkdown).trimEnd();
    const teamRunMode = [
      '## TeamRun 模式',
      '',
      '默认按本文件职责独立工作。只有当前 prompt 明确包含 TeamRun node 上下文时，才进入 TeamRun 模式。',
      '',
      '进入 TeamRun 模式需要：runId、扁平 endpoint 字段、nodeExecutionId。缺少任一项，就不要调用 TeamRun tools。',
      '',
      'TeamRun 模式下：',
      '- 你只负责当前 node，不设计或修改整个 graph。',
      '- 工具参数从当前 prompt 复制；不要使用 current/default/猜测值。',
      '- endpoint 作为 runtimeKind/runtimeAdapterId/runtimeInstanceId 等顶层字段传入；保持为顶层字段。',
      '- 需要当前 node 的上下游、状态或等待信息时，按 TOOLS.md 调 team_graph_context view=current_node。',
      '- 有进展、阻塞、审批需求、失败或完成时，按 TOOLS.md 调 team_node_event。普通 assistant 文本不会推进 graph。',
      '- complete 只在当前 node 真正完成时使用；未验证就说明未验证。',
    ].join('\n');
    return [base, teamRunMode].filter(Boolean).join('\n\n');
  }

  private buildRoleToolsMd(): string {
    return [
      '# TeamRun Node Tools',
      '',
      '这些工具只用于 runtime-host TeamRun。',
      '',
      '## 共同调用前检查',
      '',
      '- 当前 node prompt 必须提供 runId、扁平 endpoint 字段、nodeExecutionId。',
      '- native-runtime endpoint 使用 runtimeKind、runtimeAdapterId、runtimeInstanceId 三个顶层字段。',
      '- protocol-connector endpoint 使用 runtimeKind、protocolId、connectorId、endpointId 四个顶层字段。',
      '- 不要使用 current、default、猜测 ID，或自造 endpoint。',
      '- 只复制上面的顶层 endpoint 字段，不要把 endpoint 字段合并成一个值。',
      '- 缺少必填上下文时不要调用工具；说明缺少 TeamRun node 上下文。',
      '',
      '正确参数片段：',
      '```json',
      '"runtimeKind": "native-runtime",',
      '"runtimeAdapterId": "openclaw",',
      '"runtimeInstanceId": "local"',
      '```',
      '',
      '## team_graph_context',
      '',
      '何时使用：',
      '- 需要确认当前 node、上下游 edge、等待输入、审批或最近事件。',
      '- 不确定 outputPort 应走哪条边。',
      '',
      '何时不要使用：',
      '- 只是完成本地推理，不需要 runtime graph 状态。',
      '- 想查看完整 prompt/config；该工具只返回关键摘要。',
      '- 不满足共同调用前检查。',
      '',
      '调用前检查：先通过共同调用前检查；view 用 current_node。',
      '调用后处理：先看 fieldGuide 理解字段含义；只把返回值用于理解当前 node 和邻接边；不要改 graph。',
      '失败处理：',
      '- 参数校验失败时，先修正参数后重试同一个工具；不要改用 team_node_event 汇报这个失败。',
      '- 如果错误提到 runtimeKind 或 endpoint 字段，按正确参数片段补齐顶层 endpoint 字段后重试。',
      '- 只有确实缺少业务输入，且共同调用前检查已通过时，才用 team_node_event request_input。',
      '- 读取 graph context 失败但当前 prompt 足够执行时，可以继续本地工作；不要声称已经读取 graph context。',
      '',
      '## team_node_event',
      '',
      '何时使用：',
      '| 场景 | event |',
      '|---|---|',
      '| 有阶段性进展但未完成 | progress |',
      '| 继续执行前缺少用户/leader 输入 | request_input |',
      '| 继续执行前必须让用户确认高风险动作 | request_approval |',
      '| 当前 node 应失败或进入返工/失败边 | reject |',
      '| 当前 node 已完成 | complete |',
      '',
      '何时不要使用：',
      '- 只是聊天回答或草稿。',
      '- 想修改 graph；role 不用 graph patch。',
      '- 没有当前 nodeExecutionId，或当前 nodeExecutionId 已经 complete/reject 成功。',
      '- 不满足共同调用前检查。',
      '',
      '必填字段：runId、runtimeKind、endpoint 标识字段、nodeExecutionId、event、idempotencyKey、顶层 summary。result.summary 不能替代顶层 summary。',
      '',
      '调用前检查：',
      '- nodeExecutionId 必须从当前 node prompt 或 team_graph_context 复制；不要自造 attempt:2 或修改 attempt 后缀。',
      '- idempotencyKey 对同一次上报稳定；重试同一事件不要换 key。',
      '- summary 简短，不塞完整长文；完整产出放 result.content/metadata/evidenceRefs。',
      '- complete/reject 会提交 NodeResult；outputPort 要匹配 graph edge；不确定先查 team_graph_context。',
      '- request_approval 时填写 requestedAction 和 risk。',
      '',
      '调用后处理：',
      '- progress / request_input / request_approval 成功后，按当前 node 状态继续或等待。',
      '- complete / reject 返回 success=true 后，停止对这个 nodeExecutionId 调用 team_node_event；不要换新 idempotencyKey 再提交一次 terminal event。',
      '- 如果 review 要求 rework，等待 runtime-host 投递新的 node prompt；新 prompt 会带新的 nodeExecutionId，再开始新的事件序列。',
      '',
      'evidenceRefs 规则：',
      '- workspacePath 只能引用真实存在或你实际创建的文件：{ "type": "workspacePath", "path": "..." }。',
      '- uri 只能引用真实外部地址：{ "type": "uri", "uri": "..." }。',
      '- artifact 只能引用已存在 artifactId：{ "type": "artifact", "artifactId": "..." }。',
      '- inlineText 只放必要证据：{ "type": "inlineText", "text": "..." }。',
      '- 不要使用 { "kind": "file" }。',
      '',
      '失败处理：',
      '- command 报错时，不要说 node 已完成、失败或等待。',
      '- 如果只是传输结果不确定，复用同一 idempotencyKey 重试同一事件。',
      '- 如果参数被拒绝，按错误修正后再提交；无法修正时，在普通回复里说明失败边界。',
      '',
      '常见错误：',
      '- 猜 runId 或 nodeExecutionId。',
      '- complete 已 success=true 后，又用新的 idempotencyKey 重复 complete。',
      '- review rework 后自己把 attempt:1 改成 attempt:2。',
      '- 只写 result.summary，不写顶层 summary。',
      '- 用 managed agent id 当 roleId。',
      '- 把 endpoint 字段合并成一个对象或字符串。',
      '- 只发 assistant 文本，以为 graph 会推进。',
      '- 提交 workflowTaskId-based payload。',
      '- 用 sessions_spawn、subagents 或另开新 session 替代 TeamRun。',
      '',
    ].join('\n');
  }

  private buildSelectedLeaderAgentsMd(input: TeamAgentMaterializationSpec, roles: readonly MaterializedRoleAgent[]): string {
    return [
      '# TeamRun Leader Mode',
      '',
      '你是这个 Team 的 leader。默认按当前 Agent 原有职责工作；只有当前 prompt 明确提供 TeamRun node/graph 上下文时，才进入团队模式。',
      '',
      '## 团队模式',
      '',
      '触发场景：当前 prompt 提供 TeamRun 上下文字段：runId、runtimeKind/runtimeAdapterId/runtimeInstanceId 等扁平 endpoint 字段；执行某个 node 时还会提供 nodeExecutionId。不要用用户短语判定模式；是否进入团队模式只看当前 prompt 是否提供 TeamRun 上下文。',
      '',
      'TeamRun 工具门槛：',
      '- team_graph_context / team_graph_patch：需要 runId + 扁平 endpoint 字段。',
      '- team_node_event / current_node 查询：还需要 nodeExecutionId。',
      '- 缺少门槛字段时：停在当前 Agent 原有工作模式，或说明缺少 TeamRun 上下文；不要探测 active run。',
      '- 禁止占位值：current、default、猜测 ID；endpoint 必须用 runtimeKind/runtimeAdapterId/runtimeInstanceId 等顶层字段；保持为顶层字段。',
      '',
      '你应该：',
      '- 修改 graph 前先用 team_graph_context 读取 compact graph context；不要盲改。',
      '- 需要新增或调整 graph 时，用 team_graph_patch。',
      '- 自己正在执行某个 nodeExecution 时，用 team_node_event 上报 progress/request/complete/reject。',
      '- command 成功前，不把计划说成完成。',
      '',
      '## Team role 分派决策',
      '',
      '触发场景：当前 prompt 表明你正在处理 TeamRun 中的 leader/coordinator node，且用户要求“分派任务”“并行派发”“让各角色执行/准备 prompt”“把任务交给某些 role”。',
      '',
      '必须做：',
      '1. 需要确认当前 node、输出端口或相邻下游边时，先用 team_graph_context view=current_node；只有设计或修改整体 graph topology/config 时才用 graph_summary。',
      '2. 把分派写入当前 node 的 NodeResult：result.assignments 使用 Role roster 里的 roleId，text 写给该 role 的完整任务说明。',
      '3. 用 team_node_event complete 提交当前 node result；outputPort 必须匹配 graph 里通向下游 role node 的 sourcePort。',
      '4. runtime-host reducer 会根据 edge action 和 payload.includeUpstreamResult 激活下游 role node；不要自己创建 OpenClaw 子会话。',
      '',
      '不要做：',
      '- 不调用 agents_list 查 agent id；Role roster 已经给出可用 roleId。',
      '- 不调用 sessions_spawn、subagents 或另开新 session 分派 Team role。',
      '- 不用 team_graph_patch 承载一次性分派内容；graph_patch 只改稳定 topology/config/template。',
      '- 不把 managed agent id 当 roleId 写进 result.assignments。',
      '',
      '## Role roster',
      '',
      'work/review node 的 roleId 只能使用下面这些值：',
      '',
      ...roles.map((roleAgent) => `- ${roleAgent.role.roleId}`),
      '',
      '不要使用 roleId "leader"、managed agent id、展示名、自造 helper/reviewer/integrator。',
      '',
      '## Node prompt 编写规则',
      '',
      '给 role 的 work/review node prompt 必须包含：用户任务、共享上下文、role assignment、期望输出、依赖/限制、完成标准。不要假设 role agent 会自己知道当前 node 未写明的任务。',
      '',
      '## 禁止行为',
      '',
      '- 不满足 TeamRun 工具门槛时，不调用 TeamRun tools。',
      '- 不用普通聊天文本代替 team_node_event。',
      '- 不用 team_node_event 修改稳定 graph topology/config；它只提交当前 node 的事件和 NodeResult。',
      '- 不用 team_graph_patch 承载一次性分派/产出；分派内容属于 team_node_event 的 NodeResult。',
      '- 不猜 runId、nodeExecutionId、roleId。',
      '- 不用 sessions_spawn、subagents 或另开新 session 分派 Team role。',
      '- 满足成功标准后停止，不顺手扩展 graph。',
      '',
      `Team name: ${input.teamSkill.name}`,
      '',
    ].join('\n');
  }

  private buildSelectedLeaderToolsMd(): string {
    return [
      '# TeamRun Tools',
      '',
      '这些工具只走 runtime-host TeamRun command/context 契约。',
      '',
      '## 工具优先级',
      '',
      '1. 当前 prompt 提供的 TeamRun 上下文字段。',
      '2. team_graph_context 读取的 runtime-host graph context。',
      '3. team_graph_patch / team_node_event 写入命令。',
      '',
      '## 共同调用前检查',
      '',
      '- team_graph_context / team_graph_patch：必须有 runId 和扁平 endpoint 字段。',
      '- team_node_event / current_node 查询：必须再有 nodeExecutionId。',
      '- native-runtime endpoint 使用 runtimeKind、runtimeAdapterId、runtimeInstanceId 三个顶层字段。',
      '- protocol-connector endpoint 使用 runtimeKind、protocolId、connectorId、endpointId 四个顶层字段。',
      '- 只复制上面的顶层 endpoint 字段，不要把 endpoint 字段合并成一个值。',
      '- 不要使用 current、default、猜测 ID，或自造 endpoint。',
      '- 缺少必填上下文时不要调用工具；回到当前 Agent 原有工作模式，或说明缺少 TeamRun 上下文。',
      '',
      '正确参数片段：',
      '```json',
      '"runtimeKind": "native-runtime",',
      '"runtimeAdapterId": "openclaw",',
      '"runtimeInstanceId": "local"',
      '```',
      '',
      '## team_graph_context',
      '',
      '何时使用：',
      '- 准备修改 graph 前，需要读取当前 compact graph。',
      '- 执行当前 node，且需要确认上下游 edge、状态、等待输入、审批或最近事件。',
      '- 不确定 graph 是否已存在或已被其他命令推进。',
      '',
      '何时不要使用：',
      '- 普通问答、讨论假设方案。',
      '- 只是想探测有没有 active run。',
      '- 不满足共同调用前检查。',
      '',
      '调用前检查：先通过共同调用前检查；view：设计/修改 graph 用 graph_summary；执行当前 node 用 current_node。',
      '调用后处理：把返回值当作 runtime-host 当前状态；只依据返回的 compact 信息改 graph。',
      '失败处理：参数校验失败时，先修正参数后重试同一个工具；读取失败时不要继续提交 graph patch。',
      '',
      '## team_graph_patch',
      '',
      '何时使用：需要创建或修改 TeamRun graph topology/config。',
      '何时不要使用：上报当前 node 进度、请求输入、审批、完成或失败；或不满足共同调用前检查。',
      '调用前检查：先用 team_graph_context 确认当前 graph；patch.operations 非空；work/review node 的 roleId 来自 AGENTS.md Role roster。',
      '失败处理：patch 失败时不要声称 graph 已更新；按错误修正后用同一 idempotencyKey 重试同一意图。',
      '',
      '## team_node_event',
      '',
      '何时使用：leader 自己正在执行当前 nodeExecution，需要上报 progress、request_input、request_approval、reject 或 complete；分派角色任务时，用 complete 的 result.assignments 提交各 role 的任务说明。',
      '何时不要使用：修改稳定 graph topology/config、直接回答用户、没有当前 nodeExecutionId、当前 nodeExecutionId 已经 terminal、或不满足共同调用前检查。',
      '必填字段：runId、runtimeKind、endpoint 标识字段、nodeExecutionId、event、idempotencyKey、顶层 summary。result.summary 不能替代顶层 summary。',
      '调用后处理：complete / reject 返回 success=true 后，停止对这个 nodeExecutionId 调用 team_node_event；不要换新 idempotencyKey 再提交一次 terminal event。',
      '失败处理：命令失败时不要说 node 已完成；如果只是传输结果不确定，复用同一 idempotencyKey 重试同一事件。',
      '',
    ].join('\n');
  }

  private buildSelectedRoleAgentsMd(roleMarkdown: string): string {
    const base = roleMarkdown.trimEnd();
    const teamRunMode = [
      '## TeamRun 模式',
      '',
      '默认按当前 Agent 原有职责工作。只有当前 prompt 明确包含 TeamRun node 上下文时，才进入 TeamRun 模式。',
      '',
      '进入 TeamRun 模式需要：runId、扁平 endpoint 字段、nodeExecutionId。缺少任一项，就不要调用 TeamRun tools。',
      '',
      'TeamRun 模式下：',
      '- 你只负责当前 node，不设计或修改整个 graph。',
      '- 工具参数从当前 prompt 复制；不要使用 current/default/猜测值。',
      '- endpoint 作为 runtimeKind/runtimeAdapterId/runtimeInstanceId 等顶层字段传入；保持为顶层字段。',
      '- 需要当前 node 的上下游、状态或等待信息时，按 TOOLS.md 调 team_graph_context view=current_node。',
      '- 有进展、阻塞、审批需求、失败或完成时，按 TOOLS.md 调 team_node_event。普通 assistant 文本不会推进 graph。',
      '- complete 只在当前 node 真正完成时使用；未验证就说明未验证。',
    ].join('\n');
    return [base, teamRunMode].filter(Boolean).join('\n\n');
  }

  private buildSelectedRoleToolsMd(): string {
    return this.buildRoleToolsMd();
  }

  private materializedRoleAgent(teamId: string, role: TeamRoleAgentMaterializationSpec): MaterializedRoleAgent {
    return {
      role,
      agentId: role.sourceAgentId ?? buildTeamManagedAgentId(teamId, role.roleId),
      ownership: role.sourceAgentId ? 'external' : 'team-owned',
    };
  }

  private workspacePathForRole(_input: TeamAgentMaterializationSpec, roleAgent: MaterializedRoleAgent, fallbackWorkspacePath: string): string {
    return roleAgent.role.sourceWorkspace ?? fallbackWorkspacePath;
  }

  private toManagedAgentRecord(
    teamId: string,
    endpoint: RuntimeEndpointRef,
    roleAgent: MaterializedRoleAgent,
    workspace: string,
    configRestores: ReadonlyMap<string, TeamManagedAgentConfigRestore>,
  ): TeamManagedAgentRecord {
    const configRestore = configRestores.get(roleAgent.agentId);
    return {
      teamId,
      roleId: roleAgent.role.roleId,
      agentId: roleAgent.agentId,
      displayName: roleAgent.role.agentName,
      workspace,
      endpoint,
      ...(roleAgent.role.model ? { model: roleAgent.role.model } : {}),
      ...(roleAgent.ownership === 'external' ? {
        lifecycle: 'external' as const,
        ...(configRestore ? { configRestore } : {}),
      } : {}),
    };
  }

  private async requireMethod(method: string, logContext?: TeamAgentMaterializationLogContext): Promise<void> {
    const startedAt = Date.now();
    try {
      const unavailable = await this.deps.capabilities.requirePluginMethod(
        OPENCLAW_AGENT_MATERIALIZATION_PLUGIN,
        method,
        OPENCLAW_AGENT_MATERIALIZATION_CAPABILITY_TIMEOUT_MS,
      );
      this.logDebug(logContext, {
        stage: 'capability.require',
        method,
        durationMs: Date.now() - startedAt,
      });
      if (unavailable) {
        throw new Error(unavailable.data.message);
      }
    } catch (error) {
      this.logError(logContext, {
        stage: 'capability.require.error',
        method,
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: safeTeamAgentMaterializationErrorMessage(error, 'OpenClaw capability check failed'),
      });
      throw error;
    }
  }

  private async callGateway(
    method: string,
    params: Record<string, unknown>,
    logContext?: TeamAgentMaterializationLogContext,
    fields: TeamAgentMaterializationLogFields = {},
  ): Promise<unknown> {
    const startedAt = Date.now();
    try {
      const result = await this.deps.gateway.gatewayRpc(method, params, OPENCLAW_AGENT_MATERIALIZATION_RPC_TIMEOUT_MS);
      this.logDebug(logContext, {
        stage: fields.stage ?? 'gateway.call',
        ...fields,
        method,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.logError(logContext, {
        ...fields,
        stage: `${fields.stage ?? 'gateway.call'}.error`,
        method,
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: safeTeamAgentMaterializationErrorMessage(error, 'OpenClaw gateway call failed'),
      });
      throw error;
    }
  }

  private logDebug(logContext: TeamAgentMaterializationLogContext | undefined, fields: TeamAgentMaterializationLogFields): void {
    if (!this.deps.logger || !isTeamRuntimeDebugLoggingEnabled()) {
      return;
    }
    this.deps.logger.debug(formatTeamAgentMaterializationLogMessage(logContext, fields));
  }

  private logError(logContext: TeamAgentMaterializationLogContext | undefined, fields: TeamAgentMaterializationLogFields): void {
    if (!this.deps.logger || !isTeamRuntimeDebugLoggingEnabled()) {
      return;
    }
    const message = formatTeamAgentMaterializationLogMessage(logContext, fields);
    if (this.deps.logger.error) {
      this.deps.logger.error(message);
      return;
    }
    this.deps.logger.debug(message);
  }

  private isAgentAlreadyExistsError(error: unknown, agentId: string): boolean {
    return error instanceof Error && error.message.includes('already exists') && error.message.includes(agentId);
  }

  private isAgentNotFoundError(error: unknown, agentId: string): boolean {
    return error instanceof Error && error.message.includes('not found') && error.message.includes(agentId);
  }

  private isConfigChangedSinceLastLoadError(error: unknown): boolean {
    return error instanceof Error && /config changed|baseHash|hash/i.test(error.message);
  }

  private readConfigGetResult(payload: unknown): { readonly config: unknown; readonly hash: string | null } {
    const record = this.readRecord(payload);
    const result = this.readRecord(record.result);
    return {
      config: 'config' in record ? record.config : result.config,
      hash: this.readString(record.hash) || this.readString(record.baseHash) || this.readString(result.hash) || this.readString(result.baseHash),
    };
  }

  private readAgentId(payload: unknown): string | null {
    const record = this.readRecord(payload);
    const directAgentId = this.readString(record.agentId);
    if (directAgentId) {
      return directAgentId;
    }
    const result = this.readRecord(record.result);
    const resultAgentId = this.readString(result.agentId);
    if (resultAgentId) {
      return resultAgentId;
    }
    const directAgent = this.readRecord(record.agent);
    const directNestedAgentId = this.readString(directAgent.id) || this.readString(directAgent.agentId) || this.readString(directAgent.name);
    if (directNestedAgentId) {
      return directNestedAgentId;
    }
    const resultAgent = this.readRecord(result.agent);
    return this.readString(resultAgent.id) || this.readString(resultAgent.agentId) || this.readString(resultAgent.name);
  }

  private readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}

const MATCHACLAW_CONTEXT_BEGIN_MARKER = '<!-- matchaclaw:begin -->';
const MATCHACLAW_CONTEXT_END_MARKER = '<!-- matchaclaw:end -->';

function appendTeamRunProjectionBlock(currentContent: string, teamId: string, blockContent: string): string {
  const currentWithoutTeamRunBlock = removeTeamRunProjectionBlock(currentContent, teamId).trimEnd();
  const block = [teamRunProjectionStartMarker(teamId), blockContent.trim(), teamRunProjectionEndMarker(teamId)].join('\n');
  const contextMarkerIndex = findMatchaClawContextBlockStart(currentWithoutTeamRunBlock);
  if (contextMarkerIndex < 0) {
    return [currentWithoutTeamRunBlock, block, ''].filter((part, index) => index === 2 || part.length > 0).join('\n\n');
  }
  const beforeContext = currentWithoutTeamRunBlock.slice(0, contextMarkerIndex).trimEnd();
  const contextBlockAndAfter = currentWithoutTeamRunBlock.slice(contextMarkerIndex).trimStart();
  return [beforeContext, block, contextBlockAndAfter, ''].filter((part, index) => index === 3 || part.length > 0).join('\n\n');
}

function findMatchaClawContextBlockStart(content: string): number {
  const beginIndex = content.indexOf(MATCHACLAW_CONTEXT_BEGIN_MARKER);
  if (beginIndex < 0) {
    return -1;
  }
  const endIndex = content.indexOf(MATCHACLAW_CONTEXT_END_MARKER, beginIndex + MATCHACLAW_CONTEXT_BEGIN_MARKER.length);
  return endIndex >= 0 ? beginIndex : -1;
}

function removeTeamRunProjectionBlock(content: string, teamId: string): string {
  const startMarker = teamRunProjectionStartMarker(teamId);
  const endMarker = teamRunProjectionEndMarker(teamId);
  let remaining = content;
  while (true) {
    const startIndex = remaining.indexOf(startMarker);
    if (startIndex < 0) {
      return remaining.replace(/\n{3,}/g, '\n\n').trimEnd() + (remaining.trimEnd() ? '\n' : '');
    }
    const endIndex = remaining.indexOf(endMarker, startIndex + startMarker.length);
    if (endIndex < 0) {
      return remaining;
    }
    const removeEndIndex = endIndex + endMarker.length;
    remaining = `${remaining.slice(0, startIndex).trimEnd()}\n\n${remaining.slice(removeEndIndex).trimStart()}`;
  }
}

function teamRunProjectionStartMarker(teamId: string): string {
  return `<!-- matchaclaw-teamrun:start:${teamId} -->`;
}

function teamRunProjectionEndMarker(teamId: string): string {
  return `<!-- matchaclaw-teamrun:end:${teamId} -->`;
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function removeInlinePersonaForTeammateSection(markdown: string): string {
  const inlinePersonaHeading = /^##\s+Inline Persona for Teammate\s*$/im;
  const match = inlinePersonaHeading.exec(markdown);
  if (!match || match.index === undefined) {
    return markdown;
  }
  const beforeSection = markdown.slice(0, match.index).trimEnd();
  const afterHeading = markdown.slice(match.index + match[0].length);
  const nextSectionMatch = /^##\s+/m.exec(afterHeading);
  const afterSection = nextSectionMatch ? afterHeading.slice(nextSectionMatch.index) : '';
  return [beforeSection, afterSection.trimStart()].filter(Boolean).join('\n\n');
}

function formatTeamAgentMaterializationLogMessage(
  logContext: TeamAgentMaterializationLogContext | undefined,
  fields: TeamAgentMaterializationLogFields,
): string {
  const mergedFields: TeamAgentMaterializationLogFields = {
    ...(logContext ?? {}),
    ...fields,
  };
  const entries = Object.entries(mergedFields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatTeamAgentMaterializationLogValue(value)}`);
  return `[openclaw-team-agent-materialization] ${entries.join(' ')}`;
}

function formatTeamAgentMaterializationLogValue(value: TeamAgentMaterializationLogValue): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(redactTeamAgentMaterializationLogString(value));
  }
  return String(value);
}

function safeTeamAgentMaterializationErrorMessage(error: unknown, fallbackMessage: string): string {
  if (!(error instanceof Error)) {
    return fallbackMessage;
  }
  return error.message;
}

function redactTeamAgentMaterializationLogString(value: string): string {
  return truncateTeamAgentMaterializationLogString(value
    .replace(/(api[_-]?key|authorization|password|token|secret)=([^\s]+)/gi, '$1=[redacted]')
    .replace(/(^|[^a-zA-Z0-9_-])(sk-[a-zA-Z0-9_-]{8,})/g, '$1[redacted-secret]'));
}

function truncateTeamAgentMaterializationLogString(value: string): string {
  const maxLogStringLength = 240;
  if (value.length <= maxLogStringLength) {
    return value;
  }
  return `${value.slice(0, maxLogStringLength)}...(${value.length} chars)`;
}

function selectTopLevelTeamBuddyWorkspacePaths(workspacePaths: readonly string[], teamBuddyRootPath: string): string[] {
  const rootPath = path.resolve(teamBuddyRootPath);
  const safeWorkspacePaths = Array.from(new Set(workspacePaths.map((workspacePath) => path.resolve(workspacePath))))
    .filter((workspacePath) => isPathInsideDirectory(workspacePath, rootPath))
    .sort((left, right) => left.length - right.length);
  const selected: string[] = [];
  for (const workspacePath of safeWorkspacePaths) {
    if (!selected.some((parentPath) => workspacePath === parentPath || isPathInsideDirectory(workspacePath, parentPath))) {
      selected.push(workspacePath);
    }
  }
  return selected;
}

function isPathInsideDirectory(candidatePath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function sanitizePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'team-skill';
}
