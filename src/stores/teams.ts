import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useChatStore } from '@/stores/chat';
import { buildSessionIdentityRecordIndex, findSessionRecordKey } from '@/stores/chat/session-identity';
import { patchSessionItemsAndViewport, patchSessionRecord } from '@/stores/chat/store-state-helpers';
import { DEFAULT_SESSION_KEY, type ChatSessionRecord } from '@/stores/chat/types';
import type { SessionRenderItem } from '../../runtime-host/shared/session-adapter-types';
import {
  cancelTeamRun,
  createTeamRun,
  deleteTeamInstance,
  exportTeamRunGraphYaml,
  importTeamRunGraphYaml,
  deleteTeamRun,
  listTeamRuns,
  provisionTeamAgents,
  readTeamRunSnapshot,
  resolveTeamApproval,
  resumeTeam,
  saveTeamRunGraphProjection,
  submitTeamRunDecision,
  submitTeamRunRoleMessage,
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
  type TeamGraphSnapshotRecord,
  type TeamGraphYamlExportResult,
  type TeamGraphYamlImportResult,
  type TeamKickbackRecord,
  type TeamNodePromptDeliveryAttemptRecord,
  type TeamNodeExecutionRecord,
  type TeamMessageRecord,
  type TeamRoleBindingRecord,
  type TeamRunListItem,
  type TeamRunRecord,
  type TeamRunSummary,
  type ManualTeamProvisionRecord,
  type TeamRunWorkflowPlan,
  type TeamSkillPackage,
  type TeamSourceType,
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
  sourceType?: TeamSourceType;
  manualTeam?: ManualTeamProvisionRecord;
  activeRunId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamSkillCandidate {
  displayName: string;
  packagePath: string;
  teamSkillPackage: TeamSkillPackage;
}

export interface ManualTeamCandidate {
  displayName: string;
  manualTeam: ManualTeamProvisionRecord;
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
  graphByTeamId: Record<string, TeamGraphSnapshotRecord | null | undefined>;
  workflowPlanByTeamId: Record<string, TeamRunWorkflowPlan | null | undefined>;
  dispatchGroupsByTeamId: Record<string, TeamDispatchGroupRecord[]>;
  dispatchTasksByTeamId: Record<string, TeamDispatchTaskRecord[]>;
  approvalsByTeamId: Record<string, TeamApprovalRecord[]>;
  artifactsByTeamId: Record<string, TeamArtifactRecord[]>;
  messagesByTeamId: Record<string, TeamMessageRecord[]>;
  nodeExecutionsByTeamId: Record<string, TeamNodeExecutionRecord[]>;
  nodePromptDeliveryAttemptsByTeamId: Record<string, TeamNodePromptDeliveryAttemptRecord[]>;
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
  createManualTeam: (input: ManualTeamCandidate) => string;
  replaceTeamSkillVersion: (input: { teamId: string; expectedCurrentVersion: string; candidate: TeamSkillCandidate }) => string;
  setActiveTeam: (teamId: string | null) => void;
  setActiveRun: (teamId: string, runId: string | null) => void;
  deleteTeam: (teamId: string) => Promise<void>;
  provisionTeamAgents: (teamId: string) => Promise<void>;
  createRun: (teamId: string) => Promise<TeamRunSummary | undefined>;
  syncRunList: (teamId: string) => Promise<void>;
  deleteRun: (teamId: string, runId?: string) => Promise<void>;
  refreshSnapshot: (teamId: string, options?: { force?: boolean }) => Promise<void>;
  saveGraph: (teamId: string, graph: TeamGraphSnapshotRecord) => Promise<void>;
  exportGraphYaml: (teamId: string) => Promise<TeamGraphYamlExportResult>;
  importGraphYaml: (teamId: string, yaml: string) => Promise<TeamGraphYamlImportResult>;
  resumeRun: (teamId: string) => Promise<void>;
  cancelRun: (teamId: string, reason?: string) => Promise<void>;
  resolveApproval: (
    teamId: string,
    approvalId: string,
    decision: 'approve' | 'deny' | 'abort',
    note?: string,
  ) => Promise<void>;
  submitDecision: (teamId: string, decision: TeamDecisionType, note?: string) => Promise<void>;
  submitTeamRoleMessageFromChat: (teamId: string, roleId: string, message: string) => Promise<void>;
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
    sourceType: 'teamskill',
    createdAt: now,
    updatedAt: now,
  };
}

