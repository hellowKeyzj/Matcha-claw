import type { TeamRoleAgentMaterializationSpec } from '../../ports/team-agent-materialization-port';

const OPENCLAW_TEAM_AGENT_DENIED_DELEGATION_TOOLS = ['sessions_spawn', 'sessions_yield', 'subagents'] as const;
const OPENCLAW_TEAM_AGENT_TOOLS_PROFILE = 'full';

export const OPENCLAW_TEAM_AGENT_SANDBOX = { mode: 'off' } as const;

export function projectTeamRoleToolPolicyToOpenClawTools(role: TeamRoleAgentMaterializationSpec): Record<string, unknown> {
  const teamSkillTools = projectOpenClawRoleTools(role.tools);
  return withoutUndefined({
    profile: OPENCLAW_TEAM_AGENT_TOOLS_PROFILE,
    alsoAllow: teamSkillTools.length > 0 ? teamSkillTools : undefined,
    deny: [...OPENCLAW_TEAM_AGENT_DENIED_DELEGATION_TOOLS],
  });
}

function projectOpenClawRoleTools(tools: readonly string[] | undefined): string[] {
  return uniqueToolNames(tools ?? []);
}

function uniqueToolNames(tools: readonly string[]): string[] {
  return Array.from(new Set(tools));
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

