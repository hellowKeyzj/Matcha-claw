import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface TeamsRunnerState {
  daemonRunning: boolean;
  enabledByTeamId: Record<string, boolean>;
  activeAgentIdsByTeamId: Record<string, string[]>;
  activeTaskByAgentByTeamId: Record<string, Record<string, string>>;
  lastErrorByTeamId: Record<string, string | undefined>;
  setDaemonRunning: (running: boolean) => void;
  setTeamEnabled: (teamId: string, enabled: boolean) => void;
  isTeamEnabled: (teamId: string) => boolean;
  markAgentActive: (teamId: string, agentId: string, active: boolean) => void;
  markAgentTask: (teamId: string, agentId: string, taskId?: string) => void;
  setTeamError: (teamId: string, error?: string) => void;
  clearTeamRuntimeState: (teamId: string) => void;
  pruneTeams: (teamIds: string[]) => void;
  resetRuntimeState: () => void;
}

function uniqueSorted(ids: string[]): string[] {
  return Array.from(new Set(ids)).sort();
}

export const useTeamsRunnerStore = create<TeamsRunnerState>()(
  persist(
    (set, get) => ({
      daemonRunning: false,
      enabledByTeamId: {},
      activeAgentIdsByTeamId: {},
      activeTaskByAgentByTeamId: {},
      lastErrorByTeamId: {},

      setDaemonRunning: (running) => {
        set({ daemonRunning: running });
      },

      setTeamEnabled: (teamId, enabled) => {
        if (!teamId) {
          return;
        }
        set((state) => ({
          enabledByTeamId: {
            ...state.enabledByTeamId,
            [teamId]: enabled,
          },
        }));
      },

      isTeamEnabled: (teamId) => {
        if (!teamId) {
          return false;
        }
        const value = get().enabledByTeamId[teamId];
        return value !== false;
      },

      markAgentActive: (teamId, agentId, active) => {
        if (!teamId || !agentId) {
          return;
        }
        set((state) => {
          const prev = state.activeAgentIdsByTeamId[teamId] ?? [];
          const next = active
            ? uniqueSorted([...prev, agentId])
            : prev.filter((id) => id !== agentId);
          if (prev.length === next.length && prev.every((value, index) => value === next[index])) {
            return {};
          }
          return {
            activeAgentIdsByTeamId: {
              ...state.activeAgentIdsByTeamId,
              [teamId]: next,
            },
          };
        });
      },

      markAgentTask: (teamId, agentId, taskId) => {
        if (!teamId || !agentId) {
          return;
        }
        set((state) => {
          const prevMap = state.activeTaskByAgentByTeamId[teamId] ?? {};
          if (!taskId) {
            if (!(agentId in prevMap)) {
              return {};
            }
            const nextMap = { ...prevMap };
            delete nextMap[agentId];
            return {
              activeTaskByAgentByTeamId: {
                ...state.activeTaskByAgentByTeamId,
                [teamId]: nextMap,
              },
            };
          }
          if (prevMap[agentId] === taskId) {
            return {};
          }
          return {
            activeTaskByAgentByTeamId: {
              ...state.activeTaskByAgentByTeamId,
              [teamId]: {
                ...prevMap,
                [agentId]: taskId,
              },
            },
          };
        });
      },

      setTeamError: (teamId, error) => {
        if (!teamId) {
          return;
        }
        set((state) => {
          const current = state.lastErrorByTeamId[teamId];
          if (current === error) {
            return {};
          }
          return {
            lastErrorByTeamId: {
              ...state.lastErrorByTeamId,
              [teamId]: error,
            },
          };
        });
      },

      clearTeamRuntimeState: (teamId) => {
        if (!teamId) {
          return;
        }
        set((state) => {
          const nextActiveAgentIds = { ...state.activeAgentIdsByTeamId };
          const nextActiveTaskByAgent = { ...state.activeTaskByAgentByTeamId };
          const nextLastError = { ...state.lastErrorByTeamId };
          delete nextActiveAgentIds[teamId];
          delete nextActiveTaskByAgent[teamId];
          delete nextLastError[teamId];
          return {
            activeAgentIdsByTeamId: nextActiveAgentIds,
            activeTaskByAgentByTeamId: nextActiveTaskByAgent,
            lastErrorByTeamId: nextLastError,
          };
        });
      },

      pruneTeams: (teamIds) => {
        const keep = new Set(teamIds);
        set((state) => {
          const nextActiveAgentIds = Object.fromEntries(
            Object.entries(state.activeAgentIdsByTeamId).filter(([teamId]) => keep.has(teamId)),
          );
          const nextActiveTaskByAgent = Object.fromEntries(
            Object.entries(state.activeTaskByAgentByTeamId).filter(([teamId]) => keep.has(teamId)),
          );
          const nextLastError = Object.fromEntries(
            Object.entries(state.lastErrorByTeamId).filter(([teamId]) => keep.has(teamId)),
          );
          return {
            activeAgentIdsByTeamId: nextActiveAgentIds,
            activeTaskByAgentByTeamId: nextActiveTaskByAgent,
            lastErrorByTeamId: nextLastError,
          };
        });
      },

      resetRuntimeState: () => {
        set({
          activeAgentIdsByTeamId: {},
          activeTaskByAgentByTeamId: {},
          lastErrorByTeamId: {},
        });
      },
    }),
    {
      name: 'teams-runner-store',
      partialize: (state) => ({
        enabledByTeamId: state.enabledByTeamId,
      }),
    },
  ),
);

