import type { AgentAvatarStyle } from '@/types/subagent';
import type { AgentSessionsPaneSessionEntry } from '@/plugins/chat/store/selectors';
import { buildRuntimeEndpointKey, type SessionIdentity } from '@/types/desktop/runtime-address';

export interface AgentSessionSwitchboardAgentResult {
  key: string;
  runtimeScopeKey: string;
  runtimeLabel: string;
  agentId: string;
  agentName: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
  sessionCount: number;
  sessions: AgentSessionsPaneSessionEntry[];
}

export interface AgentSessionSwitchboardRuntimeResult {
  runtimeScopeKey: string;
  runtimeLabel: string;
  agents: AgentSessionSwitchboardAgentResult[];
}

export interface AgentSessionSwitchboardRuntimeInput {
  runtimeScopeKey: string;
  runtimeLabel: string;
  agents: readonly {
    agentId: string;
    agentName: string;
    avatarSeed?: string;
    avatarStyle?: AgentAvatarStyle;
  }[];
}

export function buildSwitchboardAgentKey(runtimeScopeKey: string, agentId: string): string {
  return JSON.stringify([runtimeScopeKey, agentId]);
}

export function buildAgentSessionSwitchboardModel(input: {
  runtimeResults: readonly AgentSessionSwitchboardRuntimeInput[];
  sessionEntries: readonly AgentSessionsPaneSessionEntry[];
}): AgentSessionSwitchboardRuntimeResult[] {
  const agents = new Map<string, AgentSessionSwitchboardAgentResult>();
  const runtimes = input.runtimeResults.map((runtime) => ({
    runtimeScopeKey: runtime.runtimeScopeKey,
    runtimeLabel: runtime.runtimeLabel,
    agents: runtime.agents.map((agent): AgentSessionSwitchboardAgentResult => {
      const result = {
        ...agent,
        key: buildSwitchboardAgentKey(runtime.runtimeScopeKey, agent.agentId),
        runtimeScopeKey: runtime.runtimeScopeKey,
        runtimeLabel: runtime.runtimeLabel,
        sessionCount: 0,
        sessions: [],
      };
      agents.set(result.key, result);
      return result;
    }),
  }));
  for (const entry of input.sessionEntries) {
    const agent = agents.get(buildSwitchboardAgentKey(
      buildRuntimeEndpointKey(entry.session.sessionIdentity.endpoint), entry.session.agentId,
    ));
    if (!agent) continue;
    agent.sessions.push(entry);
    agent.sessionCount += 1;
  }
  return runtimes;
}

export interface AgentSessionSwitchboardTeamRoleInput {
  roleId: string;
  agentId: string;
  sessionIdentity: SessionIdentity;
}

export interface AgentSessionSwitchboardTeamRunInput {
  runId: string;
  label: string;
  leader: AgentSessionSwitchboardTeamRoleInput | null;
  roles: readonly AgentSessionSwitchboardTeamRoleInput[];
}

export interface AgentSessionSwitchboardTeamInput {
  teamId: string;
  teamName: string;
  activeRunId?: string | null;
  runs: readonly AgentSessionSwitchboardTeamRunInput[];
}

export interface AgentSessionSwitchboardTeamRunResult extends AgentSessionSwitchboardTeamRunInput {
  isActive: boolean;
}

export interface AgentSessionSwitchboardTeamResult {
  teamId: string;
  teamName: string;
  runs: AgentSessionSwitchboardTeamRunResult[];
}

export function buildAgentSessionSwitchboardTeams(teams: readonly AgentSessionSwitchboardTeamInput[]): AgentSessionSwitchboardTeamResult[] {
  return teams.map((team) => ({
    teamId: team.teamId,
    teamName: team.teamName,
    runs: team.runs.map((run) => ({ ...run, isActive: team.activeRunId === run.runId })),
  }));
}
