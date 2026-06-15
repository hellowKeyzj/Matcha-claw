import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  buildTeamManagedAgentId,
  TEAM_LEADER_ROLE_ID,
  TEAM_LEADER_MANAGED_DENIED_TOOLS,
  TEAM_MANAGED_AGENT_CONFIG_KIND,
  TEAM_MANAGED_AGENT_CONFIG_SOURCE,
  TEAM_MANAGED_AGENT_CONFIG_VERSION,
  TEAM_MANAGED_AGENT_KIND,
  TEAM_MANAGED_AGENT_SANDBOX,
  TEAM_MANAGED_AGENT_TOOLS_PROFILE,
  TEAM_LEADER_RUNTIME_TOOLS,
  TEAM_ROLE_MANAGED_DENIED_TOOLS,
  TEAM_ROLE_RUNTIME_TOOLS,
  type TeamManagedAgentConfigProjection,
  type TeamRoleAgentConfigProjection,
  type TeamRoleBinding,
} from '../domain/team-role.js'
import type { TeamSkillDependencyEntry, TeamSkillPackage } from '../domain/team-skill-package.js'
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
      this.assertProvisionableRoleTools(role.id, role.tools, input.teamSkillPackage.dependencies.tools)
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
    await writeFile(path.join(leaderWorkspace, 'SKILL.md'), this.buildSkillSummary(teamSkillPackage), 'utf8')
    await writeFile(path.join(leaderWorkspace, 'workflow.md'), teamSkillPackage.workflow.markdown, 'utf8')
    await writeFile(path.join(leaderWorkspace, 'bind.md'), teamSkillPackage.bind.markdown, 'utf8')
    await writeFile(path.join(leaderWorkspace, 'dependencies.json'), JSON.stringify(teamSkillPackage.dependencies, null, 2), 'utf8')
    for (const roleSpec of teamSkillPackage.roles) {
      const roleDir = path.join(leaderWorkspace, 'roles', roleSpec.id)
      await mkdir(roleDir, { recursive: true })
      await writeFile(path.join(roleDir, 'AGENTS.md'), roleSpec.agentsMd, 'utf8')
    }
  }

  private buildLeaderAgentsMd(teamSkillPackage: TeamSkillPackage, roles: TeamRoleBinding[]): string {
    return [
      `# Team Leader: ${teamSkillPackage.name}`,
      '',
      'You orchestrate this TeamSkill run. Do not perform role work yourself.',
      '',
      '## Workspace layout',
      '- SKILL.md — skill overview',
      '- workflow.md — workflow stages',
      '- bind.md — role bindings and constraints',
      '- dependencies.json — dependency manifest',
      '- roles/{roleId}/AGENTS.md — role specification (one directory per role)',
      '',
      'Read all of the above before dispatching. Role specs are directories, not .md files.',
      '',
      '## Dispatch',
      String.raw`<team_workflow_orchestration>
You are the TeamRun leader. Your job is orchestration, not role execution.

Core contract:
- team_plan_workflow describes only work assigned to concrete Team roles from the roster.
- Leader-only work stays outside team_plan_workflow.
- Never include tasks with roleId "leader"; leader is orchestrator, not a workflow task role.
- Never use managed OpenClaw agent ids in tasks[].roleId.
- Every workflow task must include a concrete prompt for the assigned role.

Execution pattern:
1. Read SKILL.md, workflow.md, bind.md, dependencies.json, and each roles/{roleId}/AGENTS.md.
2. If workflow.md contains leader-only context extraction, perform that extraction yourself before calling team_plan_workflow.
3. Build team_plan_workflow with only concrete role-agent tasks.
4. Embed any leader-extracted context directly into each role task prompt that needs it.
5. After role artifacts finish, synthesize the final TeamRun output yourself as the leader response.

Role id rules:
- Valid tasks[].roleId values are exactly the Team role ids listed in the Role roster below.
- Invalid tasks[].roleId values include "leader", managed OpenClaw agent ids, display names, and ad-hoc aliases.

Correct example:
<example>
The workflow asks the leader to extract context, then asks Financial Analyst and Risk Analyst to work in parallel.
The leader first extracts the context personally, then calls team_plan_workflow with role tasks only:
{
  "tasks": [
    {
      "taskId": "financial-analysis",
      "roleId": "financial-analyst",
      "title": "Financial analysis",
      "dependsOnTaskIds": [],
      "prompt": "Use this leader-extracted context: ... Produce the financial lens."
    },
    {
      "taskId": "risk-analysis",
      "roleId": "risk-analyst",
      "title": "Risk analysis",
      "dependsOnTaskIds": [],
      "prompt": "Use this leader-extracted context: ... Produce the risk lens."
    }
  ]
}
</example>

Incorrect example:
<example>
Do not model leader work as a workflow task:
{
  "tasks": [
    {
      "taskId": "leader-context-extraction",
      "roleId": "leader",
      "title": "Extract context",
      "prompt": "Extract context for downstream roles."
    }
  ]
}
This is invalid because "leader" is not a dispatchable Team role and leader tasks cannot complete via team_submit_artifact.
</example>

Tool boundary:
- Your first orchestration action must be a successful team_plan_workflow call once you finish any leader-only context extraction.
- Until team_plan_workflow returns success, do not claim that roles were dispatched, do not say work is running in parallel, and do not say you are waiting for role outputs.
- After calling team_plan_workflow, role agents are dispatched automatically. Do NOT call sessions_spawn.
- team_send_message is reserved for real role child sessions and mailbox/audit traffic, not leader follow-up dispatch.
- As leader, do not call team_send_message, team_submit_artifact, team_update_task, or team_request_approval.
- Produce the final integrated TeamRun output as your leader response.
</team_workflow_orchestration>`,
      '',
      '## Role roster',
      ...roles.map((role) => `- ${role.roleId}: ${role.agentId}`),
      '',
    ].join('\n')
  }

  private buildSkillSummary(teamSkillPackage: TeamSkillPackage): string {
    return [
      `# ${teamSkillPackage.name}`,
      '',
      `version: ${teamSkillPackage.version}`,
      `kind: ${teamSkillPackage.kind}`,
      '',
      teamSkillPackage.description,
      '',
      '## Roles',
      ...teamSkillPackage.roles.map((role) => `- ${role.id}: ${role.purpose}`),
      '',
    ].join('\n')
  }

  private toLeaderConfigProjection(runtimeRoot: string, runId: string, roles: TeamRoleBinding[]): TeamRoleAgentConfigProjection {
    const leaderAgentId = this.buildAgentId(runId, 'leader')
    return {
      id: leaderAgentId,
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
        allow: Array.from(new Set([...TEAM_LEADER_RUNTIME_TOOLS, ...TEAM_ROLE_RUNTIME_TOOLS, ...roles.flatMap((role) => role.tools)])),
        deny: [...TEAM_LEADER_MANAGED_DENIED_TOOLS],
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
    return buildTeamManagedAgentId(runId, roleId)
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

  private assertProvisionableRoleTools(roleId: string, tools: string[], dependencyTools: TeamSkillDependencyEntry[]): void {
    const declaredTools = new Set(dependencyTools.map((item) => item.name))
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
