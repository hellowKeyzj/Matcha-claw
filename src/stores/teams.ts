import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  teamClaimNext,
  teamHeartbeat,
  teamInit,
  teamMailboxPost,
  teamMailboxPull,
  teamPlanUpsert,
  teamReleaseClaim,
  teamSnapshot,
  teamTaskUpdate,
  type TeamMailboxMessage,
  type TeamRunMeta,
  type TeamTask,
  type TeamTaskStatus,
} from '@/features/teams/api/runtime-client';

export interface TeamMeta {
  id: string;
  name: string;
  leadAgentId: string;
  memberIds: string[];
  createdAt: number;
  updatedAt: number;
}

interface TeamsState {
  teams: TeamMeta[];
  activeTeamId: string | null;
  runMetaByTeamId: Record<string, TeamRunMeta | undefined>;
  tasksByTeamId: Record<string, TeamTask[]>;
  mailboxByTeamId: Record<string, TeamMailboxMessage[]>;
  mailboxCursorByTeamId: Record<string, string | undefined>;
  eventsByTeamId: Record<string, Array<Record<string, unknown>>>;
  loadingByTeamId: Record<string, boolean>;
  errorByTeamId: Record<string, string | undefined>;
  createTeam: (input: {
    name: string;
    leadAgentId: string;
    memberIds: string[];
  }) => string;
  setActiveTeam: (teamId: string | null) => void;
  deleteTeam: (teamId: string) => void;
  initRuntime: (teamId: string) => Promise<void>;
  refreshSnapshot: (teamId: string) => Promise<void>;
  planUpsert: (
    teamId: string,
    tasks: Array<{ taskId: string; title?: string; instruction: string; dependsOn?: string[] }>,
  ) => Promise<void>;
  claimNext: (teamId: string, agentId: string, sessionKey: string) => Promise<TeamTask | null>;
  heartbeat: (teamId: string, taskId: string, agentId: string, sessionKey: string) => Promise<boolean>;
  updateTaskStatus: (
    teamId: string,
    taskId: string,
    status: TeamTaskStatus,
    options?: { resultSummary?: string; error?: string },
  ) => Promise<void>;
  postMailbox: (
    teamId: string,
    message: Omit<TeamMailboxMessage, 'createdAt'> & { createdAt?: number },
  ) => Promise<void>;
  pullMailbox: (teamId: string, limit?: number) => Promise<void>;
  releaseClaim: (teamId: string, taskId: string, agentId: string, sessionKey: string) => Promise<void>;
}

function mergeMailboxMessages(
  current: TeamMailboxMessage[],
  incoming: TeamMailboxMessage[],
): TeamMailboxMessage[] {
  const byId = new Map(current.map((message) => [message.msgId, message]));
  for (const message of incoming) {
    byId.set(message.msgId, message);
  }
  return Array.from(byId.values()).sort(
    (a, b) => a.createdAt - b.createdAt || a.msgId.localeCompare(b.msgId),
  );
}

function resolveTeamMeta(teams: TeamMeta[], teamId: string): TeamMeta {
  const team = teams.find((row) => row.id === teamId);
  if (!team) {
    throw new Error(`Team not found: ${teamId}`);
  }
  return team;
}

function upsertTaskList(current: TeamTask[], task: TeamTask): TeamTask[] {
  const index = current.findIndex((row) => row.taskId === task.taskId);
  if (index < 0) {
    return [...current, task].sort((a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
  }
  const next = [...current];
  next[index] = task;
  return next;
}

const TEAM_SYNC_MIN_GAP_ACTIVE_MS = 2_500;
const TEAM_SYNC_MIN_GAP_IDLE_MS = 8_000;
const TEAM_SYNC_MIN_GAP_BACKGROUND_MS = 20_000;
const snapshotInFlightByTeamId = new Map<string, Promise<void>>();
const snapshotLastAtByTeamId = new Map<string, number>();
const mailboxInFlightByTeamId = new Map<string, Promise<void>>();
const mailboxLastAtByTeamId = new Map<string, number>();

function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }
  return document.visibilityState === 'visible';
}

function hasTeamWorkload(tasks: TeamTask[]): boolean {
  return tasks.some((task) => (
    task.status === 'todo'
    || task.status === 'claimed'
    || task.status === 'running'
    || task.status === 'blocked'
  ));
}

function resolveTeamSyncMinGapMs(tasks: TeamTask[]): number {
  if (!isDocumentVisible()) {
    return TEAM_SYNC_MIN_GAP_BACKGROUND_MS;
  }
  return hasTeamWorkload(tasks) ? TEAM_SYNC_MIN_GAP_ACTIVE_MS : TEAM_SYNC_MIN_GAP_IDLE_MS;
}

