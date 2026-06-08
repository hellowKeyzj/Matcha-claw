import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  cancelTeamRun,
  createTeamRun,
  readTeamRunSnapshot,
  resolveTeamApproval,
  startTeamRun,
  submitTeamRunDecision,
  tickTeamRun,
  type TeamApprovalRecord,
  type TeamArtifactRecord,
  type TeamDecisionRecord,
  type TeamDecisionType,
  type TeamDispatchExecutionRecord,
  type TeamDispatchRecord,
  type TeamEventRecord,
  type TeamGateRecord,
  type TeamKickbackRecord,
  type TeamMessageRecord,
  type TeamRoleBindingRecord,
  type TeamRunRecord,
  type TeamRunSummary,
  type TeamStageRecord,
} from '@/services/openclaw/team-runtime-client';

export interface TeamMeta {
  id: string;
  name: string;
  leadAgentId: string;
  memberIds: string[];
  packagePath: string;
  createdAt: number;
  updatedAt: number;
}

interface TeamsState {
  teams: TeamMeta[];
  activeTeamId: string | null;
  runByTeamId: Record<string, TeamRunRecord | undefined>;
  rolesByTeamId: Record<string, TeamRoleBindingRecord[]>;
  stagesByTeamId: Record<string, TeamStageRecord[]>;
  approvalsByTeamId: Record<string, TeamApprovalRecord[]>;
  artifactsByTeamId: Record<string, TeamArtifactRecord[]>;
  messagesByTeamId: Record<string, TeamMessageRecord[]>;
  dispatchesByTeamId: Record<string, TeamDispatchRecord[]>;
  dispatchExecutionsByTeamId: Record<string, TeamDispatchExecutionRecord[]>;
  gatesByTeamId: Record<string, TeamGateRecord[]>;
  kickbacksByTeamId: Record<string, TeamKickbackRecord[]>;
  decisionsByTeamId: Record<string, TeamDecisionRecord[]>;
  eventsByTeamId: Record<string, TeamEventRecord[]>;
  eventCursorByTeamId: Record<string, number | undefined>;
  loadingByTeamId: Record<string, boolean>;
  errorByTeamId: Record<string, string | undefined>;
  createTeam: (input: {
    name: string;
    leadAgentId: string;
    memberIds: string[];
    packagePath: string;
  }) => string;
  setActiveTeam: (teamId: string | null) => void;
  deleteTeam: (teamId: string) => void;
  ensureRunCreated: (teamId: string) => Promise<TeamRunSummary | undefined>;
  startRun: (teamId: string) => Promise<void>;
  refreshSnapshot: (teamId: string, options?: { force?: boolean }) => Promise<void>;
  tickRun: (teamId: string) => Promise<void>;
  cancelRun: (teamId: string, reason?: string) => Promise<void>;
  resolveApproval: (
    teamId: string,
    approvalId: string,
    decision: 'approve' | 'deny' | 'abort',
    note?: string,
  ) => Promise<void>;
  submitDecision: (teamId: string, decision: TeamDecisionType, note?: string) => Promise<void>;
}

const snapshotInFlightByTeamId = new Map<string, Promise<void>>();
const actionInFlightByKey = new Map<string, { requestId: string; promise: Promise<void> }>();

const STARTABLE_RUN_STATUSES: ReadonlySet<TeamRunRecord['status']> = new Set(['created', 'paused']);

function resolveTeamMeta(teams: TeamMeta[], teamId: string): TeamMeta {
  const team = teams.find((row) => row.id === teamId);
  if (!team) {
    throw new Error(`Team not found: ${teamId}`);
  }
  return team;
}

function resolveRunId(runByTeamId: Record<string, TeamRunRecord | undefined>, teamId: string): string {
  const runId = runByTeamId[teamId]?.runId;
  if (!runId) {
    throw new Error(`Team run is required: ${teamId}`);
  }
  return runId;
}

function idempotencyKey(teamId: string, action: string): string {
  return `${teamId}:${action}`;
}