function toManualTeamMeta(input: ManualTeamCandidate, teamId: string, now: number): TeamMeta {
  const teamName = input.displayName.trim() || input.manualTeam.name;
  return {
    id: teamId,
    name: teamName,
    teamSkillName: input.manualTeam.name,
    teamSkillVersion: input.manualTeam.version,
    teamSkillDescription: input.manualTeam.description,
    packagePath: `manual:${teamId}`,
    sourcePath: `manual:${teamId}`,
    sourceType: 'manual',
    manualTeam: {
      ...input.manualTeam,
      name: teamName,
      members: input.manualTeam.members.map((member) => ({ ...member })),
    },
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

function provisionActionKey(team: TeamMeta): string {
  return team.sourceType === 'manual'
    ? `provision-agents:manual:${team.teamSkillVersion}`
    : `provision-agents:${team.teamSkillName}:${team.teamSkillVersion}`;
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

function parseTeamRunRoleSessionKey(sessionKey: string): { runId: string; roleId: string } | null {
  const parts = sessionKey.split(':');
  if (parts.length !== 5 || parts[0] !== 'agent' || parts[2] !== 'team-role') {
    return null;
  }
  const runId = parts[3]?.trim();
  const roleId = parts[4]?.trim();
  return runId && roleId ? { runId, roleId } : null;
}

function isTeamRunRoleSessionKey(sessionKey: string, runIds: ReadonlySet<string>): boolean {
  const parsed = parseTeamRunRoleSessionKey(sessionKey);
  return Boolean(parsed && runIds.has(parsed.runId));
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

function resolveTeamRoleChatSessionRecordKey(
  state: ReturnType<typeof useChatStore.getState>,
  binding: TeamRoleBindingRecord,
): string | null {
  return findSessionRecordKey(state, binding.sessionIdentity)
    ?? Object.entries(state.loadedSessions)
      .find(([, record]) => record.meta.backendSessionKey === binding.sessionKey)?.[0]
    ?? null;
}

function appendOptimisticTeamRoleUserMessage(input: {
  readonly binding: TeamRoleBindingRecord | undefined;
  readonly runId: string;
  readonly roleId: string;
  readonly message: string;
  readonly idempotencyKey: string;
}): { sessionRecordKey: string; itemKey: string } | null {
  const itemKey = `optimistic:user:${input.runId}:${input.roleId}:${input.idempotencyKey}`;
  const assistantItemKey = `optimistic:assistant:${input.runId}:${input.roleId}:${input.idempotencyKey}`;
  let appended: { sessionRecordKey: string; itemKey: string } | null = null;
  useChatStore.setState((state) => {
    const binding = input.binding;
    const sessionRecordKey = binding
      ? resolveTeamRoleChatSessionRecordKey(state, binding)
      : Object.entries(state.loadedSessions)
        .find(([, record]) => {
          const parsed = parseTeamRunRoleSessionKey(record.meta.backendSessionKey);
          return parsed?.runId === input.runId && parsed.roleId === input.roleId;
        })?.[0] ?? null;
    if (!sessionRecordKey) {
      return state;
    }
    const record = state.loadedSessions[sessionRecordKey];
    if (!record || record.items.some((item) => item.key === itemKey || (item.kind === 'user-message' && item.messageId === input.idempotencyKey))) {
      return state;
    }
    const now = Date.now();
    const optimisticUserItem = {
      key: itemKey,
      kind: 'user-message',
      sessionKey: record.meta.backendSessionKey,
      role: 'user',
      text: input.message,
      images: [],
      attachedFiles: [],
      messageId: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
      status: 'sending',
    } as SessionRenderItem;
    const optimisticAssistantItem = {
      key: assistantItemKey,
      kind: 'assistant-turn',
      sessionKey: record.meta.backendSessionKey,
      role: 'assistant',
      runId: input.idempotencyKey,
      text: '',
      createdAt: now,
      updatedAt: now,
      laneKey: 'main',
      turnKey: `team-role:${input.runId}:${input.roleId}:${input.idempotencyKey}`,
      agentId: binding?.agentId ?? input.roleId,
      identitySource: 'client',
      identityMode: 'client',
      identityConfidence: 'strong',
      status: 'streaming',
      segments: [],
      thinking: null,
      tools: [],
      images: [],
      attachedFiles: [],
      pendingState: 'typing',
    } as SessionRenderItem;
    appended = { sessionRecordKey, itemKey };
    const loadedSessions = patchSessionItemsAndViewport(
      state,
      sessionRecordKey,
      [...record.items, optimisticUserItem, optimisticAssistantItem],
      { isAtLatest: true },
    );
    const patchedRecord = loadedSessions[sessionRecordKey] ?? record;
    return {
      ...state,
      loadedSessions: patchSessionRecord(
        { loadedSessions },
        sessionRecordKey,
        {
          runtime: {
            ...patchedRecord.runtime,
            activeRunId: input.idempotencyKey,
            runPhase: 'submitted',
            activeTurnItemKey: assistantItemKey,
            pendingTurnKey: assistantItemKey,
            pendingTurnLaneKey: 'main',
            lastUserMessageAt: now,
            lastError: null,
            lastIssue: null,
            updatedAt: now,
          },
        },
      ),
    };
  });
  return appended;
}

function removeOptimisticTeamRoleUserMessage(optimistic: { sessionRecordKey: string; itemKey: string } | null): void {
  if (!optimistic) {
    return;
  }
  useChatStore.setState((state) => {
    const record = state.loadedSessions[optimistic.sessionRecordKey];
    if (!record || !record.items.some((item) => item.key === optimistic.itemKey)) {
      return state;
    }
    const assistantItemKey = optimistic.itemKey.replace('optimistic:user:', 'optimistic:assistant:');
    const items = record.items.filter((item) => item.key !== optimistic.itemKey && item.key !== assistantItemKey);
    const loadedSessions = patchSessionItemsAndViewport(
      state,
      optimistic.sessionRecordKey,
      items,
      {
        totalItemCount: items.length,
        windowEndOffset: record.window.windowStartOffset + items.length,
        isAtLatest: true,
      },
    );
    const patchedRecord = loadedSessions[optimistic.sessionRecordKey] ?? record;
    const shouldClearRuntime = record.runtime.activeTurnItemKey === assistantItemKey
      || record.runtime.pendingTurnKey === assistantItemKey
      || record.runtime.activeRunId === (record.items.find((item) => item.key === optimistic.itemKey && item.kind === 'user-message') as { messageId?: string } | undefined)?.messageId;
    return {
      ...state,
      loadedSessions: shouldClearRuntime
        ? patchSessionRecord(
            { loadedSessions },
            optimistic.sessionRecordKey,
            {
              runtime: {
                ...patchedRecord.runtime,
                activeRunId: null,
                runPhase: 'idle',
                activeTurnItemKey: null,
                pendingTurnKey: null,
                pendingTurnLaneKey: null,
                lastError: null,
                updatedAt: Date.now(),
              },
            },
          )
        : loadedSessions,
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
    && (record.sourceType === undefined || record.sourceType === 'teamskill' || record.sourceType === 'manual')
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

type TeamRunSnapshotRecord = Awaited<ReturnType<typeof readTeamRunSnapshot>>;

function teamRunSnapshotPatch(teamId: string, runId: string, snapshot: TeamRunSnapshotRecord, state: TeamsState) {
  const runIds = appendRunId(state.runIdsByTeamId[teamId], runId);
  const eventsForRun = mergeEvents(state.eventsByRunId[runId] ?? [], snapshot.events);
  const snapshotRunListItem = snapshot.run ? { ...snapshot.run, sessions: snapshot.roles } : null;
  const currentRunList = state.runListByTeamId[teamId] ?? [];
  const nextRunList = snapshotRunListItem
    ? currentRunList.some((teamRun) => teamRun.runId === runId)
      ? currentRunList.map((teamRun) => teamRun.runId === runId ? snapshotRunListItem : teamRun)
      : [...currentRunList, snapshotRunListItem]
    : currentRunList;
  return {
    runIdsByTeamId: { ...state.runIdsByTeamId, [teamId]: runIds },
    runListByTeamId: snapshot.run ? {
      ...state.runListByTeamId,
      [teamId]: nextRunList,
    } : state.runListByTeamId,
    runsById: snapshot.run ? { ...state.runsById, [runId]: snapshot.run } : state.runsById,
    eventsByRunId: { ...state.eventsByRunId, [runId]: eventsForRun },
    eventCursorByRunId: { ...state.eventCursorByRunId, [runId]: snapshot.nextEventCursor },
    runByTeamId: { ...state.runByTeamId, [teamId]: snapshot.run ?? state.runsById[runId] },
    rolesByTeamId: { ...state.rolesByTeamId, [teamId]: snapshot.roles },
    stagesByTeamId: { ...state.stagesByTeamId, [teamId]: snapshot.stages },
    graphByTeamId: { ...state.graphByTeamId, [teamId]: snapshot.graph },
    workflowPlanByTeamId: { ...state.workflowPlanByTeamId, [teamId]: snapshot.workflowPlan },
    dispatchGroupsByTeamId: { ...state.dispatchGroupsByTeamId, [teamId]: snapshot.dispatchGroups },
    dispatchTasksByTeamId: { ...state.dispatchTasksByTeamId, [teamId]: snapshot.dispatchTasks },
    approvalsByTeamId: { ...state.approvalsByTeamId, [teamId]: snapshot.approvals },
    artifactsByTeamId: { ...state.artifactsByTeamId, [teamId]: snapshot.artifacts },
    messagesByTeamId: { ...state.messagesByTeamId, [teamId]: snapshot.messages },
    nodeExecutionsByTeamId: { ...state.nodeExecutionsByTeamId, [teamId]: snapshot.nodeExecutions },
    nodePromptDeliveryAttemptsByTeamId: { ...state.nodePromptDeliveryAttemptsByTeamId, [teamId]: snapshot.nodePromptDeliveries },
    dispatchesByTeamId: { ...state.dispatchesByTeamId, [teamId]: snapshot.dispatches },
    dispatchExecutionsByTeamId: { ...state.dispatchExecutionsByTeamId, [teamId]: snapshot.dispatchExecutions },
    gatesByTeamId: { ...state.gatesByTeamId, [teamId]: snapshot.gates },
    kickbacksByTeamId: { ...state.kickbacksByTeamId, [teamId]: snapshot.kickbacks },
    decisionsByTeamId: { ...state.decisionsByTeamId, [teamId]: snapshot.decisions },
    eventsByTeamId: { ...state.eventsByTeamId, [teamId]: eventsForRun },
    eventCursorByTeamId: { ...state.eventCursorByTeamId, [teamId]: snapshot.nextEventCursor },
  };
}

function emptyTeamRunProjection(teamId: string, state: TeamsState) {
  return {
    runByTeamId: { ...state.runByTeamId, [teamId]: undefined },
    rolesByTeamId: { ...state.rolesByTeamId, [teamId]: [] },
    stagesByTeamId: { ...state.stagesByTeamId, [teamId]: [] },
    graphByTeamId: { ...state.graphByTeamId, [teamId]: null },
    workflowPlanByTeamId: { ...state.workflowPlanByTeamId, [teamId]: null },
    dispatchGroupsByTeamId: { ...state.dispatchGroupsByTeamId, [teamId]: [] },
    dispatchTasksByTeamId: { ...state.dispatchTasksByTeamId, [teamId]: [] },
    approvalsByTeamId: { ...state.approvalsByTeamId, [teamId]: [] },
    artifactsByTeamId: { ...state.artifactsByTeamId, [teamId]: [] },
    messagesByTeamId: { ...state.messagesByTeamId, [teamId]: [] },
    nodeExecutionsByTeamId: { ...state.nodeExecutionsByTeamId, [teamId]: [] },
    nodePromptDeliveryAttemptsByTeamId: { ...state.nodePromptDeliveryAttemptsByTeamId, [teamId]: [] },
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
      graphByTeamId: {},
      workflowPlanByTeamId: {},
      dispatchGroupsByTeamId: {},
      dispatchTasksByTeamId: {},
      approvalsByTeamId: {},
      artifactsByTeamId: {},
      messagesByTeamId: {},
      nodeExecutionsByTeamId: {},
      nodePromptDeliveryAttemptsByTeamId: {},
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
          graphByTeamId: { ...state.graphByTeamId, [id]: null },
          workflowPlanByTeamId: { ...state.workflowPlanByTeamId, [id]: null },
          dispatchGroupsByTeamId: { ...state.dispatchGroupsByTeamId, [id]: [] },
          dispatchTasksByTeamId: { ...state.dispatchTasksByTeamId, [id]: [] },
          approvalsByTeamId: { ...state.approvalsByTeamId, [id]: [] },
          artifactsByTeamId: { ...state.artifactsByTeamId, [id]: [] },
          messagesByTeamId: { ...state.messagesByTeamId, [id]: [] },
          nodeExecutionsByTeamId: { ...state.nodeExecutionsByTeamId, [id]: [] },
          nodePromptDeliveryAttemptsByTeamId: { ...state.nodePromptDeliveryAttemptsByTeamId, [id]: [] },
          dispatchesByTeamId: { ...state.dispatchesByTeamId, [id]: [] },
          dispatchExecutionsByTeamId: { ...state.dispatchExecutionsByTeamId, [id]: [] },
          gatesByTeamId: { ...state.gatesByTeamId, [id]: [] },
          kickbacksByTeamId: { ...state.kickbacksByTeamId, [id]: [] },
          decisionsByTeamId: { ...state.decisionsByTeamId, [id]: [] },
          eventsByTeamId: { ...state.eventsByTeamId, [id]: [] },
        }));
        return id;
      },
      createManualTeam: (input) => {
        const now = Date.now();
        const id = `team-${now}`;
        const team = toManualTeamMeta(input, id, now);
        set((state) => ({
          teams: [...state.teams, team],
          activeTeamId: id,
          runIdsByTeamId: { ...state.runIdsByTeamId, [id]: [] },
          runListByTeamId: { ...state.runListByTeamId, [id]: [] },
          rolesByTeamId: { ...state.rolesByTeamId, [id]: [] },
          stagesByTeamId: { ...state.stagesByTeamId, [id]: [] },
          graphByTeamId: { ...state.graphByTeamId, [id]: null },
          workflowPlanByTeamId: { ...state.workflowPlanByTeamId, [id]: null },
          dispatchGroupsByTeamId: { ...state.dispatchGroupsByTeamId, [id]: [] },
          dispatchTasksByTeamId: { ...state.dispatchTasksByTeamId, [id]: [] },
          approvalsByTeamId: { ...state.approvalsByTeamId, [id]: [] },
          artifactsByTeamId: { ...state.artifactsByTeamId, [id]: [] },
          messagesByTeamId: { ...state.messagesByTeamId, [id]: [] },
          nodeExecutionsByTeamId: { ...state.nodeExecutionsByTeamId, [id]: [] },
          nodePromptDeliveryAttemptsByTeamId: { ...state.nodePromptDeliveryAttemptsByTeamId, [id]: [] },
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
          ...emptyTeamRunProjection(teamId, state),
          runByTeamId: { ...state.runByTeamId, [teamId]: runId ? state.runsById[runId] : undefined },
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
            graphByTeamId: withoutKey(state.graphByTeamId, teamId),
            workflowPlanByTeamId: withoutKey(state.workflowPlanByTeamId, teamId),
            dispatchGroupsByTeamId: withoutKey(state.dispatchGroupsByTeamId, teamId),
            dispatchTasksByTeamId: withoutKey(state.dispatchTasksByTeamId, teamId),
            approvalsByTeamId: withoutKey(state.approvalsByTeamId, teamId),
            artifactsByTeamId: withoutKey(state.artifactsByTeamId, teamId),
            messagesByTeamId: withoutKey(state.messagesByTeamId, teamId),
            nodeExecutionsByTeamId: withoutKey(state.nodeExecutionsByTeamId, teamId),
            nodePromptDeliveryAttemptsByTeamId: withoutKey(state.nodePromptDeliveryAttemptsByTeamId, teamId),
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
            idempotencyKey: idempotencyKey(team.id, provisionActionKey(team)),
            ...(team.sourceType ? { sourceType: team.sourceType } : {}),
            ...(team.manualTeam ? { manualTeam: team.manualTeam } : {}),
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
        const state = get();
        const team = resolveTeamMeta(state.teams, teamId);
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
            ...(team.sourceType ? { sourceType: team.sourceType } : {}),
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
              ...emptyTeamRunProjection(teamId, state),
              runByTeamId: { ...state.runByTeamId, [teamId]: nextRunId ? state.runsById[nextRunId] : undefined },
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
            const patch = teamRunSnapshotPatch(teamId, runId, snapshot, state);
            if (!isRequestedRunStillActive) {
              return {
                runsById: patch.runsById,
                eventsByRunId: patch.eventsByRunId,
                eventCursorByRunId: patch.eventCursorByRunId,
              };
            }
            return patch;
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
      saveGraph: async (teamId, graph) => {
        const state = get();
        const runId = resolveActiveRunId(state, teamId);
        const actionKey = idempotencyKey(teamId, `graph-save:${runId}:${graph.updatedAt ?? Date.now()}`);
        set((state) => ({
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          const result = await saveTeamRunGraphProjection({
            runId,
            graph,
            idempotencyKey: actionKey,
          });
          if (result.snapshot) {
            set((state) => teamRunSnapshotPatch(teamId, runId, result.snapshot!, state));
            return;
          }
          set((state) => ({
            graphByTeamId: {
              ...state.graphByTeamId,
              [teamId]: { ...graph, runId, updatedAt: graph.updatedAt ?? Date.now() },
            },
          }));
        } catch (error) {
          set((state) => ({
            errorByTeamId: {
              ...state.errorByTeamId,
              [teamId]: error instanceof Error ? error.message : String(error),
            },
          }));
          throw error;
        }
      },
      exportGraphYaml: async (teamId) => {
        const state = get();
        const runId = resolveActiveRunId(state, teamId);
        set((state) => ({
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          return await exportTeamRunGraphYaml({ runId });
        } catch (error) {
          set((state) => ({
            errorByTeamId: {
              ...state.errorByTeamId,
              [teamId]: error instanceof Error ? error.message : String(error),
            },
          }));
          throw error;
        }
      },
      importGraphYaml: async (teamId, yaml) => {
        const state = get();
        const runId = resolveActiveRunId(state, teamId);
        const actionKey = idempotencyKey(teamId, `graph-import-yaml:${runId}:${createRequestId('yaml')}`);
        set((state) => ({
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          const result = await importTeamRunGraphYaml({ runId, yaml, idempotencyKey: actionKey });
          if (result.snapshot) {
            set((state) => teamRunSnapshotPatch(teamId, runId, result.snapshot!, state));
          }
          return result;
        } catch (error) {
          set((state) => ({
            errorByTeamId: {
              ...state.errorByTeamId,
              [teamId]: error instanceof Error ? error.message : String(error),
            },
          }));
          throw error;
        }
      },
      resumeRun: async (teamId) => {
        const actionKey = idempotencyKey(teamId, 'resume');
        await runActionOnce(actionKey, async (requestId) => {
          const result = await resumeTeam({
            teamId,
            idempotencyKey: requestId,
          });
          const resumedRuns = result.runs ?? [];
          const runtimeRunsById = Object.fromEntries(resumedRuns.map((run) => [run.runId, run]));
          const activeRunId = result.activeRunIds.length > 0
            ? selectMostRecentRunId(result.activeRunIds, { ...get().runsById, ...runtimeRunsById }) ?? result.activeRunIds[0]
            : undefined;
          set((state) => ({
            teams: activeRunId
              ? state.teams.map((team) => team.id === teamId ? { ...team, activeRunId, updatedAt: Date.now() } : team)
              : state.teams,
            runIdsByTeamId: { ...state.runIdsByTeamId, [teamId]: mergeRunIds(state.runIdsByTeamId[teamId] ?? [], result.restoredRunIds) },
            runListByTeamId: resumedRuns.length > 0 ? { ...state.runListByTeamId, [teamId]: resumedRuns } : state.runListByTeamId,
            runsById: { ...state.runsById, ...runtimeRunsById },
            rolesByTeamId: activeRunId ? { ...state.rolesByTeamId, [teamId]: runtimeRunsById[activeRunId]?.sessions ?? [] } : state.rolesByTeamId,
          }));
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
      submitTeamRoleMessageFromChat: async (teamId, roleId, message) => {
        let optimistic: { sessionRecordKey: string; itemKey: string } | null = null;
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          const state = get();
          const runId = resolveActiveRunId(state, teamId);
          const actionKey = idempotencyKey(teamId, `role-message:${runId}:${roleId}:${createRequestId('message')}`);
          optimistic = appendOptimisticTeamRoleUserMessage({
            binding: state.rolesByTeamId[teamId]?.find((role) => role.runId === runId && role.roleId === roleId),
            runId,
            roleId,
            message,
            idempotencyKey: actionKey,
          });
          const result = await submitTeamRunRoleMessage({
            runId,
            roleId,
            text: message,
            idempotencyKey: actionKey,
          });
          if (result.snapshot) {
            set((state) => teamRunSnapshotPatch(teamId, runId, result.snapshot!, state));
          } else {
            await get().refreshSnapshot(teamId, { force: true });
          }
        } catch (error) {
          removeOptimisticTeamRoleUserMessage(optimistic);
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
