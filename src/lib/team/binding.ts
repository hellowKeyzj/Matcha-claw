export function buildTeamSessionKey(agentId: string, teamId: string): string {
  return `agent:${agentId}:team:${teamId}`;
}

export function filterMissingAgents(teamAgentIds: string[], existingAgentIds: string[]): string[] {
  const existing = new Set(existingAgentIds);
  return teamAgentIds.filter((id) => !existing.has(id));
}