function createRequestId(actionKey: string): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  return `${actionKey}:${cryptoApi?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

async function runActionOnce(actionKey: string, action: (requestId: string) => Promise<void>): Promise<void> {
  const inFlight = actionInFlightByKey.get(actionKey);
  if (inFlight) {
    await inFlight.promise;
    return;
  }

  const requestId = createRequestId(actionKey);
  const promise = action(requestId);
  actionInFlightByKey.set(actionKey, { requestId, promise });
  try {
    await promise;
  } finally {
    actionInFlightByKey.delete(actionKey);
  }
}

function mergeEvents(existing: TeamEventRecord[], incoming: TeamEventRecord[]): TeamEventRecord[] {
  if (incoming.length === 0) {
    return existing;
  }
  const byEventId = new Map<string, TeamEventRecord>();
  for (const event of existing) {
    byEventId.set(event.eventId, event);
  }
  for (const event of incoming) {
    byEventId.set(event.eventId, event);
  }
  return Array.from(byEventId.values()).sort((left, right) => {
    if (left.revision !== right.revision) {
      return left.revision - right.revision;
    }
    return left.createdAt - right.createdAt;
  });
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key));
}

export const useTeamsStore = create<TeamsState>()(
  persist(
    (set, get) => ({
      teams: [],
      activeTeamId: null,
      runByTeamId: {},
      rolesByTeamId: {},
      stagesByTeamId: {},
      approvalsByTeamId: {},
      artifactsByTeamId: {},
      messagesByTeamId: {},
      dispatchesByTeamId: {},
      dispatchExecutionsByTeamId: {},
      gatesByTeamId: {},
      kickbacksByTeamId: {},
      decisionsByTeamId: {},
      eventsByTeamId: {},
      eventCursorByTeamId: {},
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
          packagePath: input.packagePath.trim(),
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          teams: [...state.teams, team],
          activeTeamId: id,
          rolesByTeamId: { ...state.rolesByTeamId, [id]: [] },
          stagesByTeamId: { ...state.stagesByTeamId, [id]: [] },
          approvalsByTeamId: { ...state.approvalsByTeamId, [id]: [] },
          artifactsByTeamId: { ...state.artifactsByTeamId, [id]: [] },
          messagesByTeamId: { ...state.messagesByTeamId, [id]: [] },
          dispatchesByTeamId: { ...state.dispatchesByTeamId, [id]: [] },
          dispatchExecutionsByTeamId: { ...state.dispatchExecutionsByTeamId, [id]: [] },
          gatesByTeamId: { ...state.gatesByTeamId, [id]: [] },
          kickbacksByTeamId: { ...state.kickbacksByTeamId, [id]: [] },
          decisionsByTeamId: { ...state.decisionsByTeamId, [id]: [] },
          eventsByTeamId: { ...state.eventsByTeamId, [id]: [] },
        }));
        return id;
      },
      setActiveTeam: (teamId) => set({ activeTeamId: teamId }),
      deleteTeam: (teamId) => set((state) => ({
        teams: state.teams.filter((team) => team.id !== teamId),
        activeTeamId: state.activeTeamId === teamId ? null : state.activeTeamId,
        runByTeamId: withoutKey(state.runByTeamId, teamId),
        rolesByTeamId: withoutKey(state.rolesByTeamId, teamId),
        stagesByTeamId: withoutKey(state.stagesByTeamId, teamId),
        approvalsByTeamId: withoutKey(state.approvalsByTeamId, teamId),
        artifactsByTeamId: withoutKey(state.artifactsByTeamId, teamId),
        messagesByTeamId: withoutKey(state.messagesByTeamId, teamId),
        dispatchesByTeamId: withoutKey(state.dispatchesByTeamId, teamId),
        dispatchExecutionsByTeamId: withoutKey(state.dispatchExecutionsByTeamId, teamId),
        gatesByTeamId: withoutKey(state.gatesByTeamId, teamId),
        kickbacksByTeamId: withoutKey(state.kickbacksByTeamId, teamId),
        decisionsByTeamId: withoutKey(state.decisionsByTeamId, teamId),
        eventsByTeamId: withoutKey(state.eventsByTeamId, teamId),
        eventCursorByTeamId: withoutKey(state.eventCursorByTeamId, teamId),
        loadingByTeamId: withoutKey(state.loadingByTeamId, teamId),
        errorByTeamId: withoutKey(state.errorByTeamId, teamId),
      })),
      ensureRunCreated: async (teamId) => {
        const team = resolveTeamMeta(get().teams, teamId);
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          await get().refreshSnapshot(teamId, { force: true });
          const existingRun = get().runByTeamId[teamId];
          if (existingRun) {
            return existingRun;
          }

          const created = await createTeamRun({
            packagePath: team.packagePath,
            runId: team.id,
            idempotencyKey: idempotencyKey(team.id, 'create'),
          });
          await get().refreshSnapshot(teamId, { force: true });
          return get().runByTeamId[teamId] ?? created;
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
      startRun: async (teamId) => {
        const run = await get().ensureRunCreated(teamId);
        if (!run || !STARTABLE_RUN_STATUSES.has(run.status)) {
          return;
        }
        await startTeamRun({
          runId: run.runId,
          idempotencyKey: idempotencyKey(teamId, `start:${run.revision}`),
        });
        await get().refreshSnapshot(teamId, { force: true });
      },
      refreshSnapshot: async (teamId, options) => {
        while (true) {
          const inFlight = snapshotInFlightByTeamId.get(teamId);
          if (!inFlight) {
            break;
          }
          await inFlight;
          if (!options?.force) {
            return;
          }
        }

        const run = async () => {
          const state = get();
          const runId = state.runByTeamId[teamId]?.runId ?? teamId;
          const snapshot = await readTeamRunSnapshot({
            runId,
            eventCursor: state.eventCursorByTeamId[teamId],
            eventLimit: 200,
          });
          set((state) => ({
            runByTeamId: { ...state.runByTeamId, [teamId]: snapshot.run ?? undefined },
            rolesByTeamId: { ...state.rolesByTeamId, [teamId]: snapshot.roles },
            stagesByTeamId: { ...state.stagesByTeamId, [teamId]: snapshot.stages },
            approvalsByTeamId: { ...state.approvalsByTeamId, [teamId]: snapshot.approvals },
            artifactsByTeamId: { ...state.artifactsByTeamId, [teamId]: snapshot.artifacts },
            messagesByTeamId: { ...state.messagesByTeamId, [teamId]: snapshot.messages },
            dispatchesByTeamId: { ...state.dispatchesByTeamId, [teamId]: snapshot.dispatches },
            dispatchExecutionsByTeamId: { ...state.dispatchExecutionsByTeamId, [teamId]: snapshot.dispatchExecutions },
            gatesByTeamId: { ...state.gatesByTeamId, [teamId]: snapshot.gates },
            kickbacksByTeamId: { ...state.kickbacksByTeamId, [teamId]: snapshot.kickbacks },
            decisionsByTeamId: { ...state.decisionsByTeamId, [teamId]: snapshot.decisions },
            eventsByTeamId: {
              ...state.eventsByTeamId,
              [teamId]: mergeEvents(state.eventsByTeamId[teamId] ?? [], snapshot.events),
            },
            eventCursorByTeamId: { ...state.eventCursorByTeamId, [teamId]: snapshot.nextEventCursor },
          }));
        };

        const promise = run();
        snapshotInFlightByTeamId.set(teamId, promise);
        try {
          await promise;
        } finally {
          snapshotInFlightByTeamId.delete(teamId);
        }
      },
      tickRun: async (teamId) => {
        const actionKey = idempotencyKey(teamId, 'tick');
        await runActionOnce(actionKey, async (requestId) => {
          const state = get();
          const runId = resolveRunId(state.runByTeamId, teamId);
          await tickTeamRun({
            runId,
            idempotencyKey: requestId,
          });
          await get().refreshSnapshot(teamId, { force: true });
        });
      },
      cancelRun: async (teamId, reason) => {
        const state = get();
        const runId = resolveRunId(state.runByTeamId, teamId);
        await cancelTeamRun({
          runId,
          reason,
          idempotencyKey: idempotencyKey(teamId, 'cancel'),
        });
        await get().refreshSnapshot(teamId, { force: true });
      },
      resolveApproval: async (teamId, approvalId, decision, note) => {
        const state = get();
        const runId = resolveRunId(state.runByTeamId, teamId);
        await resolveTeamApproval({
          runId,
          approvalId,
          decision,
          note,
          idempotencyKey: idempotencyKey(teamId, `approval:${approvalId}:${decision}`),
        });
        await get().refreshSnapshot(teamId, { force: true });
      },
      submitDecision: async (teamId, decision, note) => {
        const state = get();
        const run = state.runByTeamId[teamId];
        if (!run) {
          throw new Error(`Team run is required: ${teamId}`);
        }
        if (run.status !== 'waiting_for_user') {
          return;
        }
        const actionKey = idempotencyKey(
          teamId,
          `decision:${run.currentStageId ?? 'no-stage'}:${run.revision}:${decision}`,
        );
        await runActionOnce(actionKey, async () => {
          await submitTeamRunDecision({
            runId: run.runId,
            decision,
            note,
            idempotencyKey: actionKey,
          });
          await get().refreshSnapshot(teamId, { force: true });
        });
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
