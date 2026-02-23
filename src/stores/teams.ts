import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { detectTeamMessageKind } from '@/lib/team/message';
import type {
  Team,
  TeamAuditRecord,
  TeamContext,
  TeamFlowEvent,
  TeamMemberRuntime,
  TeamMessage,
  TeamPhase,
  TeamPlan,
  TeamReport,
  TeamTaskRuntime,
} from '@/types/team';

interface TeamsState {
  teams: Team[];
  activeTeamId: string | null;
  teamContexts: Record<string, TeamContext>;
  teamReports: Record<string, TeamReport[]>;
  teamMessagesById: Record<string, TeamMessage[]>;
  teamSessionKeys: Record<string, Record<string, string>>;
  teamPhaseById: Record<string, TeamPhase>;
  agentLatestOutput: Record<string, Record<string, string>>;
  teamPlans: Record<string, TeamPlan | null>;
  teamTasksById: Record<string, TeamTaskRuntime[]>;
  teamMemberRuntimeById: Record<string, Record<string, TeamMemberRuntime>>;
  teamAuditById: Record<string, TeamAuditRecord[]>;
  teamFlowEventsById: Record<string, TeamFlowEvent[]>;
  createTeam: (input: { name: string; controllerId: string; memberIds: string[] }) => string;
  setActiveTeam: (id: string | null) => void;
  updateTeam: (team: Team) => void;
  deleteTeam: (id: string) => void;
  updateTeamContext: (teamId: string, ctx: TeamContext) => void;
  appendReport: (teamId: string, report: TeamReport) => void;
  appendTeamMessage: (teamId: string, message: Omit<TeamMessage, 'kind'> & { kind?: TeamMessage['kind'] }) => void;
  setTeamPlan: (teamId: string, plan: TeamPlan | null) => void;
  setTeamTasks: (teamId: string, tasks: TeamTaskRuntime[]) => void;
  upsertTeamTask: (teamId: string, task: TeamTaskRuntime) => void;
  setTeamMemberRuntime: (teamId: string, agentId: string, patch: Partial<TeamMemberRuntime>) => void;
  appendTeamAudit: (teamId: string, record: TeamAuditRecord) => void;
  appendTeamFlowEvent: (teamId: string, event: TeamFlowEvent) => void;
  bindTeamMembers: (teamId: string, agentIds: string[]) => void;
  resetTeamRuntime: (teamId: string) => void;
  clearTeamMemberRuntime: (teamId: string, agentId: string) => void;
  setTeamPhase: (teamId: string, phase: TeamPhase) => void;
  setAgentLatestOutput: (teamId: string, agentId: string, text: string) => void;
}

