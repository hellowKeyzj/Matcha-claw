export const TEAM_AGENT_ID_PREFIX = 'mct-'
export const TEAM_LEADER_ROLE_ID = 'leader'
export const TEAM_MANAGED_AGENT_CONFIG_KIND = 'matchaclaw-team-managed-openclaw-agents'
export const TEAM_MANAGED_AGENT_CONFIG_VERSION = 1
export const TEAM_MANAGED_AGENT_CONFIG_SOURCE = 'matchaclaw.team-runtime'
export const TEAM_LEADER_MANAGED_DENIED_TOOLS = ['sessions_yield', 'subagents'] as const
export const TEAM_ROLE_MANAGED_DENIED_TOOLS = ['sessions_spawn', 'sessions_yield', 'subagents'] as const
export const TEAM_ROLE_RUNTIME_TOOLS = ['team_submit_artifact', 'team_send_message', 'team_request_approval', 'team_update_task'] as const
export const TEAM_LEADER_RUNTIME_TOOLS = ['team_plan_workflow'] as const
export const TEAM_MANAGED_AGENT_TOOLS_PROFILE = 'full'
export const TEAM_MANAGED_AGENT_SANDBOX = { mode: 'off', scope: 'agent', workspaceAccess: 'rw' } as const
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

export function buildTeamManagedAgentId(runId: string, roleId: string): string {
  const runHash = stableHash(runId)
  const roleHash = stableHash(roleId)
  const roleSlug = slugId(roleId).slice(0, 32).replace(/-+$/g, '') || 'role'
  return `${TEAM_AGENT_ID_PREFIX}${runHash}-${roleSlug}-${roleHash}`
}

export function teamManagedAgentRunPrefix(runId: string): string {
  return `${TEAM_AGENT_ID_PREFIX}${stableHash(runId)}-`
}

function slugId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (const char of value) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}
