import path from 'node:path';
import { buildTeamManagedAgentId, teamManagedAgentTeamPrefix } from '../../domain/team-managed-agent';
import type { TeamManagedAgentRecord } from '../../domain/team-instance';
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
const TEAM_ROLE_REQUIRED_TOOLS = ['team_complete_task', 'team_request_approval', 'team_send_message'] as const;
const TEAM_ROLE_DENIED_TOOLS = ['sessions_spawn', 'sessions_yield', 'subagents'] as const;
const TEAM_AGENT_TOOLS_PROFILE = 'full';
const TEAM_AGENT_SANDBOX = { mode: 'off' } as const;

interface OpenClawTeamAgentMaterializationLogger {
  readonly debug: (message: string) => void;
  readonly error?: (message: string) => void;
}

interface OpenClawTeamAgentMaterializationAdapterDeps {
  readonly gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
  readonly capabilities: GatewayPluginCapabilityPort;
  readonly fileSystem: Pick<RuntimeFileSystemPort, 'ensureDirectory' | 'writeTextFile' | 'removeFile' | 'removeDirectory'>;
  readonly openClawConfigDir: string;
  readonly logger?: OpenClawTeamAgentMaterializationLogger;
}

type TeamAgentMaterializationLogValue = string | number | boolean | null | undefined | Readonly<Record<string, string | number | boolean | null | undefined>>;
type TeamAgentMaterializationLogFields = Readonly<Record<string, TeamAgentMaterializationLogValue>>;

interface TeamAgentMaterializationLogContext {
  readonly teamId: string;
}

interface MaterializedRoleAgent {
  readonly role: TeamRoleAgentMaterializationSpec;
  readonly agentId: string;
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

export class OpenClawTeamAgentMaterializationAdapter implements TeamAgentMaterializationPort {
  constructor(private readonly deps: OpenClawTeamAgentMaterializationAdapterDeps) {}

  async materialize(input: TeamAgentMaterializationSpec): Promise<TeamAgentMaterializationResult> {
    const startedAt = Date.now();
    const logContext: TeamAgentMaterializationLogContext = { teamId: input.teamId };
    const leader = this.materializedRoleAgent(input.teamId, input.leader);
    const roles = input.roles.map((role) => this.materializedRoleAgent(input.teamId, role));
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
      await this.requireMethod('agents.create', logContext);
      await this.requireMethod('agents.update', logContext);
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
      await this.writeTeamBuddyProjection(projection, logContext);
      await this.writeTeamAgentConfigPatches(configPatches, roles, logContext);

      const result = this.toMaterializationResult(input, leader, roles, projection);
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
    if (input.agentIds.length === 0) {
      return;
    }
    await this.requireMethod('agents.delete');
    const managedTeamAgentIdPrefix = teamManagedAgentTeamPrefix(input.teamId);
    for (const agentId of input.agentIds) {
      if (!agentId.startsWith(managedTeamAgentIdPrefix)) {
        throw new Error(`Refusing to remove non-Team OpenClaw agent for team ${input.teamId}: ${agentId}`);
      }
      try {
        await this.callGateway('agents.delete', {
          agentId,
          deleteFiles: true,
        });
      } catch (error) {
        if (!this.isAgentNotFoundError(error, agentId)) {
          throw error;
        }
      }
    }
    await this.removeTeamBuddyWorkspaces(input.workspacePaths ?? []);
  }

