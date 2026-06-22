import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useChatStore } from '@/stores/chat';
import { buildSessionIdentityRecordIndex } from '@/stores/chat/session-identity';
import { DEFAULT_SESSION_KEY, type ChatSessionRecord } from '@/stores/chat/types';
import {
  cancelTeamRun,
  createTeamRun,
  deleteTeamInstance,
  deleteTeamRun,
  listTeamRuns,
  provisionTeamAgents,
  readTeamRunSnapshot,
  resolveTeamApproval,
  resumeTeam,
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
  type TeamMailRecord,
  type TeamMessageRecord,
  type TeamRoleBindingRecord,
  type TeamRunListItem,
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
  activeRunId?: string;
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
  runIdsByTeamId: Record<string, string[]>;
  runListByTeamId: Record<string, TeamRunListItem[]>;
  runsById: Record<string, TeamRunRecord | undefined>;
  runByTeamId: Record<string, TeamRunRecord | undefined>;
  rolesByTeamId: Record<string, TeamRoleBindingRecord[]>;
  stagesByTeamId: Record<string, TeamStageRecord[]>;
  workflowPlanByTeamId: Record<string, TeamRunWorkflowPlan | null | undefined>;
  dispatchGroupsByTeamId: Record<string, TeamDispatchGroupRecord[]>;
  dispatchTasksByTeamId: Record<string, TeamDispatchTaskRecord[]>;
  approvalsByTeamId: Record<string, TeamApprovalRecord[]>;
  artifactsByTeamId: Record<string, TeamArtifactRecord[]>;
  messagesByTeamId: Record<string, TeamMessageRecord[]>;
  mailsByTeamId: Record<string, TeamMailRecord[]>;
  dispatchesByTeamId: Record<string, TeamDispatchRecord[]>;
  dispatchExecutionsByTeamId: Record<string, TeamDispatchExecutionRecord[]>;
  gatesByTeamId: Record<string, TeamGateRecord[]>;
  kickbacksByTeamId: Record<string, TeamKickbackRecord[]>;
  decisionsByTeamId: Record<string, TeamDecisionRecord[]>;
  eventsByTeamId: Record<string, TeamEventRecord[]>;
  eventsByRunId: Record<string, TeamEventRecord[]>;
  eventCursorByTeamId: Record<string, number | undefined>;
  eventCursorByRunId: Record<string, number | undefined>;
  loadingByTeamId: Record<string, boolean>;
  errorByTeamId: Record<string, string | undefined>;
  planTeamSkillCreation: (candidate: TeamSkillCandidate) => TeamSkillCreationPlan;
  createTeam: (input: TeamSkillCandidate) => string;
  replaceTeamSkillVersion: (input: { teamId: string; expectedCurrentVersion: string; candidate: TeamSkillCandidate }) => string;
  setActiveTeam: (teamId: string | null) => void;
  setActiveRun: (teamId: string, runId: string | null) => void;
  deleteTeam: (teamId: string) => Promise<void>;
  provisionTeamAgents: (teamId: string) => Promise<void>;
  createRun: (teamId: string) => Promise<TeamRunSummary | undefined>;
  syncRunList: (teamId: string) => Promise<void>;
  deleteRun: (teamId: string, runId?: string) => Promise<void>;
  refreshSnapshot: (teamId: string, options?: { force?: boolean }) => Promise<void>;
  tickRun: (teamId: string) => Promise<void>;
  resumeRun: (teamId: string) => Promise<void>;
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

function createGeneratedTeamRunId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  const rawId = cryptoApi?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `teamrun-${sanitizeRunIdSegment(rawId)}`;
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

function resolveActiveRunId(state: Pick<TeamsState, 'teams' | 'runsById'>, teamId: string): string {
  const team = resolveTeamMeta(state.teams, teamId);
  if (!team.activeRunId) {
    throw new Error(`Team run is required: ${teamId}`);
  }
  return state.runsById[team.activeRunId]?.runId ?? team.activeRunId;
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

function appendRunId(existingRunIds: string[] | undefined, runId: string): string[] {
  const runIds = existingRunIds ?? [];
  return runIds.includes(runId) ? runIds : [...runIds, runId];
}

function equalStringArray(left: readonly string[] | undefined, right: readonly string[]): boolean {
  if (!left || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function mergeRunIds(leftRunIds: string[], rightRunIds: string[]): string[] {
  return Array.from(new Set([...leftRunIds, ...rightRunIds]));
}

function removeRunIdsFromRecord(runsById: Record<string, TeamRunRecord | undefined>, runIds: string[]): Record<string, TeamRunRecord | undefined> {
  return runIds.reduce((nextRunsById, runId) => withoutKey(nextRunsById, runId), runsById);
}

function isTeamRunRoleSessionKey(sessionKey: string, runIds: ReadonlySet<string>): boolean {
  const parts = sessionKey.split(':');
  return parts.length === 5 && parts[0] === 'agent' && parts[2] === 'team-role' && runIds.has(parts[3] ?? '');
}

function removeTeamRunRoleSessions(runIds: string[]): void {
  if (runIds.length === 0) {
    return;
  }
  const runIdSet = new Set(runIds);
  useChatStore.setState((state) => {
    const sessionKeysToDelete = Object.entries(state.loadedSessions)
      .filter(([, record]) => isTeamRunRoleSessionKey(record.meta.backendSessionKey, runIdSet))
      .map(([sessionKey]) => sessionKey);
    if (sessionKeysToDelete.length === 0) {
      return state;
    }
    const deleteSet = new Set(sessionKeysToDelete);
    const loadedSessions: Record<string, ChatSessionRecord> = Object.fromEntries(
      Object.entries(state.loadedSessions).filter(([sessionKey]) => !deleteSet.has(sessionKey)),
    );
    const currentSessionKey = deleteSet.has(state.currentSessionKey)
      ? Object.keys(loadedSessions)[0] ?? DEFAULT_SESSION_KEY
      : state.currentSessionKey;
    return {
      ...state,
      currentSessionKey,
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      pendingApprovalsBySession: Object.fromEntries(
        Object.entries(state.pendingApprovalsBySession).filter(([sessionKey]) => !deleteSet.has(sessionKey)),
      ),
      dismissedRuntimeErrorBySession: Object.fromEntries(
        Object.entries(state.dismissedRuntimeErrorBySession).filter(([sessionKey]) => !deleteSet.has(sessionKey)),
      ),
      foregroundHistorySessionKey: state.foregroundHistorySessionKey && deleteSet.has(state.foregroundHistorySessionKey)
        ? null
        : state.foregroundHistorySessionKey,
    };
  });
}

function selectMostRecentRunId(runIds: string[], runsById: Record<string, TeamRunRecord | undefined>): string | undefined {
  return [...runIds].sort((left, right) => {
    const leftRun = runsById[left];
    const rightRun = runsById[right];
    const leftTime = leftRun?.updatedAt ?? leftRun?.createdAt ?? 0;
    const rightTime = rightRun?.updatedAt ?? rightRun?.createdAt ?? 0;
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return runIds.indexOf(right) - runIds.indexOf(left);
  })[0];
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
    && (record.activeRunId === undefined || (typeof record.activeRunId === 'string' && isSafeRunId(record.activeRunId)));
}

function isTeamRunRecord(value: unknown): value is TeamRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.runId === 'string'
    && isSafeRunId(record.runId)
    && typeof record.status === 'string'
    && typeof record.revision === 'number'
    && typeof record.packageName === 'string'
    && typeof record.packageVersion === 'string'
    && typeof record.sourcePath === 'string'
    && typeof record.createdAt === 'number'
    && typeof record.updatedAt === 'number';
}

function emptyTeamRunProjection(teamId: string, state: TeamsState) {
  return {
    runByTeamId: { ...state.runByTeamId, [teamId]: undefined },
    rolesByTeamId: { ...state.rolesByTeamId, [teamId]: [] },
    stagesByTeamId: { ...state.stagesByTeamId, [teamId]: [] },
    workflowPlanByTeamId: { ...state.workflowPlanByTeamId, [teamId]: null },
    dispatchGroupsByTeamId: { ...state.dispatchGroupsByTeamId, [teamId]: [] },
    dispatchTasksByTeamId: { ...state.dispatchTasksByTeamId, [teamId]: [] },
    approvalsByTeamId: { ...state.approvalsByTeamId, [teamId]: [] },
    artifactsByTeamId: { ...state.artifactsByTeamId, [teamId]: [] },
    messagesByTeamId: { ...state.messagesByTeamId, [teamId]: [] },
    mailsByTeamId: { ...state.mailsByTeamId, [teamId]: [] },
    dispatchesByTeamId: { ...state.dispatchesByTeamId, [teamId]: [] },
    dispatchExecutionsByTeamId: { ...state.dispatchExecutionsByTeamId, [teamId]: [] },
    gatesByTeamId: { ...state.gatesByTeamId, [teamId]: [] },
    kickbacksByTeamId: { ...state.kickbacksByTeamId, [teamId]: [] },
    decisionsByTeamId: { ...state.decisionsByTeamId, [teamId]: [] },
    eventsByTeamId: { ...state.eventsByTeamId, [teamId]: [] },
    eventCursorByTeamId: { ...state.eventCursorByTeamId, [teamId]: undefined },
  };
}

export const useTeamsStore = create<TeamsState>()(
  persist(
    (set, get) => ({
      teams: [],
      activeTeamId: null,
      runIdsByTeamId: {},
      runListByTeamId: {},
      runsById: {},
      runByTeamId: {},
      rolesByTeamId: {},
      stagesByTeamId: {},
      workflowPlanByTeamId: {},
      dispatchGroupsByTeamId: {},
      dispatchTasksByTeamId: {},
      approvalsByTeamId: {},
      artifactsByTeamId: {},
      messagesByTeamId: {},
      mailsByTeamId: {},
      dispatchesByTeamId: {},
      dispatchExecutionsByTeamId: {},
      gatesByTeamId: {},
      kickbacksByTeamId: {},
      decisionsByTeamId: {},
      eventsByTeamId: {},
      eventsByRunId: {},
      eventCursorByTeamId: {},
      eventCursorByRunId: {},
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
          runIdsByTeamId: { ...state.runIdsByTeamId, [id]: [] },
          runListByTeamId: { ...state.runListByTeamId, [id]: [] },
          rolesByTeamId: { ...state.rolesByTeamId, [id]: [] },
          stagesByTeamId: { ...state.stagesByTeamId, [id]: [] },
          workflowPlanByTeamId: { ...state.workflowPlanByTeamId, [id]: null },
          dispatchGroupsByTeamId: { ...state.dispatchGroupsByTeamId, [id]: [] },
          dispatchTasksByTeamId: { ...state.dispatchTasksByTeamId, [id]: [] },
          approvalsByTeamId: { ...state.approvalsByTeamId, [id]: [] },
          artifactsByTeamId: { ...state.artifactsByTeamId, [id]: [] },
          messagesByTeamId: { ...state.messagesByTeamId, [id]: [] },
          mailsByTeamId: { ...state.mailsByTeamId, [id]: [] },
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
        const previousRunIds = get().runIdsByTeamId[input.teamId] ?? [];
        set((state) => ({
          teams: state.teams.map((team) => team.id === input.teamId
            ? {
              ...team,
              name: input.candidate.displayName.trim() || team.name,
              teamSkillVersion: input.candidate.teamSkillPackage.version,
              teamSkillDescription: input.candidate.teamSkillPackage.description,
              packagePath: input.candidate.packagePath.trim(),
              sourcePath: input.candidate.teamSkillPackage.sourcePath,
              activeRunId: undefined,
              updatedAt: now,
            }
            : team),
          activeTeamId: input.teamId,
          runIdsByTeamId: { ...state.runIdsByTeamId, [input.teamId]: [] },
          runListByTeamId: { ...state.runListByTeamId, [input.teamId]: [] },
          runsById: removeRunIdsFromRecord(state.runsById, previousRunIds),
          eventsByRunId: previousRunIds.reduce((eventsByRunId, runId) => withoutKey(eventsByRunId, runId), state.eventsByRunId),
          eventCursorByRunId: previousRunIds.reduce((eventCursorByRunId, runId) => withoutKey(eventCursorByRunId, runId), state.eventCursorByRunId),
          ...emptyTeamRunProjection(input.teamId, state),
          errorByTeamId: { ...state.errorByTeamId, [input.teamId]: undefined },
        }));
        return input.teamId;
      },
      setActiveTeam: (teamId) => set({ activeTeamId: teamId }),
      setActiveRun: (teamId, runId) => {
        const state = get();
        resolveTeamMeta(state.teams, teamId);
        if (runId && !(state.runIdsByTeamId[teamId] ?? []).includes(runId)) {
          throw new Error(`Team run does not belong to team: ${teamId}`);
        }
        set((state) => ({
          teams: state.teams.map((team) => team.id === teamId ? { ...team, activeRunId: runId ?? undefined, updatedAt: Date.now() } : team),
          runByTeamId: { ...state.runByTeamId, [teamId]: runId ? state.runsById[runId] : undefined },
          rolesByTeamId: { ...state.rolesByTeamId, [teamId]: [] },
          stagesByTeamId: { ...state.stagesByTeamId, [teamId]: [] },
          workflowPlanByTeamId: { ...state.workflowPlanByTeamId, [teamId]: null },
          dispatchGroupsByTeamId: { ...state.dispatchGroupsByTeamId, [teamId]: [] },
          dispatchTasksByTeamId: { ...state.dispatchTasksByTeamId, [teamId]: [] },
          approvalsByTeamId: { ...state.approvalsByTeamId, [teamId]: [] },
          artifactsByTeamId: { ...state.artifactsByTeamId, [teamId]: [] },
          messagesByTeamId: { ...state.messagesByTeamId, [teamId]: [] },
          mailsByTeamId: { ...state.mailsByTeamId, [teamId]: [] },
          dispatchesByTeamId: { ...state.dispatchesByTeamId, [teamId]: [] },
          dispatchExecutionsByTeamId: { ...state.dispatchExecutionsByTeamId, [teamId]: [] },
          gatesByTeamId: { ...state.gatesByTeamId, [teamId]: [] },
          kickbacksByTeamId: { ...state.kickbacksByTeamId, [teamId]: [] },
          decisionsByTeamId: { ...state.decisionsByTeamId, [teamId]: [] },
          eventsByTeamId: { ...state.eventsByTeamId, [teamId]: runId ? state.eventsByRunId[runId] ?? [] : [] },
          eventCursorByTeamId: { ...state.eventCursorByTeamId, [teamId]: runId ? state.eventCursorByRunId[runId] : undefined },
        }));
      },
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

        const storedRunIds = state.runIdsByTeamId[teamId] ?? [];
        const runIds = storedRunIds.length > 0 ? storedRunIds : team.activeRunId ? [team.activeRunId] : [];
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          const result = await deleteTeamInstance({ teamId });
          const runIdsToDelete = mergeRunIds(runIds, result.deletedRunIds ?? []);
          removeTeamRunRoleSessions(runIdsToDelete);
          set((state) => ({
            teams: state.teams.filter((team) => team.id !== teamId),
            activeTeamId: state.activeTeamId === teamId ? null : state.activeTeamId,
            runIdsByTeamId: withoutKey(state.runIdsByTeamId, teamId),
            runListByTeamId: withoutKey(state.runListByTeamId, teamId),
            runsById: removeRunIdsFromRecord(state.runsById, runIdsToDelete),
            runByTeamId: withoutKey(state.runByTeamId, teamId),
            rolesByTeamId: withoutKey(state.rolesByTeamId, teamId),
            stagesByTeamId: withoutKey(state.stagesByTeamId, teamId),
            workflowPlanByTeamId: withoutKey(state.workflowPlanByTeamId, teamId),
            dispatchGroupsByTeamId: withoutKey(state.dispatchGroupsByTeamId, teamId),
            dispatchTasksByTeamId: withoutKey(state.dispatchTasksByTeamId, teamId),
            approvalsByTeamId: withoutKey(state.approvalsByTeamId, teamId),
            artifactsByTeamId: withoutKey(state.artifactsByTeamId, teamId),
            messagesByTeamId: withoutKey(state.messagesByTeamId, teamId),
            mailsByTeamId: withoutKey(state.mailsByTeamId, teamId),
            dispatchesByTeamId: withoutKey(state.dispatchesByTeamId, teamId),
            dispatchExecutionsByTeamId: withoutKey(state.dispatchExecutionsByTeamId, teamId),
            gatesByTeamId: withoutKey(state.gatesByTeamId, teamId),
            kickbacksByTeamId: withoutKey(state.kickbacksByTeamId, teamId),
            decisionsByTeamId: withoutKey(state.decisionsByTeamId, teamId),
            eventsByTeamId: withoutKey(state.eventsByTeamId, teamId),
            eventsByRunId: runIdsToDelete.reduce((eventsByRunId, runId) => withoutKey(eventsByRunId, runId), state.eventsByRunId),
            eventCursorByTeamId: withoutKey(state.eventCursorByTeamId, teamId),
            eventCursorByRunId: runIdsToDelete.reduce((eventCursorByRunId, runId) => withoutKey(eventCursorByRunId, runId), state.eventCursorByRunId),
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
      provisionTeamAgents: async (teamId) => {
        const team = resolveTeamMeta(get().teams, teamId);
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          await provisionTeamAgents({
            teamId: team.id,
            packagePath: team.packagePath,
            idempotencyKey: idempotencyKey(team.id, `provision-agents:${team.teamSkillName}:${team.teamSkillVersion}`),
          });
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
      createRun: async (teamId) => {
        const team = resolveTeamMeta(get().teams, teamId);
        const runId = createGeneratedTeamRunId();
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          const created = await createTeamRun({
            teamId: team.id,
            packagePath: team.packagePath,
            runId,
            idempotencyKey: idempotencyKey(team.id, `create:${runId}`),
          });
          set((state) => ({
            teams: state.teams.map((team) => team.id === teamId ? { ...team, activeRunId: created.runId, updatedAt: Date.now() } : team),
            runIdsByTeamId: { ...state.runIdsByTeamId, [teamId]: appendRunId(state.runIdsByTeamId[teamId], created.runId) },
          }));
          await get().syncRunList(teamId);
          await get().refreshSnapshot(teamId, { force: true });
          return get().runByTeamId[teamId] ?? get().runsById[created.runId] ?? created;
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
      syncRunList: async (teamId) => {
        resolveTeamMeta(get().teams, teamId);
        const result = await listTeamRuns({ teamId });
        set((state) => {
          const runtimeRunIds = result.runs.map((run) => run.runId);
          const activeRunId = state.teams.find((team) => team.id === teamId)?.activeRunId;
          const nextActiveRunId = activeRunId && runtimeRunIds.includes(activeRunId)
            ? activeRunId
            : selectMostRecentRunId(runtimeRunIds, Object.fromEntries(result.runs.map((run) => [run.runId, run])));
          const nextActiveRun = nextActiveRunId ? result.runs.find((run) => run.runId === nextActiveRunId) : undefined;
          const currentProjectedRunId = state.runByTeamId[teamId]?.runId;
          const shouldClearTeamRunProjection = activeRunId !== nextActiveRunId || (currentProjectedRunId !== undefined && currentProjectedRunId !== nextActiveRunId);
          const shouldUpdateActiveRunId = activeRunId !== nextActiveRunId;
          const shouldUpdateRunIds = !equalStringArray(state.runIdsByTeamId[teamId], runtimeRunIds);
          return {
            teams: shouldUpdateActiveRunId
              ? state.teams.map((team) => team.id === teamId ? { ...team, activeRunId: nextActiveRunId, updatedAt: Date.now() } : team)
              : state.teams,
            runIdsByTeamId: shouldUpdateRunIds ? { ...state.runIdsByTeamId, [teamId]: runtimeRunIds } : state.runIdsByTeamId,
            runListByTeamId: { ...state.runListByTeamId, [teamId]: result.runs },
            runsById: {
              ...removeRunIdsFromRecord(state.runsById, state.runIdsByTeamId[teamId] ?? []),
              ...Object.fromEntries(result.runs.map((run) => [run.runId, run])),
            },
            ...(shouldClearTeamRunProjection ? emptyTeamRunProjection(teamId, state) : {}),
            runByTeamId: {
              ...state.runByTeamId,
              [teamId]: nextActiveRun,
            },
            rolesByTeamId: {
              ...state.rolesByTeamId,
              [teamId]: nextActiveRun?.sessions ?? [],
            },
          };
        });
      },
      deleteRun: async (teamId, requestedRunId) => {
        const state = get();
        const runId = requestedRunId ?? resolveActiveRunId(state, teamId);
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          await deleteTeamRun({ runId });
          set((state) => {
            const remainingRunIds = (state.runIdsByTeamId[teamId] ?? []).filter((candidate) => candidate !== runId);
            const nextRunId = selectMostRecentRunId(remainingRunIds, state.runsById);
            return {
              teams: state.teams.map((team) => team.id === teamId ? { ...team, activeRunId: nextRunId, updatedAt: Date.now() } : team),
              runIdsByTeamId: { ...state.runIdsByTeamId, [teamId]: remainingRunIds },
              runListByTeamId: { ...state.runListByTeamId, [teamId]: (state.runListByTeamId[teamId] ?? []).filter((run) => run.runId !== runId) },
              runsById: withoutKey(state.runsById, runId),
              eventsByRunId: withoutKey(state.eventsByRunId, runId),
              eventCursorByRunId: withoutKey(state.eventCursorByRunId, runId),
              runByTeamId: { ...state.runByTeamId, [teamId]: nextRunId ? state.runsById[nextRunId] : undefined },
              rolesByTeamId: { ...state.rolesByTeamId, [teamId]: [] },
              stagesByTeamId: { ...state.stagesByTeamId, [teamId]: [] },
              workflowPlanByTeamId: { ...state.workflowPlanByTeamId, [teamId]: null },
              dispatchGroupsByTeamId: { ...state.dispatchGroupsByTeamId, [teamId]: [] },
              dispatchTasksByTeamId: { ...state.dispatchTasksByTeamId, [teamId]: [] },
              approvalsByTeamId: { ...state.approvalsByTeamId, [teamId]: [] },
              artifactsByTeamId: { ...state.artifactsByTeamId, [teamId]: [] },
              messagesByTeamId: { ...state.messagesByTeamId, [teamId]: [] },
              mailsByTeamId: { ...state.mailsByTeamId, [teamId]: [] },
              dispatchesByTeamId: { ...state.dispatchesByTeamId, [teamId]: [] },
              dispatchExecutionsByTeamId: { ...state.dispatchExecutionsByTeamId, [teamId]: [] },
              gatesByTeamId: { ...state.gatesByTeamId, [teamId]: [] },
              kickbacksByTeamId: { ...state.kickbacksByTeamId, [teamId]: [] },
              decisionsByTeamId: { ...state.decisionsByTeamId, [teamId]: [] },
              eventsByTeamId: { ...state.eventsByTeamId, [teamId]: nextRunId ? state.eventsByRunId[nextRunId] ?? [] : [] },
              eventCursorByTeamId: { ...state.eventCursorByTeamId, [teamId]: nextRunId ? state.eventCursorByRunId[nextRunId] : undefined },
              loadingByTeamId: { ...state.loadingByTeamId, [teamId]: false },
            };
          });
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
          const runId = team.activeRunId;
          if (!runId) {
            set((state) => emptyTeamRunProjection(teamId, state));
            return;
          }
          const snapshot = await readTeamRunSnapshot({
            runId,
            eventCursor: state.eventCursorByRunId[runId],
            eventLimit: 200,
          });
          set((state) => {
            const isRequestedRunStillActive = state.teams.find((team) => team.id === teamId)?.activeRunId === runId;
            const runIds = appendRunId(state.runIdsByTeamId[teamId], runId);
            const eventsForRun = mergeEvents(state.eventsByRunId[runId] ?? [], snapshot.events);
            const runLevelCache = {
              runsById: snapshot.run ? { ...state.runsById, [runId]: snapshot.run } : state.runsById,
              eventsByRunId: { ...state.eventsByRunId, [runId]: eventsForRun },
              eventCursorByRunId: { ...state.eventCursorByRunId, [runId]: snapshot.nextEventCursor },
            };
            if (!isRequestedRunStillActive) {
              return runLevelCache;
            }
            return {
              runIdsByTeamId: { ...state.runIdsByTeamId, [teamId]: runIds },
              runListByTeamId: snapshot.run ? {
                ...state.runListByTeamId,
                [teamId]: (state.runListByTeamId[teamId] ?? [])
                  .filter((teamRun) => teamRun.runId !== runId)
                  .concat({ ...snapshot.run, sessions: snapshot.roles }),
              } : state.runListByTeamId,
              ...runLevelCache,
              runByTeamId: { ...state.runByTeamId, [teamId]: snapshot.run ?? state.runsById[runId] },
              rolesByTeamId: { ...state.rolesByTeamId, [teamId]: snapshot.roles },
              stagesByTeamId: { ...state.stagesByTeamId, [teamId]: snapshot.stages },
              workflowPlanByTeamId: { ...state.workflowPlanByTeamId, [teamId]: snapshot.workflowPlan },
              dispatchGroupsByTeamId: { ...state.dispatchGroupsByTeamId, [teamId]: snapshot.dispatchGroups },
              dispatchTasksByTeamId: { ...state.dispatchTasksByTeamId, [teamId]: snapshot.dispatchTasks },
              approvalsByTeamId: { ...state.approvalsByTeamId, [teamId]: snapshot.approvals },
              artifactsByTeamId: { ...state.artifactsByTeamId, [teamId]: snapshot.artifacts },
              messagesByTeamId: { ...state.messagesByTeamId, [teamId]: snapshot.messages },
              mailsByTeamId: { ...state.mailsByTeamId, [teamId]: snapshot.mails },
              dispatchesByTeamId: { ...state.dispatchesByTeamId, [teamId]: snapshot.dispatches },
              dispatchExecutionsByTeamId: { ...state.dispatchExecutionsByTeamId, [teamId]: snapshot.dispatchExecutions },
              gatesByTeamId: { ...state.gatesByTeamId, [teamId]: snapshot.gates },
              kickbacksByTeamId: { ...state.kickbacksByTeamId, [teamId]: snapshot.kickbacks },
              decisionsByTeamId: { ...state.decisionsByTeamId, [teamId]: snapshot.decisions },
              eventsByTeamId: { ...state.eventsByTeamId, [teamId]: eventsForRun },
              eventCursorByTeamId: { ...state.eventCursorByTeamId, [teamId]: snapshot.nextEventCursor },
            };
          });
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
          const runId = resolveActiveRunId(state, teamId);
          await tickTeamRun({
            runId,
            idempotencyKey: requestId,
          });
          await get().refreshSnapshot(teamId, { force: true });
        });
      },
      resumeRun: async (teamId) => {
        const actionKey = idempotencyKey(teamId, 'resume');
        await runActionOnce(actionKey, async (requestId) => {
          const result = await resumeTeam({
            teamId,
            idempotencyKey: requestId,
          });
          const activeRunId = result.activeRunIds.length > 0
            ? selectMostRecentRunId(result.activeRunIds, get().runsById) ?? result.activeRunIds[0]
            : undefined;
          if (activeRunId) {
            set((state) => ({
              teams: state.teams.map((team) => team.id === teamId ? { ...team, activeRunId, updatedAt: Date.now() } : team),
              runIdsByTeamId: { ...state.runIdsByTeamId, [teamId]: mergeRunIds(state.runIdsByTeamId[teamId] ?? [], result.restoredRunIds) },
            }));
          }
          await get().refreshSnapshot(teamId, { force: true });
        });
      },
      cancelRun: async (teamId, reason) => {
        const state = get();
        const runId = resolveActiveRunId(state, teamId);
        await cancelTeamRun({
          runId,
          reason,
          idempotencyKey: idempotencyKey(teamId, `cancel:${runId}`),
        });
        await get().refreshSnapshot(teamId, { force: true });
      },
      resolveApproval: async (teamId, approvalId, decision, note) => {
        const state = get();
        const runId = resolveActiveRunId(state, teamId);
        await resolveTeamApproval({
          runId,
          approvalId,
          decision,
          note,
          idempotencyKey: idempotencyKey(teamId, `approval:${runId}:${approvalId}:${decision}`),
        });
        await get().refreshSnapshot(teamId, { force: true });
      },
      submitDecision: async (teamId, decision, note) => {
        const state = get();
        const runId = resolveActiveRunId(state, teamId);
        const run = state.runByTeamId[teamId] ?? state.runsById[runId];
        if (!run) {
          throw new Error(`Team run is required: ${teamId}`);
        }
        if (run.status !== 'waiting_for_user') {
          return;
        }
        const actionKey = idempotencyKey(
          teamId,
          `decision:${run.runId}:${run.currentStageId ?? 'no-stage'}:${run.revision}:${decision}`,
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
      version: 4,
      migrate: (persisted) => {
        if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
          return { teams: [], activeTeamId: null, runIdsByTeamId: {}, runListByTeamId: {}, runsById: {} };
        }
        const state = persisted as { teams?: unknown; activeTeamId?: unknown; runIdsByTeamId?: unknown; runsById?: unknown };
        const teams = Array.isArray(state.teams) ? state.teams.filter(isTeamMeta) : [];
        const activeTeamId = typeof state.activeTeamId === 'string' && teams.some((team) => team.id === state.activeTeamId)
          ? state.activeTeamId
          : null;
        const runsById = state.runsById && typeof state.runsById === 'object' && !Array.isArray(state.runsById)
          ? Object.fromEntries(Object.entries(state.runsById).filter((entry): entry is [string, TeamRunRecord] => isTeamRunRecord(entry[1])))
          : {};
        const runIdsByTeamId = state.runIdsByTeamId && typeof state.runIdsByTeamId === 'object' && !Array.isArray(state.runIdsByTeamId)
          ? Object.fromEntries(Object.entries(state.runIdsByTeamId).flatMap(([teamId, runIds]) => {
            if (!teams.some((team) => team.id === teamId) || !Array.isArray(runIds)) {
              return [];
            }
            return [[teamId, runIds.filter((runId): runId is string => typeof runId === 'string' && isSafeRunId(runId))]];
          }))
          : {};
        return { teams, activeTeamId, runIdsByTeamId, runListByTeamId: {}, runsById };
      },
      partialize: (state) => ({
        teams: state.teams,
        activeTeamId: state.activeTeamId,
        runIdsByTeamId: state.runIdsByTeamId,
        runListByTeamId: state.runListByTeamId,
        runsById: state.runsById,
      }),
    },
  ),
);
