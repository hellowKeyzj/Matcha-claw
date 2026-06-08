export const TEAM_AGENT_ID_PREFIX = 'matchaclaw-team:'
export const TEAM_LEADER_ROLE_ID = 'leader'
export const TEAM_MANAGED_AGENT_CONFIG_KIND = 'matchaclaw-team-managed-openclaw-agents'
export const TEAM_MANAGED_AGENT_CONFIG_VERSION = 1
export const TEAM_MANAGED_AGENT_CONFIG_SOURCE = 'matchaclaw.team-runtime'
export const TEAM_ROLE_MANAGED_DENIED_TOOLS = ['sessions_spawn', 'sessions_yield', 'subagents'] as const
export const TEAM_ROLE_RUNTIME_TOOLS = ['team_submit_artifact', 'team_send_message', 'team_request_approval', 'team_update_task'] as const
export const TEAM_LEADER_SUBAGENT_TOOLS = ['sessions_spawn', 'sessions_yield', 'subagents'] as const
export const TEAM_MANAGED_AGENT_TOOLS_PROFILE = 'coding'
export const TEAM_MANAGED_AGENT_SANDBOX = { mode: 'all', scope: 'agent', workspaceAccess: 'rw' } as const
export const TEAM_MANAGED_AGENT_KIND = 'team-role-agent'

export type TeamRoleBindingStatus = 'pending' | 'provisioned' | 'idle' | 'running' | 'failed' | 'disabled'

export interface TeamRoleBinding {
  runId: string
  roleId: string
  agentId: string
  agentName: string
  workspaceDir: string
  agentDir: string
  skills: string[]
  tools: string[]
  status: TeamRoleBindingStatus
}

export interface TeamRoleAgentConfigProjection {
  id: string
  name: string
  workspace: string
  agentDir: string
  skills: string[]
  managedBy: 'matchaclaw.team-runtime'
  source: 'matchaclaw.team-runtime'
  managedRunId: string
  managedRoleId: string
  managedKind: 'team-role-agent'
  tools: {
    profile: string
    allow?: string[]
    alsoAllow?: string[]
    deny: string[]
  }
  sandbox: {
    mode: string
    scope: string
    workspaceAccess: string
  }
  subagents?: {
    allowAgents: string[]
    requireAgentId: boolean
  }
}

export interface TeamManagedAgentConfigProjection {
  kind: 'matchaclaw-team-managed-openclaw-agents'
  version: 1
  source: 'matchaclaw.team-runtime'
  runId: string
  leaderAgentId: string
  agents: TeamRoleAgentConfigProjection[]
}