  private toMaterializationResult(
    input: TeamAgentMaterializationSpec,
    leader: MaterializedRoleAgent,
    roles: readonly MaterializedRoleAgent[],
    projection: { readonly leaderWorkspacePath: string; readonly roleWorkspacePaths: ReadonlyMap<string, string> },
  ): TeamAgentMaterializationResult {
    return {
      teamId: input.teamId,
      managedAgents: [
        this.toManagedAgentRecord(input.teamId, input.endpoint, leader, projection.leaderWorkspacePath),
        ...roles.map((roleAgent) => {
          const workspace = projection.roleWorkspacePaths.get(roleAgent.role.roleId);
          if (!workspace) {
            throw new Error(`Team role workspace projection was not created for role ${roleAgent.role.roleId}`);
          }
          return this.toManagedAgentRecord(input.teamId, input.endpoint, roleAgent, workspace);
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
      this.logDebug(logContext, {
        stage: 'agent.existing',
        method: 'agents.list',
        roleId: roleAgent.role.roleId,
        agentId: roleAgent.agentId,
        workspacePath: existingAgent.workspace,
      });
      this.assertExistingAgentIsTeamManaged(roleAgent, existingAgent, logContext);
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

  private buildAgentCreatePayload(roleAgent: MaterializedRoleAgent, workspacePath: string): Record<string, unknown> {
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

  private buildAgentTools(roleAgent: MaterializedRoleAgent): Record<string, unknown> {
    if (roleAgent.role.roleId === 'leader') {
      return { profile: TEAM_AGENT_TOOLS_PROFILE };
    }
    return {
      profile: TEAM_AGENT_TOOLS_PROFILE,
      allow: Array.from(new Set([...TEAM_ROLE_REQUIRED_TOOLS, ...(roleAgent.role.tools ?? [])])),
      deny: [...TEAM_ROLE_DENIED_TOOLS],
    };
  }

  private async writeTeamAgentConfigPatches(
    patches: readonly MaterializedRoleAgentConfigPatch[],
    roleAgents: readonly MaterializedRoleAgent[],
    logContext: TeamAgentMaterializationLogContext,
  ): Promise<void> {
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
      const nextConfig = this.patchTeamAgentsConfig(configGetResult.config, patches, roleAgents, logContext);
      try {
        await this.callGateway('config.set', {
          raw: JSON.stringify(nextConfig),
          baseHash: configGetResult.hash,
        }, logContext, {
          stage: 'config.set',
          patchCount: patches.length,
          roleCount: roleAgents.length,
          attempt: attempt + 1,
        });
        return;
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
  }

  private patchTeamAgentsConfig(
    config: unknown,
    patches: readonly MaterializedRoleAgentConfigPatch[],
    roleAgents: readonly MaterializedRoleAgent[],
    logContext: TeamAgentMaterializationLogContext,
  ): Record<string, unknown> {
    const startedAt = Date.now();
    const nextConfig = this.readRecord(config);
    const agents = this.readRecord(nextConfig.agents);
    const list = Array.isArray(agents.list) ? [...agents.list] : [];
    const originalEntryCount = list.length;
    for (const patch of patches) {
      this.upsertTeamAgentConfigEntry(list, patch, roleAgents, logContext);
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
    return nextConfig;
  }

  private upsertTeamAgentConfigEntry(
    list: unknown[],
    patch: MaterializedRoleAgentConfigPatch,
    roleAgents: readonly MaterializedRoleAgent[],
    logContext: TeamAgentMaterializationLogContext,
  ): void {
    const targetIndex = list.findIndex((entry) => this.readString(this.readRecord(entry).id) === patch.roleAgent.agentId);
    const current = targetIndex >= 0 ? this.readRecord(list[targetIndex]) : {};
    const nextEntry: Record<string, unknown> = {
      ...current,
      id: patch.roleAgent.agentId,
      name: patch.roleAgent.role.agentName,
      workspace: patch.workspacePath,
      tools: this.buildAgentTools(patch.roleAgent),
      sandbox: TEAM_AGENT_SANDBOX,
    };
    delete nextEntry.skipBootstrap;
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
    if (patch.roleAgent.role.roleId === 'leader') {
      nextEntry.subagents = {
        allowAgents: roleAgents.map((agent) => agent.agentId),
        requireAgentId: true,
      };
    } else {
      delete nextEntry.subagents;
    }
    this.logDebug(logContext, {
      stage: targetIndex >= 0 ? 'config.patch.update' : 'config.patch.create',
      method: 'config.set',
      roleId: patch.roleAgent.role.roleId,
      agentId: patch.roleAgent.agentId,
      workspacePath: patch.workspacePath,
      toolAllowCount: Array.isArray(this.readRecord(nextEntry.tools).allow) ? (this.readRecord(nextEntry.tools).allow as unknown[]).length : 0,
      skillCount: Array.isArray(nextEntry.skills) ? nextEntry.skills.length : 0,
      subagentCount: patch.roleAgent.role.roleId === 'leader' ? roleAgents.length : 0,
    });
    if (targetIndex >= 0) {
      list[targetIndex] = nextEntry;
      return;
    }
    list.push(nextEntry);
  }

  private assertExistingAgentIsTeamManaged(
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
    const leaderWorkspacePath = path.join(this.deps.openClawConfigDir, TEAMBUDDY_DIRECTORY_NAME, teamSkillDirectoryName);
    const teamSkillPackagePath = path.join(leaderWorkspacePath, 'skills', teamSkillDirectoryName);
    const leaderFiles: TeamBuddyProjectionFile[] = [
      { filePath: path.join(leaderWorkspacePath, 'AGENTS.md'), content: this.buildLeaderAgentsMd(input, roles, teamSkillDirectoryName) },
      { filePath: path.join(leaderWorkspacePath, 'TOOLS.md'), content: this.buildLeaderToolsMd() },
      { filePath: path.join(leaderWorkspacePath, 'dependencies.json'), content: `${JSON.stringify(input.teamSkill.dependencies, null, 2)}\n` },
      { filePath: path.join(teamSkillPackagePath, 'SKILL.md'), content: input.teamSkill.skillMarkdown },
      { filePath: path.join(teamSkillPackagePath, 'workflow.md'), content: input.teamSkill.workflowMarkdown },
      { filePath: path.join(teamSkillPackagePath, 'dependencies.yaml'), content: input.teamSkill.dependenciesYaml },
      ...(input.teamSkill.bindMarkdown === undefined ? [] : [{ filePath: path.join(teamSkillPackagePath, 'bind.md'), content: input.teamSkill.bindMarkdown }]),
    ];
    const roleWorkspacePaths = new Map<string, string>();
    const roleProjections = roles.map((roleAgent): TeamBuddyRoleProjection => {
      const roleDirectoryName = sanitizePathSegment(roleAgent.role.roleId);
      const roleWorkspacePath = path.join(leaderWorkspacePath, 'roles', roleDirectoryName);
      const roleMarkdown = roleAgent.role.files.find((file) => file.path === `${roleAgent.role.roleId}.md`)?.content
        ?? roleAgent.role.files.find((file) => file.path === 'AGENTS.md')?.content
        ?? '';
      roleWorkspacePaths.set(roleAgent.role.roleId, roleWorkspacePath);
      return {
        roleAgent,
        roleWorkspacePath,
        files: [
          { filePath: path.join(teamSkillPackagePath, 'roles', `${roleDirectoryName}.md`), content: roleMarkdown },
          { filePath: path.join(roleWorkspacePath, 'AGENTS.md'), content: removeInlinePersonaForTeammateSection(roleMarkdown) },
          { filePath: path.join(roleWorkspacePath, 'TOOLS.md'), content: this.buildRoleToolsMd() },
        ],
      };
    });
    return { leader, leaderWorkspacePath, roleWorkspacePaths, leaderFiles, roleProjections };
  }

  private async writeTeamBuddyProjection(
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
      await this.writeProjectionFile(file.filePath, file.content);
    }

    for (const roleProjection of projection.roleProjections) {
      const roleProjectionStartedAt = Date.now();
      await this.deps.fileSystem.ensureDirectory(roleProjection.roleWorkspacePath);
      for (const file of roleProjection.files) {
        await this.writeProjectionFile(file.filePath, file.content);
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

  private async writeProjectionFile(filePath: string, content: string): Promise<void> {
    await this.deps.fileSystem.ensureDirectory(path.dirname(filePath));
    await this.deps.fileSystem.writeTextFile(filePath, content);
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
      `# TeamSkill Leader`,
      '',
      '你是这个本地 TeamSkill 包的 leader。先判断用户消息应该直接回答、澄清，还是编排 TeamRun。',
      '',
      '## 事实来源',
      '',
      `把 ${input.teamSkill.name} 当作一个普通本地 TeamSkill 使用。这个包是 workflow、roles、约束、依赖和输出形态的权威来源。`,
      '',
      '- AGENTS.md — leader 长期操作规则',
      '- TOOLS.md — TeamRun 工具契约和 payload 规则',
      `- skills/${teamSkillDirectoryName}/SKILL.md — TeamSkill 入口`,
      `- skills/${teamSkillDirectoryName}/workflow.md — workflow 阶段`,
      `- skills/${teamSkillDirectoryName}/bind.md — role 绑定和约束；存在时必须参考`,
      `- skills/${teamSkillDirectoryName}/dependencies.yaml — 原始依赖清单`,
      '- dependencies.json — 解析后的依赖清单',
      `- skills/${teamSkillDirectoryName}/roles/{roleId}.md — 原始 TeamSkill role 文件，供 leader 构造任务上下文`,
      '- roles/{roleId}/AGENTS.md — 对应 role agent 运行时加载的人设',
      '',
      'TeamSkill 包已经定义的 workflow、roles、约束和输出格式，不要自行发明。',
      '',
      '## 首次判断',
      '',
      '每次行动前，把用户消息严格归为下面一种模式。',
      '',
      '### DIRECT',
      '',
      '当单个 leader 回复就足够时使用 DIRECT。包括普通聊天、询问 TeamSkill 能做什么、解释 role、解释 workflow、依赖问题、适用性问题、轻量建议、简单总结和小型文本转换。',
      '',
      'DIRECT 模式：',
      '- 直接回答。',
      '- 可以查看 TeamSkill 包文件。',
      '- 不要调用 Team Submit Workflow Plan。',
      '- 不要声称 role agents 已经运行。',
      '',
      '### CLARIFY',
      '',
      '当请求可能需要执行，但目标、对象、约束或输出形态不清，无法可靠生成 workflow plan 时使用 CLARIFY。',
      '',
      'CLARIFY 模式：',
      '- 只问最小必要澄清。',
      '- 不要过度追问。',
      '- 暂时不要调用 Team Submit Workflow Plan。',
      '',
      '### ORCHESTRATE',
      '',
      '当用户要求团队执行工作、处理材料、产出交付物、分析、评估、审查、规划、推荐、诊断、生成内容，或运行 TeamSkill workflow 时使用 ORCHESTRATE。',
      '',
      'ORCHESTRATE 模式：',
      '- 使用本地 TeamSkill 作为控制规则。',
      '- 分派前按顺序读取 SKILL.md、workflow.md、存在时的 bind.md、dependencies.yaml、dependencies.json，以及需要的 roles/*.md；不要并发读取多个 TeamSkill 文件。',
      '- 根据 TeamSkill workflow 构造一个完整 workflow plan。',
      '- 调用前按 TOOLS.md 做 schema 自检；尤其确认顶层 groups 存在，且每个 taskId 都被某个 group.taskIds 引用。',
      '- 按 TOOLS.md 的契约调用 Team Submit Workflow Plan。',
      '- 工具调用成功前，不要把团队工作说成已经完成。',
      '',
      '默认使用 DIRECT。只有明确是可执行的团队工作才升级到 ORCHESTRATE。只有歧义会实质影响执行或输出质量时才使用 CLARIFY。',
      '',
      '## TeamSkill preflight',
      '',
      '调用 Team Submit Workflow Plan 前：',
      `1. 读取 skills/${teamSkillDirectoryName}/SKILL.md。`,
      `2. 等上一步完成后，读取 skills/${teamSkillDirectoryName}/workflow.md。`,
      `3. 等上一步完成后，存在时读取 skills/${teamSkillDirectoryName}/bind.md。`,
      `4. 等上一步完成后，读取 skills/${teamSkillDirectoryName}/dependencies.yaml 和 dependencies.json。`,
      `5. 等上一步完成后，逐个读取需要的 skills/${teamSkillDirectoryName}/roles/{roleId}.md 文件；不要一次并发读取多个 role 文件。`,
      '6. 从 SKILL.md 提取 canonical role roster，并和下面的 Role roster 交叉核对。',
      '7. 检查是否缺少必需上下文或必需依赖。',
      '8. 提交前逐项核对工具入参：title、groups、tasks、idempotencyKey 都在顶层；summary 可选；没有 runId；没有额外字段。',
      '9. 核对 groups：并行任务也必须有 group；每个 taskId 都出现在且只出现在一个 group.taskIds 中；join 三个字段齐全。',
      '',
      '如果缺少必需依赖或必需用户上下文，不要提交假的 workflow plan；直接索要缺失输入或说明阻塞原因。如果只缺少可选依赖，只有 TeamSkill 允许降级执行时才继续，并在相关 task prompt 或最终综合中说明限制。',
      '',
      '## Role roster',
      '',
      'Role roster 是封闭集合。下面这些值才是 tasks[].roleId 的唯一合法值。',
      '',
      ...roles.map((roleAgent) => `- ${roleAgent.role.roleId}`),
      '',
      '不要使用 roleId "leader"、展示名、managed agent id、自造别名，或不存在的 helper/reviewer/integrator role。',
      '',
      '## Leader work is not workflow task work',
      '',
      'Leader 可以分类请求、读取 TeamSkill 包、提取共享上下文、设计 workflow plan、处理 leader-only workflow 步骤，并综合最终输出。Leader 工作必须留在 tasks[] 之外，不要把 leader 工作提交成 workflow task。',
      '',
      '## Role task prompt construction',
      '',
      '每个 role task prompt 必须包含用户任务上下文、leader 提取的共享上下文、role assignment、期望输出格式、依赖或限制说明，以及 role 文件中存在的 "Inline Persona for Teammate" 章节。不要假设 role agent 会自己读取原始 role 文件。',
      '',
      '## 示例',
      '',
      '- 用户问这个 team 能做什么 -> DIRECT。',
      '- 用户问有哪些 roles -> DIRECT。',
      '- 用户问需要什么输入 -> DIRECT。',
      '- 用户只说“看看这个”，但没有目标或输出要求 -> CLARIFY。',
      '- 用户说“用这个 team 跑一下这些材料” -> ORCHESTRATE。',
      '- 用户要求完整审查、报告、计划、推荐或 workflow output -> ORCHESTRATE。',
      '',
      '错误行为：',
      '- 不要为了普通解释调用 Team Submit Workflow Plan。',
      '- 用户明确要求团队交付物时，不要只由 leader 直接回答。',
      '- 不要提交 roleId "leader"。',
      '- 不要把 managed agent id 当作 roleId。',
      '- 不要创建 SKILL.md 未声明的 role。',
      '',
    ].join('\n');
  }

  private buildLeaderToolsMd(): string {
    return [
      '# TeamRun Tools',
      '',
      '只在 ORCHESTRATE 模式使用 Team Submit Workflow Plan。它是 TeamSkill role work 唯一支持的分派机制。',
      '',
      '## Team Submit Workflow Plan',
      '',
      '只提交 role-level workflow tasks。runtime 已经能从 leader session context 知道当前 TeamRun。',
      '',
      '顶层字段规则：',
      '- 必填：title、groups、tasks、idempotencyKey。',
      '- title 是最外层 workflow plan 标题；group.title 和 task.title 不能替代顶层 title。',
      '- 可选：summary。',
      '- 必须一次性提交完整 JSON object；不要只提交 tasks，也不要省略 title 或 groups。',
      '- 即使所有 tasks 都是并行执行，也必须创建至少一个 group，并把这些 taskId 全部放进该 group.taskIds。',
      '',
      '不要包含 runtime 字段，例如 runId、workflowPlanId、envelopeId、sessionKey、agentId、dispatchId、status、createdAt、sourceEndpoint、sourceAgentId、sourceSessionKey 或 sourceRoleId。',
      '',
      'Payload 形态；照这个骨架填完整，顶层 title 和 groups 都不可省略：',
      '```json',
      '{',
      '  "title": "<简短 workflow 标题>",',
      '  "summary": "<可选的简短 plan 摘要>",',
      '  "idempotencyKey": "<本次 plan attempt 的稳定语义 key>",',
      '  "groups": [',
      '    {',
      '      "groupId": "<稳定 group id>",',
      '      "title": "<简短 group 标题>",',
      '      "taskIds": ["<task id>"],',
      '      "join": {',
      '        "requireCompleted": true,',
      '        "allowFailed": false,',
      '        "retryLimit": 0',
      '      }',
      '    }',
      '  ],',
      '  "tasks": [',
      '    {',
      '      "taskId": "<稳定 task id>",',
      '      "roleId": "<TeamSkill role id>",',
      '      "title": "<简短 task 标题>",',
      '      "dependsOnTaskIds": [],',
      '      "prompt": "<完整 role task prompt>"',
      '    }',
      '  ]',
      '}',
      '```',
      '',
      'Task 规则：',
      '- tasks[].roleId 必须是 AGENTS.md Role roster 中列出的 TeamSkill role id。',
      '- tasks[].roleId 不能是 "leader"、展示名、managed agent id 或自造别名。',
      '- 每个 task 必须包含 taskId、roleId、title 和 prompt。',
      '- dependsOnTaskIds 可选；没有依赖时使用 [] 或省略。',
      '- outputArtifactKind 可选；只有 TeamSkill 指定期望 artifact kind 时才使用。',
      '- 每个 taskId 应该只出现在一个 groups[].taskIds 列表中。',
      '- dependsOnTaskIds 只能引用已声明的 taskId。',
      '',
      'Group 规则：',
      '- groups 是必填顶层数组，不是可选元数据。',
      '- 每个 group 必须包含 groupId、title、taskIds 和 join。',
      '- groups[].taskIds 必须列出该 group 内要分派的 taskId；每个 tasks[].taskId 都必须出现在且只出现在一个 group.taskIds 中。',
      '- 并行任务使用同一个 group；串行阶段使用多个 group，并用 tasks[].dependsOnTaskIds 表达任务依赖。',
      '- join 必须包含 requireCompleted、allowFailed 和 retryLimit。',
      '- retryLimit 必须是非负整数。',
      '',
      '正例：roleId 使用 Role roster 中列出的值',
      '```json',
      '{',
      '  "tasks": [',
      '    {',
      '      "taskId": "financial-analyst-anthropic",',
      '      "roleId": "financial-analyst",',
      '      "title": "Financial Analysis",',
      '      "prompt": "<role task prompt>"',
      '    }',
      '  ]',
      '}',
      '```',
      '',
      '反例：roleId 使用 managed agent id',
      '```json',
      '{',
      '  "tasks": [',
      '    {',
      '      "taskId": "financial-analyst-anthropic",',
      '      "roleId": "mct-1t2fjjf-financial-analyst-03a712r",',
      '      "title": "Financial Analysis",',
      '      "prompt": "<role task prompt>"',
      '    }',
      '  ]',
      '}',
      '```',
      '这个反例会被拒绝，因为 mct-* 是 managed agent id，不是 TeamSkill role id。',
      '',
      '常见错误：',
      '- 错误：只传 groups、summary、idempotencyKey、tasks。原因：缺少顶层必填 title；task.title 和 group.title 不能替代 workflow title。',
      '- 错误：只传 title、summary、idempotencyKey、tasks。原因：缺少必填 groups。',
      '- 错误：把 group 信息写进 summary 或 prompt。原因：schema 只读取顶层 groups。',
      '- 错误：把 roleId 写成 mct-* managed agent id。原因：runtime 只按 TeamSkill role id 绑定 role session。',
      '- 错误：把 runId 放进参数。原因：runtime 会从当前 leader session context 绑定 TeamRun。',
      '',
      '执行声明：',
      '- Team Submit Workflow Plan 成功前，不要说 roles 已分派、工作正在运行，或正在等待 role 输出。',
      '- 工具成功后，TeamRuntime 会自动分派 role agents。不要用 sessions_spawn、subagents、手动并行 sessions 或直接给 role-agent 发消息替代 workflow plan。',
      '',
    ].join('\n');
  }

  private buildRoleToolsMd(): string {
    return [
      '# TeamRun Role Tools',
      '',
      '## 何时使用工具',
      '',
      '| 场景 | 使用工具 |',
      '|---|---|',
      '| 当前 task 已完成 | Team Complete Task |',
      '| 继续执行前必须让用户确认高风险动作 | Team Request Approval |',
      '| 需要向 leader 或其他 role 发送说明、问题或返工请求 | Team Send Message |',
      '',
      '## Team Complete Task',
      '',
      '完成当前 task 时调用。不要在普通回复里假装完成；必须调用工具。',
      '',
      '必填字段：',
      '- workflowTaskId：task assignment mail 里的 Task id。',
      '- roleId：task assignment mail 里的 Role id，必须等于你自己的 role id。',
      '- summary：简短完成摘要，不要放完整长文。',
      '- idempotencyKey：稳定语义 key，重试同一次完成时保持不变。',
      '',
      '可选字段：',
      '- evidenceRefs：证据引用数组。只在需要保留输出、来源或较长结果时提供。',
      '',
      'evidenceRefs 规则：',
      '- inlineText.text 单条最多 20000 字符。',
      '- 长输出不能塞进一条 inlineText；如果没有真实文件或 artifact，就拆成多条 inlineText，每条少于 20000 字符，并用 label 标明 part 1/3、part 2/3。',
      '- workspacePath 只能引用当前 workspace 中真实存在或你实际创建的文件；没有写文件工具时不要编文件名。',
      '- uri 只能引用真实外部地址。',
      '- artifact 只能引用已存在 artifactId。',
      '',
      'Payload 形态：',
      '```json',
      '{',
      '  "workflowTaskId": "<Task id>",',
      '  "roleId": "<Role id>",',
      '  "summary": "<简短完成摘要>",',
      '  "evidenceRefs": [',
      '    {',
      '      "type": "inlineText",',
      '      "label": "<证据标签>",',
      '      "text": "<最多 20000 字符>"',
      '    }',
      '  ],',
      '  "idempotencyKey": "<稳定完成 key>"',
      '}',
      '```',
      '',
      '常见错误：',
      '- 错误：把 20000 字符以上的报告放进单条 inlineText。修正：拆成多条 inlineText，或引用真实文件/artifact。',
      '- 错误：工具失败后声称已经完成。修正：只有 Team Complete Task 成功后，task 才算完成。',
      '- 错误：用不存在的 workspacePath。修正：只引用真实存在或实际创建的文件。',
      '',
      '## Team Request Approval',
      '',
      '只有当前 task 需要用户批准高风险动作时使用。',
      '',
      '必填字段：workflowTaskId、roleId、reason、requestedAction、risk、idempotencyKey。',
      'reason 写为什么需要批准；requestedAction 写具体要做什么；risk 写不批准/批准的风险。',
      '',
      '## Team Send Message',
      '',
      '用于发送 audited team message，不用于完成 task。',
      '',
      '必填字段：kind、fromRoleId、toRoleId、summary、body、idempotencyKey。',
      'kind 只能是 note、question 或 kickback。kickback 必须包含 failureItems，并关联 relatedTaskId、relatedArtifactId 或 relatedGateId 中至少一个。',
      '',
      '## Critical reminders',
      '',
      '- 不要调用 Team Submit Workflow Plan；那是 leader 的工具。',
      '- 不要使用 sessions_spawn、subagents 或手动开新 session 替代 TeamRun。',
      '- 不要把 roleId 写成 managed agent id。',
      '- 不要把 runId、sessionKey、agentId 等 runtime 字段放进工具参数；runtime 会从当前 role session 绑定。',
      '- 工具报错时，按错误修正后重试；不要把失败说成成功。',
      '',
    ].join('\n');
  }

  private materializedRoleAgent(teamId: string, role: TeamRoleAgentMaterializationSpec): MaterializedRoleAgent {
    return {
      role,
      agentId: buildTeamManagedAgentId(teamId, role.roleId),
    };
  }

  private toManagedAgentRecord(teamId: string, endpoint: RuntimeEndpointRef, roleAgent: MaterializedRoleAgent, workspace: string): TeamManagedAgentRecord {
    return {
      teamId,
      roleId: roleAgent.role.roleId,
      agentId: roleAgent.agentId,
      displayName: roleAgent.role.agentName,
      workspace,
      endpoint,
      ...(roleAgent.role.model ? { model: roleAgent.role.model } : {}),
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
