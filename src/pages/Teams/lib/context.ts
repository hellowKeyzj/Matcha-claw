import type { SubagentSummary } from '@/types/subagent';
import type { Team, TeamContext, TeamPhase, TeamReport } from '@/types/team';

type TeamContextEnvelope = {
  team_id: string;
  phase: TeamPhase;
  goal: string;
  shared_summary: string;
  open_questions: string[];
  members: Array<{
    agent_id: string;
    name: string;
    model?: string;
  }>;
  latest_reports: Array<{
    report_id: string;
    agent_id: string;
    status: TeamReport['status'];
    result: string[];
  }>;
};

export function buildTeamContextEnvelope(input: {
  team: Team;
  phase: TeamPhase;
  context?: TeamContext;
  reports?: TeamReport[];
  agents: SubagentSummary[];
}): TeamContextEnvelope {
  return {
    team_id: input.team.id,
    phase: input.phase,
    goal: input.context?.goal ?? '',
    shared_summary: (input.context?.decisions ?? []).slice(-8).join('\n'),
    open_questions: input.context?.openQuestions ?? [],
    members: input.team.memberIds.map((agentId) => {
      const agent = input.agents.find((item) => item.id === agentId);
      return {
        agent_id: agentId,
        name: agent?.name ?? agentId,
        model: agent?.model,
      };
    }),
    latest_reports: (input.reports ?? []).slice(-10).map((report) => ({
      report_id: report.reportId,
      agent_id: report.agent_id,
      status: report.status,
      result: report.result,
    })),
  };
}

export function wrapMessageWithTeamContext(rawMessage: string, envelope: TeamContextEnvelope): string {
  return [
    '[TEAM_CONTEXT]',
    JSON.stringify(envelope, null, 2),
    '',
    '[USER_MESSAGE]',
    rawMessage.trim(),
  ].join('\n');
}
