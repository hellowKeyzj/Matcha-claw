import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  TEAM_AGENT_ID_PREFIX,
  TEAM_LEADER_ROLE_ID,
  TEAM_MANAGED_AGENT_CONFIG_KIND,
  TEAM_MANAGED_AGENT_CONFIG_SOURCE,
  TEAM_MANAGED_AGENT_CONFIG_VERSION,
  TEAM_MANAGED_AGENT_KIND,
  TEAM_MANAGED_AGENT_SANDBOX,
  TEAM_MANAGED_AGENT_TOOLS_PROFILE,
  TEAM_LEADER_SUBAGENT_TOOLS,
  TEAM_ROLE_MANAGED_DENIED_TOOLS,
  TEAM_ROLE_RUNTIME_TOOLS,
  type TeamManagedAgentConfigProjection,
  type TeamRoleAgentConfigProjection,
  type TeamRoleBinding,
} from '../domain/team-role.js'
import type { TeamSkillPackage } from '../domain/team-skill-package.js'
import { atomicWriteJson } from '../infrastructure/atomic-json.js'
import { FileRoleBindingStore } from '../infrastructure/file-role-binding-store.js'

export interface TeamProvisioningServiceDeps {
  storageRoot: string
  roleStore?: FileRoleBindingStore
}

export interface ProvisionRoleAgentsResult {
  roles: TeamRoleBinding[]
  agentConfigProjection: TeamRoleAgentConfigProjection[]
  managedConfigProjection: TeamManagedAgentConfigProjection
}

export class TeamProvisioningService {
  private readonly roleStore: FileRoleBindingStore

  constructor(private readonly deps: TeamProvisioningServiceDeps) {
    this.roleStore = deps.roleStore ?? new FileRoleBindingStore()
  }

  async provisionRoleAgents(input: {
    runtimeRoot: string
    runId: string
    teamSkillPackage: TeamSkillPackage
  }): Promise<ProvisionRoleAgentsResult> {
    const roles = input.teamSkillPackage.roles.map((role) => {
      this.assertProvisionableRole(role.id)
      this.assertProvisionableRoleTools(role.id, role.tools, input.teamSkillPackage.dependencies.requiredTools, input.teamSkillPackage.dependencies.optionalTools)
      const workspaceDir = path.join(input.runtimeRoot, 'roles', role.id)
      return {
        runId: input.runId,
        roleId: role.id,
        agentId: this.buildAgentId(input.runId, role.id),
        agentName: role.id,
        workspaceDir,
        agentDir: path.join(this.deps.storageRoot, 'agents', sanitizePathSegment(input.runId), role.id, 'agent'),
        skills: role.skills,
        tools: role.tools,
        status: 'provisioned' as const,
      }
    })
    this.assertUniqueAgentIds(input.runId, roles)

    try {
      for (const binding of roles) {
        const roleSpec = input.teamSkillPackage.roles.find((role) => role.id === binding.roleId)
        if (!roleSpec) {
          throw new Error(`Role spec not found: ${binding.roleId}`)
        }
        await mkdir(binding.workspaceDir, { recursive: true })
        await mkdir(binding.agentDir, { recursive: true })
        await writeFile(path.join(binding.workspaceDir, 'AGENTS.md'), roleSpec.agentsMd, 'utf8')
      }

      await this.writeLeaderWorkspace(input.runtimeRoot, input.runId, input.teamSkillPackage, roles)

      const agentConfigProjection = [
        this.toLeaderConfigProjection(input.runtimeRoot, input.runId, roles),
        ...roles.map((role) => this.toRoleConfigProjection(role)),
      ]
      const managedConfigProjection: TeamManagedAgentConfigProjection = {
        kind: TEAM_MANAGED_AGENT_CONFIG_KIND,
        version: TEAM_MANAGED_AGENT_CONFIG_VERSION,
        source: TEAM_MANAGED_AGENT_CONFIG_SOURCE,
        runId: input.runId,
        leaderAgentId: this.buildAgentId(input.runId, TEAM_LEADER_ROLE_ID),
        agents: agentConfigProjection,
      }
      await this.roleStore.save(input.runtimeRoot, roles)
      await atomicWriteJson(path.join(input.runtimeRoot, 'managed', 'openclaw-agents.json'), managedConfigProjection)

      return { roles, agentConfigProjection, managedConfigProjection }
    } catch (error) {
      await this.cleanupProvisionedArtifacts(input.runtimeRoot, input.runId, roles)
      throw error
    }
  }

  private async cleanupProvisionedArtifacts(runtimeRoot: string, runId: string, roles: TeamRoleBinding[]): Promise<void> {
    await Promise.all([
      rm(path.join(runtimeRoot, 'leader'), { recursive: true, force: true }),
      rm(path.join(runtimeRoot, 'managed'), { recursive: true, force: true }),
      rm(path.join(runtimeRoot, 'roles.json'), { force: true }),
      ...roles.map((role) => rm(role.workspaceDir, { recursive: true, force: true })),
      ...roles.map((role) => rm(role.agentDir, { recursive: true, force: true })),
      rm(this.leaderAgentDir(runId), { recursive: true, force: true }),
    ])
  }