export const useTeamsStore = create<TeamsState>()(
  persist(
    (set) => ({
      teams: [],
      activeTeamId: null,
      teamContexts: {},
      teamReports: {},
      teamMessagesById: {},
      teamSessionKeys: {},
      teamPhaseById: {},
      agentLatestOutput: {},
      teamPlans: {},
      teamTasksById: {},
      teamMemberRuntimeById: {},
      teamAuditById: {},
      teamFlowEventsById: {},
      createTeam: (input) => {
        const now = Date.now();
        const id = `team-${now}`;
        const team: Team = {
          id,
          name: input.name,
          controllerId: input.controllerId,
          memberIds: input.memberIds,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          teams: [...state.teams, team],
          activeTeamId: id,
          teamMessagesById: {
            ...state.teamMessagesById,
            [id]: [],
          },
          teamPhaseById: {
            ...state.teamPhaseById,
            [id]: 'discussion',
          },
          teamPlans: {
            ...state.teamPlans,
            [id]: null,
          },
          teamTasksById: {
            ...state.teamTasksById,
            [id]: [],
          },
          teamMemberRuntimeById: {
            ...state.teamMemberRuntimeById,
            [id]: input.memberIds.reduce<Record<string, TeamMemberRuntime>>((acc, agentId) => {
              acc[agentId] = {
                agentId,
                status: 'idle',
                updatedAt: now,
              };
              return acc;
            }, {}),
          },
          teamAuditById: {
            ...state.teamAuditById,
            [id]: [],
          },
          teamFlowEventsById: {
            ...state.teamFlowEventsById,
            [id]: [],
          },
        }));
        return id;
      },
      setActiveTeam: (id) => set({ activeTeamId: id }),
      updateTeam: (team) => set((state) => ({
        teams: state.teams.map((item) => (item.id === team.id ? team : item)),
      })),
      deleteTeam: (id) => set((state) => ({
        teams: state.teams.filter((item) => item.id !== id),
        activeTeamId: state.activeTeamId === id ? null : state.activeTeamId,
        teamContexts: Object.fromEntries(
          Object.entries(state.teamContexts).filter(([key]) => key !== id)
        ),
        teamReports: Object.fromEntries(
          Object.entries(state.teamReports).filter(([key]) => key !== id)
        ),
        teamMessagesById: Object.fromEntries(
          Object.entries(state.teamMessagesById).filter(([key]) => key !== id)
        ),
        teamSessionKeys: Object.fromEntries(
          Object.entries(state.teamSessionKeys).filter(([key]) => key !== id)
        ),
        teamPhaseById: Object.fromEntries(
          Object.entries(state.teamPhaseById).filter(([key]) => key !== id)
        ),
        agentLatestOutput: Object.fromEntries(
          Object.entries(state.agentLatestOutput).filter(([key]) => key !== id)
        ),
        teamPlans: Object.fromEntries(
          Object.entries(state.teamPlans).filter(([key]) => key !== id)
        ),
        teamTasksById: Object.fromEntries(
          Object.entries(state.teamTasksById).filter(([key]) => key !== id)
        ),
        teamMemberRuntimeById: Object.fromEntries(
          Object.entries(state.teamMemberRuntimeById).filter(([key]) => key !== id)
        ),
        teamAuditById: Object.fromEntries(
          Object.entries(state.teamAuditById).filter(([key]) => key !== id)
        ),
        teamFlowEventsById: Object.fromEntries(
          Object.entries(state.teamFlowEventsById).filter(([key]) => key !== id)
        ),
      })),
      updateTeamContext: (teamId, ctx) => set((state) => ({
        teamContexts: { ...state.teamContexts, [teamId]: ctx },
      })),
      appendReport: (teamId, report) => set((state) => ({
        teamReports: {
          ...state.teamReports,
          [teamId]: [...(state.teamReports[teamId] ?? []), report],
        },
      })),
      appendTeamMessage: (teamId, message) => set((state) => {
        const kind = message.kind ?? detectTeamMessageKind(message.content);
        return {
          teamMessagesById: {
            ...state.teamMessagesById,
            [teamId]: [...(state.teamMessagesById[teamId] ?? []), { ...message, kind }],
          },
        };
      }),
      setTeamPlan: (teamId, plan) => set((state) => ({
        teamPlans: {
          ...state.teamPlans,
          [teamId]: plan,
        },
      })),
      setTeamTasks: (teamId, tasks) => set((state) => ({
        teamTasksById: {
          ...state.teamTasksById,
          [teamId]: tasks,
        },
      })),
      upsertTeamTask: (teamId, task) => set((state) => {
        const current = state.teamTasksById[teamId] ?? [];
        const index = current.findIndex((item) => item.taskId === task.taskId);
        if (index < 0) {
          return {
            teamTasksById: {
              ...state.teamTasksById,
              [teamId]: [...current, task],
            },
          };
        }
        const next = [...current];
        next[index] = task;
        return {
          teamTasksById: {
            ...state.teamTasksById,
            [teamId]: next,
          },
        };
      }),
      setTeamMemberRuntime: (teamId, agentId, patch) => set((state) => {
        const now = Date.now();
        const currentByAgent = state.teamMemberRuntimeById[teamId] ?? {};
        const prev = currentByAgent[agentId] ?? {
          agentId,
          status: 'idle' as const,
          updatedAt: now,
        };
        return {
          teamMemberRuntimeById: {
            ...state.teamMemberRuntimeById,
            [teamId]: {
              ...currentByAgent,
              [agentId]: {
                ...prev,
                ...patch,
                agentId,
                updatedAt: now,
              },
            },
          },
        };
      }),
      appendTeamAudit: (teamId, record) => set((state) => ({
        teamAuditById: {
          ...state.teamAuditById,
          [teamId]: [...(state.teamAuditById[teamId] ?? []), record],
        },
      })),
      appendTeamFlowEvent: (teamId, event) => set((state) => ({
        teamFlowEventsById: {
          ...state.teamFlowEventsById,
          [teamId]: [...(state.teamFlowEventsById[teamId] ?? []), event],
        },
      })),
      bindTeamMembers: (teamId, agentIds) => set((state) => ({
        teamSessionKeys: {
          ...state.teamSessionKeys,
          [teamId]: agentIds.reduce<Record<string, string>>((acc, agentId) => {
            acc[agentId] = `agent:${agentId}:team:${teamId}`;
            return acc;
          }, {}),
        },
        teamMemberRuntimeById: {
          ...state.teamMemberRuntimeById,
          [teamId]: agentIds.reduce<Record<string, TeamMemberRuntime>>((acc, agentId) => {
            const prev = state.teamMemberRuntimeById[teamId]?.[agentId];
            acc[agentId] = prev ?? {
              agentId,
              status: 'idle',
              updatedAt: Date.now(),
            };
            return acc;
          }, {}),
        },
      })),
      resetTeamRuntime: (teamId) => set((state) => ({
        teamContexts: Object.fromEntries(
          Object.entries(state.teamContexts).filter(([key]) => key !== teamId)
        ),
        teamReports: Object.fromEntries(
          Object.entries(state.teamReports).filter(([key]) => key !== teamId)
        ),
        teamMessagesById: {
          ...state.teamMessagesById,
          [teamId]: [],
        },
        teamSessionKeys: Object.fromEntries(
          Object.entries(state.teamSessionKeys).filter(([key]) => key !== teamId)
        ),
        teamPhaseById: {
          ...state.teamPhaseById,
          [teamId]: 'discussion',
        },
        agentLatestOutput: Object.fromEntries(
          Object.entries(state.agentLatestOutput).filter(([key]) => key !== teamId)
        ),
        teamPlans: {
          ...state.teamPlans,
          [teamId]: null,
        },
        teamTasksById: {
          ...state.teamTasksById,
          [teamId]: [],
        },
        teamMemberRuntimeById: {
          ...state.teamMemberRuntimeById,
          [teamId]: Object.fromEntries(
            Object.keys(state.teamSessionKeys[teamId] ?? {}).map((agentId) => ([
              agentId,
              {
                agentId,
                status: 'idle',
                updatedAt: Date.now(),
              },
            ]))
          ),
        },
        teamAuditById: {
          ...state.teamAuditById,
          [teamId]: [],
        },
        teamFlowEventsById: {
          ...state.teamFlowEventsById,
          [teamId]: [],
        },
      })),
      clearTeamMemberRuntime: (teamId, agentId) => set((state) => {
        const nextSessionKeys = { ...(state.teamSessionKeys[teamId] ?? {}) };
        delete nextSessionKeys[agentId];
        const nextAgentOutputs = { ...(state.agentLatestOutput[teamId] ?? {}) };
        delete nextAgentOutputs[agentId];
        const nextMemberRuntime = { ...(state.teamMemberRuntimeById[teamId] ?? {}) };
        delete nextMemberRuntime[agentId];
        const nextTasks = (state.teamTasksById[teamId] ?? []).filter((task) => task.agentId !== agentId);
        return {
          teamSessionKeys: {
            ...state.teamSessionKeys,
            [teamId]: nextSessionKeys,
          },
          agentLatestOutput: {
            ...state.agentLatestOutput,
            [teamId]: nextAgentOutputs,
          },
          teamMemberRuntimeById: {
            ...state.teamMemberRuntimeById,
            [teamId]: nextMemberRuntime,
          },
          teamTasksById: {
            ...state.teamTasksById,
            [teamId]: nextTasks,
          },
        };
      }),
      setTeamPhase: (teamId, phase) => set((state) => ({
        teamPhaseById: {
          ...state.teamPhaseById,
          [teamId]: phase,
        },
      })),
      setAgentLatestOutput: (teamId, agentId, text) => set((state) => ({
        agentLatestOutput: {
          ...state.agentLatestOutput,
          [teamId]: {
            ...(state.agentLatestOutput[teamId] ?? {}),
            [agentId]: text,
          },
        },
      })),
    }),
    { name: 'clawx-teams' }
  )
);