export const useTeamsStore = create<TeamsState>()(
  persist(
    (set, get) => ({
      teams: [],
      activeTeamId: null,
      runMetaByTeamId: {},
      tasksByTeamId: {},
      mailboxByTeamId: {},
      mailboxCursorByTeamId: {},
      eventsByTeamId: {},
      loadingByTeamId: {},
      errorByTeamId: {},
      createTeam: (input) => {
        const now = Date.now();
        const id = `team-${now}`;
        const team: TeamMeta = {
          id,
          name: input.name.trim() || `Team ${now}`,
          leadAgentId: input.leadAgentId,
          memberIds: Array.from(new Set(input.memberIds.filter(Boolean))),
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          teams: [...state.teams, team],
          activeTeamId: id,
          tasksByTeamId: { ...state.tasksByTeamId, [id]: [] },
          mailboxByTeamId: { ...state.mailboxByTeamId, [id]: [] },
          mailboxCursorByTeamId: { ...state.mailboxCursorByTeamId, [id]: undefined },
          eventsByTeamId: { ...state.eventsByTeamId, [id]: [] },
        }));
        return id;
      },
      setActiveTeam: (teamId) => set({ activeTeamId: teamId }),
      deleteTeam: (teamId) => set((state) => ({
        teams: state.teams.filter((team) => team.id !== teamId),
        activeTeamId: state.activeTeamId === teamId ? null : state.activeTeamId,
        runMetaByTeamId: Object.fromEntries(
          Object.entries(state.runMetaByTeamId).filter(([key]) => key !== teamId),
        ),
        tasksByTeamId: Object.fromEntries(
          Object.entries(state.tasksByTeamId).filter(([key]) => key !== teamId),
        ),
        mailboxByTeamId: Object.fromEntries(
          Object.entries(state.mailboxByTeamId).filter(([key]) => key !== teamId),
        ),
        mailboxCursorByTeamId: Object.fromEntries(
          Object.entries(state.mailboxCursorByTeamId).filter(([key]) => key !== teamId),
        ),
        eventsByTeamId: Object.fromEntries(
          Object.entries(state.eventsByTeamId).filter(([key]) => key !== teamId),
        ),
        loadingByTeamId: Object.fromEntries(
          Object.entries(state.loadingByTeamId).filter(([key]) => key !== teamId),
        ),
        errorByTeamId: Object.fromEntries(
          Object.entries(state.errorByTeamId).filter(([key]) => key !== teamId),
        ),
      })),
      initRuntime: async (teamId) => {
        const team = resolveTeamMeta(get().teams, teamId);
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          const result = await teamInit({
            teamId,
            leadAgentId: team.leadAgentId,
          });
          set((state) => ({
            runMetaByTeamId: {
              ...state.runMetaByTeamId,
              [teamId]: result.run,
            },
          }));
          await get().refreshSnapshot(teamId);
        } catch (error) {
          set((state) => ({
            errorByTeamId: {
              ...state.errorByTeamId,
              [teamId]: error instanceof Error ? error.message : String(error),
            },
          }));
          throw error;
        } finally {
          set((state) => ({
            loadingByTeamId: { ...state.loadingByTeamId, [teamId]: false },
          }));
        }
      },
      refreshSnapshot: async (teamId) => {
        const inFlight = snapshotInFlightByTeamId.get(teamId);
        if (inFlight) {
          await inFlight;
          return;
        }
        const tasks = get().tasksByTeamId[teamId] ?? [];
        const minGapMs = resolveTeamSyncMinGapMs(tasks);
        const lastAt = snapshotLastAtByTeamId.get(teamId) ?? 0;
        if (Date.now() - lastAt < minGapMs) {
          return;
        }

        const run = async () => {
          const cursor = get().mailboxCursorByTeamId[teamId];
          const snapshot = await teamSnapshot({
            teamId,
            mailboxCursor: cursor,
            mailboxLimit: 200,
          });
          set((state) => ({
            runMetaByTeamId: {
              ...state.runMetaByTeamId,
              [teamId]: snapshot.run ?? undefined,
            },
            tasksByTeamId: {
              ...state.tasksByTeamId,
              [teamId]: snapshot.tasks,
            },
            mailboxByTeamId: {
              ...state.mailboxByTeamId,
              [teamId]: mergeMailboxMessages(
                state.mailboxByTeamId[teamId] ?? [],
                snapshot.mailbox.messages,
              ),
            },
            mailboxCursorByTeamId: {
              ...state.mailboxCursorByTeamId,
              [teamId]: snapshot.mailbox.nextCursor ?? cursor,
            },
            eventsByTeamId: {
              ...state.eventsByTeamId,
              [teamId]: snapshot.events,
            },
          }));
        };

        const promise = run();
        snapshotInFlightByTeamId.set(teamId, promise);
        try {
          await promise;
        } finally {
          snapshotInFlightByTeamId.delete(teamId);
          snapshotLastAtByTeamId.set(teamId, Date.now());
        }
      },
      planUpsert: async (teamId, tasks) => {
        const result = await teamPlanUpsert({ teamId, tasks });
        set((state) => ({
          tasksByTeamId: {
            ...state.tasksByTeamId,
            [teamId]: result.tasks,
          },
        }));
      },
      claimNext: async (teamId, agentId, sessionKey) => {
        const result = await teamClaimNext({ teamId, agentId, sessionKey });
        if (!result.task) {
          return null;
        }
        set((state) => ({
          tasksByTeamId: {
            ...state.tasksByTeamId,
            [teamId]: upsertTaskList(state.tasksByTeamId[teamId] ?? [], result.task as TeamTask),
          },
        }));
        return result.task;
      },
      heartbeat: async (teamId, taskId, agentId, sessionKey) => {
        const result = await teamHeartbeat({ teamId, taskId, agentId, sessionKey });
        if (result.ok && result.task) {
          set((state) => ({
            tasksByTeamId: {
              ...state.tasksByTeamId,
              [teamId]: upsertTaskList(state.tasksByTeamId[teamId] ?? [], result.task as TeamTask),
            },
          }));
        }
        return result.ok;
      },
      updateTaskStatus: async (teamId, taskId, status, options) => {
        const payload: {
          teamId: string;
          taskId: string;
          status: TeamTaskStatus;
          resultSummary?: string;
          error?: string;
        } = {
          teamId,
          taskId,
          status,
        };
        if (options && Object.prototype.hasOwnProperty.call(options, 'resultSummary')) {
          payload.resultSummary = options.resultSummary;
        }
        if (options && Object.prototype.hasOwnProperty.call(options, 'error')) {
          payload.error = options.error;
        }
        const result = await teamTaskUpdate({
          ...payload,
        });
        set((state) => ({
          tasksByTeamId: {
            ...state.tasksByTeamId,
            [teamId]: upsertTaskList(state.tasksByTeamId[teamId] ?? [], result.task as TeamTask),
          },
        }));
      },
      postMailbox: async (teamId, message) => {
        const result = await teamMailboxPost({
          teamId,
          message: {
            ...message,
            createdAt: message.createdAt ?? Date.now(),
          },
        });
        set((state) => ({
          mailboxByTeamId: {
            ...state.mailboxByTeamId,
            [teamId]: mergeMailboxMessages(state.mailboxByTeamId[teamId] ?? [], [result.message]),
          },
        }));
      },
      pullMailbox: async (teamId, limit) => {
        const inFlight = mailboxInFlightByTeamId.get(teamId);
        if (inFlight) {
          await inFlight;
          return;
        }
        const tasks = get().tasksByTeamId[teamId] ?? [];
        const minGapMs = resolveTeamSyncMinGapMs(tasks);
        const lastAt = mailboxLastAtByTeamId.get(teamId) ?? 0;
        if (Date.now() - lastAt < minGapMs) {
          return;
        }

        const run = async () => {
          const cursor = get().mailboxCursorByTeamId[teamId];
          const result = await teamMailboxPull({ teamId, cursor, limit });
          set((state) => ({
            mailboxByTeamId: {
              ...state.mailboxByTeamId,
              [teamId]: mergeMailboxMessages(state.mailboxByTeamId[teamId] ?? [], result.messages),
            },
            mailboxCursorByTeamId: {
              ...state.mailboxCursorByTeamId,
              [teamId]: result.nextCursor ?? cursor,
            },
          }));
        };

        const promise = run();
        mailboxInFlightByTeamId.set(teamId, promise);
        try {
          await promise;
        } finally {
          mailboxInFlightByTeamId.delete(teamId);
          mailboxLastAtByTeamId.set(teamId, Date.now());
        }
      },
      releaseClaim: async (teamId, taskId, agentId, sessionKey) => {
        const result = await teamReleaseClaim({ teamId, taskId, agentId, sessionKey });
        if (result.task) {
          set((state) => ({
            tasksByTeamId: {
              ...state.tasksByTeamId,
              [teamId]: upsertTaskList(state.tasksByTeamId[teamId] ?? [], result.task as TeamTask),
            },
          }));
        }
      },
    }),
    {
      name: 'teams-runtime-store',
      partialize: (state) => ({
        teams: state.teams,
        activeTeamId: state.activeTeamId,
      }),
    },
  ),
);