  private async writeLeaderWorkspace(
    runtimeRoot: string,
    runId: string,
    teamSkillPackage: TeamSkillPackage,
    roles: TeamRoleBinding[],
  ): Promise<void> {
    const leaderWorkspace = this.leaderWorkspaceDir(runtimeRoot)
    await mkdir(leaderWorkspace, { recursive: true })
    await mkdir(this.leaderAgentDir(runId), { recursive: true })
    await writeFile(path.join(leaderWorkspace, 'AGENTS.md'), this.buildLeaderAgentsMd(teamSkillPackage, roles), 'utf8')
    await writeFile(path.join(leaderWorkspace, 'workflow.md'), teamSkillPackage.workflow.markdown, 'utf8')
    await writeFile(path.join(leaderWorkspace, 'bind.md'), teamSkillPackage.bind.markdown, 'utf8')
  }

  private buildLeaderAgentsMd(teamSkillPackage: TeamSkillPackage, roles: TeamRoleBinding[]): string {
    return [
      `# Team Leader: ${teamSkillPackage.name}`,
      '',
      'You orchestrate this TeamSkill run. Do not perform role work yourself.',
      'Dispatch role agents sequentially according to workflow.md and bind.md.',
      'Use explicit agent ids for subagent dispatch; do not spawn unspecified agents.',
      '',
      '## Role roster',
      ...roles.map((role) => `- ${role.roleId}: ${role.agentId}`),
      '',
    ].join('\n')
  }

  private toLeaderConfigProjection(runtimeRoot: string, runId: string, roles: TeamRoleBinding[]): TeamRoleAgentConfigProjection {
    return {
      id: this.buildAgentId(runId, 'leader'),
      name: 'leader',
      workspace: this.leaderWorkspaceDir(runtimeRoot),
      agentDir: this.leaderAgentDir(runId),
      skills: [],
      managedBy: TEAM_MANAGED_AGENT_CONFIG_SOURCE,
      source: TEAM_MANAGED_AGENT_CONFIG_SOURCE,
      managedRunId: runId,
      managedRoleId: TEAM_LEADER_ROLE_ID,
      managedKind: TEAM_MANAGED_AGENT_KIND,
      subagents: {
        allowAgents: roles.map((role) => role.agentId),
        requireAgentId: true,
      },
      tools: {
        profile: TEAM_MANAGED_AGENT_TOOLS_PROFILE,
        alsoAllow: [...TEAM_LEADER_SUBAGENT_TOOLS],
        deny: [],
      },
      sandbox: { ...TEAM_MANAGED_AGENT_SANDBOX },
    }
  }

  private toRoleConfigProjection(role: TeamRoleBinding): TeamRoleAgentConfigProjection {
    return {
      id: role.agentId,
      name: role.agentName,
      workspace: role.workspaceDir,
      agentDir: role.agentDir,
      skills: role.skills,
      managedBy: TEAM_MANAGED_AGENT_CONFIG_SOURCE,
      source: TEAM_MANAGED_AGENT_CONFIG_SOURCE,
      managedRunId: role.runId,
      managedRoleId: role.roleId,
      managedKind: TEAM_MANAGED_AGENT_KIND,
      tools: {
        profile: TEAM_MANAGED_AGENT_TOOLS_PROFILE,
        allow: Array.from(new Set([...role.tools, ...TEAM_ROLE_RUNTIME_TOOLS])),
        deny: [...TEAM_ROLE_MANAGED_DENIED_TOOLS],
      },
      sandbox: { ...TEAM_MANAGED_AGENT_SANDBOX },
    }
  }

  private leaderWorkspaceDir(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'leader')
  }

  private leaderAgentDir(runId: string): string {
    return path.join(this.deps.storageRoot, 'agents', sanitizePathSegment(runId), 'leader', 'agent')
  }

  private buildAgentId(runId: string, roleId: string): string {
    return `${TEAM_AGENT_ID_PREFIX}${runId}:${roleId}`
  }

  private assertProvisionableRole(roleId: string): void {
    const rolePathSegment = sanitizePathSegment(roleId)
    if (rolePathSegment !== roleId) {
      throw new Error(`Invalid Team role id for provisioning: ${roleId}`)
    }
    if (roleId === TEAM_LEADER_ROLE_ID) {
      throw new Error(`Team role id is reserved for provisioning: ${roleId}`)
    }
  }

  private assertUniqueAgentIds(runId: string, roles: TeamRoleBinding[]): void {
    const seen = new Set([this.buildAgentId(runId, TEAM_LEADER_ROLE_ID)])
    for (const role of roles) {
      if (seen.has(role.agentId)) {
        throw new Error(`Duplicate Team managed agent id: ${role.agentId}`)
      }
      seen.add(role.agentId)
    }
  }

  private assertProvisionableRoleTools(roleId: string, tools: string[], requiredTools: string[], optionalTools: string[]): void {
    const declaredTools = new Set([...requiredTools, ...optionalTools])
    for (const tool of tools) {
      if (!declaredTools.has(tool)) {
        throw new Error(`Role ${roleId} references tool ${tool}, but dependencies.yaml does not declare it.`)
      }
      if (TEAM_ROLE_MANAGED_DENIED_TOOLS.includes(tool as typeof TEAM_ROLE_MANAGED_DENIED_TOOLS[number])) {
        throw new Error(`Role ${roleId} cannot allow denied managed agent tool: ${tool}`)
      }
    }
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_')
}
