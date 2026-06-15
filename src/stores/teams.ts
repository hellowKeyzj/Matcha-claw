import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  cancelTeamRun,
  createTeamRun,
  deleteTeamRun,
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
  type TeamDispatchGroupRecord,
  type TeamDispatchRecord,
  type TeamDispatchTaskRecord,
  type TeamEventRecord,
  type TeamGateRecord,
  type TeamKickbackRecord,
  type TeamMessageRecord,
  type TeamRoleBindingRecord,
  type TeamRunRecord,
  type TeamRunSummary,
  type TeamRunWorkflowPlan,
  type TeamSkillPackage,
  type TeamStageRecord,
} from '@/services/openclaw/team-runtime-client';

export interface TeamMeta {
  id: string;
  name: string;
  teamSkillName: string;
  teamSkillVersion: string;
  teamSkillDescription: string;
  packagePath: string;
  sourcePath: string;
  activeRunId: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamSkillCandidate {
  displayName: string;
  packagePath: string;
  teamSkillPackage: TeamSkillPackage;
}

export type TeamSkillCreationPlan =
  | { action: 'create' }
  | { action: 'open_existing'; teamId: string }
  | { action: 'replace_required'; teamId: string; currentVersion: string; incomingVersion: string };

interface TeamsState {
  teams: TeamMeta[];
  activeTeamId: string | null;
  runByTeamId: Record<string, TeamRunRecord | undefined>;
  rolesByTeamId: Record<string, TeamRoleBindingRecord[]>;
  stagesByTeamId: Record<string, TeamStageRecord[]>;
  workflowPlanByTeamId: Record<string, TeamRunWorkflowPlan | null | undefined>;
  dispatchGroupsByTeamId: Record<string, TeamDispatchGroupRecord[]>;
  dispatchTasksByTeamId: Record<string, TeamDispatchTaskRecord[]>;
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
  planTeamSkillCreation: (candidate: TeamSkillCandidate) => TeamSkillCreationPlan;
  createTeam: (input: TeamSkillCandidate) => string;
  replaceTeamSkillVersion: (input: { teamId: string; expectedCurrentVersion: string; candidate: TeamSkillCandidate }) => string;
  setActiveTeam: (teamId: string | null) => void;
  deleteTeam: (teamId: string) => Promise<void>;
  ensureRunCreated: (teamId: string) => Promise<TeamRunSummary | undefined>;
  startRun: (teamId: string, initialPrompt?: string) => Promise<void>;
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

export function planTeamSkillCreation(teams: TeamMeta[], candidate: TeamSkillCandidate): TeamSkillCreationPlan {
  const teamSkillName = candidate.teamSkillPackage.name;
  const teamSkillVersion = candidate.teamSkillPackage.version;
  const sameVersion = teams.find((team) => team.teamSkillName === teamSkillName && team.teamSkillVersion === teamSkillVersion);
  if (sameVersion) {
    return { action: 'open_existing', teamId: sameVersion.id };
  }
  const sameName = teams.find((team) => team.teamSkillName === teamSkillName);
  if (sameName) {
    return {
      action: 'replace_required',
      teamId: sameName.id,
      currentVersion: sameName.teamSkillVersion,
      incomingVersion: teamSkillVersion,
    };
  }
  return { action: 'create' };
}

function sanitizeRunIdSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

function createRunId(teamId: string, packageVersion: string): string {
  return `${sanitizeRunIdSegment(teamId)}-run-${sanitizeRunIdSegment(packageVersion)}-${Date.now()}`;
}

function isSafeRunId(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

function toTeamMeta(input: TeamSkillCandidate, teamId: string, now: number): TeamMeta {
  return {
    id: teamId,
    name: input.displayName.trim() || input.teamSkillPackage.name,
    teamSkillName: input.teamSkillPackage.name,
    teamSkillVersion: input.teamSkillPackage.version,
    teamSkillDescription: input.teamSkillPackage.description,
    packagePath: input.packagePath.trim(),
    sourcePath: input.teamSkillPackage.sourcePath,
    activeRunId: createRunId(teamId, input.teamSkillPackage.version),
    createdAt: now,
    updatedAt: now,
  };
}

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

function isTeamMeta(value: unknown): value is TeamMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.teamSkillName === 'string'
    && typeof record.teamSkillVersion === 'string'
    && typeof record.packagePath === 'string'
    && typeof record.sourcePath === 'string'
    && typeof record.activeRunId === 'string'
    && isSafeRunId(record.activeRunId);
}

export const useTeamsStore = create<TeamsState>()(
  persist(
    (set, get) => ({
      teams: [],
      activeTeamId: null,
      runByTeamId: {},
      rolesByTeamId: {},
      stagesByTeamId: {},
      workflowPlanByTeamId: {},
      dispatchGroupsByTeamId: {},
      dispatchTasksByTeamId: {},
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
      planTeamSkillCreation: (candidate) => planTeamSkillCreation(get().teams, candidate),
      createTeam: (input) => {
        const plan = planTeamSkillCreation(get().teams, input);
        if (plan.action === 'open_existing') {
          set({ activeTeamId: plan.teamId });
          return plan.teamId;
        }
        if (plan.action === 'replace_required') {
          throw new Error(`TeamSkill ${input.teamSkillPackage.name} already exists at version ${plan.currentVersion}. Replace it explicitly before using version ${plan.incomingVersion}.`);
        }

        const now = Date.now();
        const id = `team-${now}`;
        const team = toTeamMeta(input, id, now);
        set((state) => ({
          teams: [...state.teams, team],
          activeTeamId: id,
          rolesByTeamId: { ...state.rolesByTeamId, [id]: [] },
          stagesByTeamId: { ...state.stagesByTeamId, [id]: [] },
          workflowPlanByTeamId: { ...state.workflowPlanByTeamId, [id]: null },
          dispatchGroupsByTeamId: { ...state.dispatchGroupsByTeamId, [id]: [] },
          dispatchTasksByTeamId: { ...state.dispatchTasksByTeamId, [id]: [] },
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
      replaceTeamSkillVersion: (input) => {
        const current = resolveTeamMeta(get().teams, input.teamId);
        if (current.teamSkillVersion !== input.expectedCurrentVersion) {
          throw new Error(`TeamSkill version changed from ${input.expectedCurrentVersion} to ${current.teamSkillVersion}.`);
        }
        if (current.teamSkillName !== input.candidate.teamSkillPackage.name) {
          throw new Error(`TeamSkill replacement must keep the same name: ${current.teamSkillName}`);
        }
        const duplicate = get().teams.find((team) => (
          team.id !== input.teamId
          && team.teamSkillName === input.candidate.teamSkillPackage.name
          && team.teamSkillVersion === input.candidate.teamSkillPackage.version
        ));
        if (duplicate) {
          set({ activeTeamId: duplicate.id });
          return duplicate.id;
        }
        const now = Date.now();
        const nextRunId = createRunId(input.teamId, input.candidate.teamSkillPackage.version);
        set((state) => ({
          teams: state.teams.map((team) => team.id === input.teamId
            ? {
              ...team,
              name: input.candidate.displayName.trim() || team.name,
              teamSkillVersion: input.candidate.teamSkillPackage.version,
              teamSkillDescription: input.candidate.teamSkillPackage.description,
              packagePath: input.candidate.packagePath.trim(),
              sourcePath: input.candidate.teamSkillPackage.sourcePath,
              activeRunId: nextRunId,
              updatedAt: now,
            }
            : team),
          activeTeamId: input.teamId,
          runByTeamId: withoutKey(state.runByTeamId, input.teamId),
          rolesByTeamId: { ...state.rolesByTeamId, [input.teamId]: [] },
          stagesByTeamId: { ...state.stagesByTeamId, [input.teamId]: [] },
          workflowPlanByTeamId: { ...state.workflowPlanByTeamId, [input.teamId]: null },
          dispatchGroupsByTeamId: { ...state.dispatchGroupsByTeamId, [input.teamId]: [] },
          dispatchTasksByTeamId: { ...state.dispatchTasksByTeamId, [input.teamId]: [] },
          approvalsByTeamId: { ...state.approvalsByTeamId, [input.teamId]: [] },
          artifactsByTeamId: { ...state.artifactsByTeamId, [input.teamId]: [] },
          messagesByTeamId: { ...state.messagesByTeamId, [input.teamId]: [] },
          dispatchesByTeamId: { ...state.dispatchesByTeamId, [input.teamId]: [] },
          dispatchExecutionsByTeamId: { ...state.dispatchExecutionsByTeamId, [input.teamId]: [] },
          gatesByTeamId: { ...state.gatesByTeamId, [input.teamId]: [] },
          kickbacksByTeamId: { ...state.kickbacksByTeamId, [input.teamId]: [] },
          decisionsByTeamId: { ...state.decisionsByTeamId, [input.teamId]: [] },
          eventsByTeamId: { ...state.eventsByTeamId, [input.teamId]: [] },
          eventCursorByTeamId: withoutKey(state.eventCursorByTeamId, input.teamId),
          errorByTeamId: { ...state.errorByTeamId, [input.teamId]: undefined },
        }));
        return input.teamId;
      },
      setActiveTeam: (teamId) => set({ activeTeamId: teamId }),
      deleteTeam: async (teamId) => {
        const state = get();
        const team = state.teams.find((row) => row.id === teamId);
        if (!team) {
          const message = `Team not found: ${teamId}`;
          set((state) => ({
            errorByTeamId: { ...state.errorByTeamId, [teamId]: message },
          }));
          throw new Error(message);
        }

        const runId = state.runByTeamId[teamId]?.runId ?? team.activeRunId;
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          await deleteTeamRun({ runId });
          set((state) => ({
            teams: state.teams.filter((team) => team.id !== teamId),
            activeTeamId: state.activeTeamId === teamId ? null : state.activeTeamId,
            runByTeamId: withoutKey(state.runByTeamId, teamId),
            rolesByTeamId: withoutKey(state.rolesByTeamId, teamId),
            stagesByTeamId: withoutKey(state.stagesByTeamId, teamId),
            workflowPlanByTeamId: withoutKey(state.workflowPlanByTeamId, teamId),
            dispatchGroupsByTeamId: withoutKey(state.dispatchGroupsByTeamId, teamId),
            dispatchTasksByTeamId: withoutKey(state.dispatchTasksByTeamId, teamId),
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
          }));
        } catch (error) {
          set((state) => ({
            loadingByTeamId: { ...state.loadingByTeamId, [teamId]: false },
            errorByTeamId: {
              ...state.errorByTeamId,
              [teamId]: error instanceof Error ? error.message : String(error),
            },
          }));
          throw error;
        }
      },
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
            runId: team.activeRunId,
            idempotencyKey: idempotencyKey(team.id, `create:${team.activeRunId}`),
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
      startRun: async (teamId, initialPrompt?: string) => {
        const run = await get().ensureRunCreated(teamId);
        if (!run || !STARTABLE_RUN_STATUSES.has(run.status)) {
          return;
        }
        await startTeamRun({
          runId: run.runId,
          idempotencyKey: idempotencyKey(teamId, `start:${run.revision}`),
          initialPrompt,
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
          const team = resolveTeamMeta(state.teams, teamId);
          const runId = state.runByTeamId[teamId]?.runId ?? team.activeRunId;
          const snapshot = await readTeamRunSnapshot({
            runId,
            eventCursor: state.eventCursorByTeamId[teamId],
            eventLimit: 200,
          });
          set((state) => ({
            runByTeamId: { ...state.runByTeamId, [teamId]: snapshot.run ?? undefined },
            rolesByTeamId: { ...state.rolesByTeamId, [teamId]: snapshot.roles },
            stagesByTeamId: { ...state.stagesByTeamId, [teamId]: snapshot.stages },
            workflowPlanByTeamId: { ...state.workflowPlanByTeamId, [teamId]: snapshot.workflowPlan },
            dispatchGroupsByTeamId: { ...state.dispatchGroupsByTeamId, [teamId]: snapshot.dispatchGroups },
            dispatchTasksByTeamId: { ...state.dispatchTasksByTeamId, [teamId]: snapshot.dispatchTasks },
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
      version: 3,
      migrate: (persisted) => {
        if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
          return { teams: [], activeTeamId: null };
        }
        const state = persisted as { teams?: unknown; activeTeamId?: unknown };
        const teams = Array.isArray(state.teams) ? state.teams.filter(isTeamMeta) : [];
        const activeTeamId = typeof state.activeTeamId === 'string' && teams.some((team) => team.id === state.activeTeamId)
          ? state.activeTeamId
          : null;
        return { teams, activeTeamId };
      },
      partialize: (state) => ({
        teams: state.teams,
        activeTeamId: state.activeTeamId,
      }),
    },
  ),
);
