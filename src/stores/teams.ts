import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { waitForCall } from '@/lib/call-log-await';
import { subscribeBrowserRecovery, subscribeHostEvent } from '@/lib/host-events';
import type { TeamDesignRecord, TeamDesignSnapshot, TeamDesignTarget } from '@/types/team-design';
import { createSessionTraceId, logSessionTrace, summarizeError, summarizeIdentifier } from '@/lib/session-trace';
import { matchesOrganizationIdentity } from '@/types/call-log/organization';
import type { CallRecord } from '@/types/call-log';
import type { WaitForCallOptions } from '@/types/call-log/wait';
import type { ManualTeamCreation, ManualTeamCreationPhase } from '@/types/team-creation';
import { useChatStore } from '@/stores/chat';
import { buildSessionIdentityRecordIndex } from '@/stores/chat/session-identity';
import { DEFAULT_SESSION_KEY, type ChatSessionRecord } from '@/stores/chat/types';
import { buildSessionIdentityKey, type SessionIdentity } from '../types/desktop/runtime-address';
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
  readTeamDesignSnapshot,
  startTeamDesign,
  startTeamRun,
  exitTeamDesign,
  patchTeamDesignGraph,
  resolveTeamApproval,
  resumeTeam,
  submitTeamRunDecision,
  submitTeamRunGraphPatch,
  type TeamApprovalRecord,
  type TeamArtifactRecord,
  type TeamDecisionRecord,
  type TeamDecisionType,
  type TeamDeleteResult,
  type TeamDispatchExecutionRecord,
  type TeamDispatchGroupRecord,
  type TeamDispatchRecord,
  type TeamDispatchTaskRecord,
  type TeamEventRecord,
  type TeamGateRecord,
  type TeamGraphPatchOperation,
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
  type TeamRunStartGateProjection,
  type TeamRunSummary,
  type TeamRunWorkflowPlan,
  type TeamSourceType,
  type TeamStageRecord,
} from '@/services/openclaw/team-runtime-client';

export interface TeamSkillPackage {
  selectionId: string;
  name: string;
  version: string;
  kind: 'team-skill';
  description: string;
}

export interface ManualTeamMemberProvisionRecord {
  agentId: string;
  agentName: string;
  workspace: string;
  roleId: string;
  skills: string[];
  tools: string[];
  model?: string;
  isLeader: boolean;
}

export interface ManualTeamProvisionRecord {
  name: string;
  description: string;
  version: string;
  members: ManualTeamMemberProvisionRecord[];
}

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

export interface TeamRoleChatTarget {
  teamId: string;
  runId: string;
  roleId: string;
  agentId: string;
  localSessionId: string;
  endpointSessionId: string;
  sessionIdentity: SessionIdentity;
}

export interface TeamRoleChatTargetIndex {
  readonly byIdentityKey: ReadonlyMap<string, TeamRoleChatTarget>;
  readonly bySessionKey: ReadonlyMap<string, TeamRoleChatTarget>;
  readonly localSessionKeys: ReadonlySet<string>;
  readonly endpointSessionIds: ReadonlySet<string>;
  readonly materializedSessionKeys: ReadonlySet<string>;
}

export interface TeamRoleSessionProbe {
  readonly sessionIdentity?: SessionIdentity | null;
  readonly sessionKey?: string | null;
  readonly endpointSessionId?: string | null;
}

export interface TeamRoleChatTargetIndexInput {
  readonly teams: readonly TeamMeta[];
  readonly runListByTeamId: Record<string, readonly TeamRunListItem[]>;
  readonly rolesByTeamId: Record<string, readonly TeamRoleBindingRecord[]>;
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
  startGateByTeamId: Record<string, TeamRunStartGateProjection | null | undefined>;
  eventCursorByTeamId: Record<string, number | undefined>;
  eventCursorByRunId: Record<string, number | undefined>;
  loadingByTeamId: Record<string, boolean>;
  errorByTeamId: Record<string, string | undefined>;
  planTeamSkillCreation: (candidate: TeamSkillCandidate) => TeamSkillCreationPlan;
  createTeam: (input: TeamSkillCandidate) => string;
  createManualTeam: (input: ManualTeamCandidate) => string;
  manualTeamCreation: ManualTeamCreation | null;
  designByRunId: Record<string, TeamDesignRecord | undefined>;
  refreshDesignSnapshot: (target: TeamDesignTarget, options?: { invalidate?: boolean }) => Promise<void>;
  observeTeamDesign: (target: TeamDesignTarget) => () => void;
  startDesign: (target: TeamDesignTarget) => Promise<void>;
  startRun: (target: TeamDesignTarget) => Promise<void>;
  exitDesign: (target: TeamDesignTarget) => Promise<void>;
  submitRunGraphPatch: (target: TeamDesignTarget, operations: TeamGraphPatchOperation[]) => Promise<void>;
  createManualTeamWithProgress: (input: ManualTeamCandidate) => Promise<string>;
  resetManualTeamCreation: () => void;
  replaceTeamSkillVersion: (input: { teamId: string; expectedCurrentVersion: string; candidate: TeamSkillCandidate }) => string;
  setActiveTeam: (teamId: string | null) => void;
  setActiveRun: (teamId: string, runId: string | null) => void;
  deleteTeam: (teamId: string) => Promise<TeamDeleteResult>;
  provisionTeamAgents: (teamId: string, options?: Pick<WaitForCallOptions<'organization'>, 'onUpdate'>) => Promise<void>;
  createRun: (teamId: string, options?: { onPhase?: (phase: 'initializing_sessions' | 'loading_team') => void }) => Promise<TeamRunSummary | undefined>;
  syncRunList: (teamId: string) => Promise<void>;
  deleteRun: (teamId: string, runId?: string) => Promise<void>;
  refreshSnapshot: (teamId: string, options?: { force?: boolean }) => Promise<void>;
  submitGraphPatch: (teamId: string, operations: TeamGraphPatchOperation[]) => Promise<void>;
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
}

interface TeamDesignRead {
  dirty: boolean;
  removed: boolean;
  promise: Promise<void>;
}

const designReads = new Map<string, TeamDesignRead>();
const designObservers = new Map<string, { target: TeamDesignTarget; count: number }>();
let disposeDesignEvents: (() => void) | null = null;

function designTargetKey(target: TeamDesignTarget): string {
  return JSON.stringify([target.teamId, target.runId]);
}

function refreshObservedDesigns(): void {
  for (const { target } of designObservers.values()) {
    void useTeamsStore.getState().refreshDesignSnapshot(target, { invalidate: true }).catch(() => {});
  }
}

function removeDesignReads(teamId: string, runId?: string): void {
  for (const [key, entry] of actionInFlightByKey) {
    if (!key.startsWith('design:')) continue;
    const [entryTeamId, entryRunId] = JSON.parse(key.slice('design:'.length)) as [string, string];
    if (entryTeamId === teamId && (runId === undefined || entryRunId === runId)) {
      entry.removed = true;
      actionInFlightByKey.delete(key);
    }
  }
  for (const [key, entry] of designReads) {
    const [entryTeamId, entryRunId] = JSON.parse(key) as [string, string];
    if (entryTeamId === teamId && (runId === undefined || entryRunId === runId)) {
      entry.removed = true;
      designReads.delete(key);
    }
  }
  for (const [key, observer] of designObservers) {
    if (observer.target.teamId === teamId && (runId === undefined || observer.target.runId === runId)) designObservers.delete(key);
  }
  if (designObservers.size === 0) {
    disposeDesignEvents?.();
    disposeDesignEvents = null;
  }
}

async function mutateTeamDesign(target: TeamDesignTarget, operation: string, action: (requestId: string) => Promise<unknown>): Promise<void> {
  resolveTeamMeta(useTeamsStore.getState().teams, target.teamId);
  const key = `design:${designTargetKey(target)}`;
  const existing = actionInFlightByKey.get(key);
  if (existing) {
    if (existing.operation !== operation || operation === 'run-graph-patch') throw new Error('Team run mutation is already pending');
    return existing.promise;
  }
  const entry = { requestId: createRequestId(operation.split(':', 1)[0]), operation, removed: false, promise: Promise.resolve() };
  entry.promise = Promise.resolve().then(async () => {
    if (entry.removed) return;
    try {
      try {
        await action(entry.requestId);
      } catch (error) {
        if (!entry.removed) {
          await useTeamsStore.getState().refreshDesignSnapshot(target, { invalidate: true }).catch(() => {});
          if (!entry.removed) useTeamsStore.setState((state) => {
            const current = state.designByRunId[target.runId];
            return current ? { designByRunId: { ...state.designByRunId, [target.runId]: {
              ...current, error: error instanceof Error ? error.message : String(error),
            } } } : {};
          });
        }
        throw error;
      }
      if (!entry.removed) await useTeamsStore.getState().refreshDesignSnapshot(target, { invalidate: true });
    } finally {
      if (actionInFlightByKey.get(key) === entry) {
        actionInFlightByKey.delete(key);
        if (!entry.removed) useTeamsStore.setState((state) => {
          const current = state.designByRunId[target.runId];
          return current ? { designByRunId: { ...state.designByRunId, [target.runId]: { ...current, mutationPending: false } } } : {};
        });
      }
    }
  });
  actionInFlightByKey.set(key, entry);
  useTeamsStore.setState((state) => ({ designByRunId: { ...state.designByRunId, [target.runId]: {
    snapshot: state.designByRunId[target.runId]?.snapshot ?? null,
    loading: state.designByRunId[target.runId]?.loading ?? false,
    error: null,
    mutationPending: true,
  } } }));
  return entry.promise;
}

async function invalidateRunGraph(target: TeamDesignTarget): Promise<void> {
  if (useTeamsStore.getState().designByRunId[target.runId]) {
    await useTeamsStore.getState().refreshDesignSnapshot(target, { invalidate: true }).catch(() => {});
  }
}

const snapshotInFlightByTeamId = new Map<string, Promise<void>>();
const actionInFlightByKey = new Map<string, { requestId: string; promise: Promise<void>; operation?: string; removed?: boolean }>();

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

interface TeamRoleChatTargetIndexEntry {
  readonly identityKey: string;
  readonly localSessionKey: string;
  readonly endpointSessionId: string;
  readonly materializedSessionKey: string | null;
  readonly target: TeamRoleChatTarget;
}

function normalizeTeamRoleSessionKey(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function isOpenClawNativeEndpoint(identity: SessionIdentity): boolean {
  return identity.endpoint.kind === 'native-runtime' && identity.endpoint.runtimeAdapterId === 'openclaw';
}

function resolveTeamRoleMaterializedSessionKey(role: TeamRoleBindingRecord): string | null {
  const endpointSessionId = normalizeTeamRoleSessionKey(role.endpointSessionId);
  if (!endpointSessionId || !isOpenClawNativeEndpoint(role.sessionIdentity)) {
    return null;
  }
  return `agent:${role.agentId}:${endpointSessionId}`;
}

function teamRoleTargetFromBinding(teamId: string, role: TeamRoleBindingRecord): TeamRoleChatTargetIndexEntry {
  const identityKey = buildSessionIdentityKey(role.sessionIdentity);
  const localSessionKey = normalizeTeamRoleSessionKey(role.localSessionId)
    ?? normalizeTeamRoleSessionKey(role.sessionIdentity.sessionKey)
    ?? '';
  const endpointSessionId = normalizeTeamRoleSessionKey(role.endpointSessionId) ?? '';
  const materializedSessionKey = resolveTeamRoleMaterializedSessionKey(role);
  return {
    identityKey,
    localSessionKey,
    endpointSessionId,
    materializedSessionKey,
    target: {
      teamId,
      runId: role.runId,
      roleId: role.roleId,
      agentId: role.agentId,
      localSessionId: localSessionKey,
      endpointSessionId,
      sessionIdentity: role.sessionIdentity,
    },
  };
}

function teamRoleTargetsFromRun(teamId: string, run: TeamRunListItem): TeamRoleChatTargetIndexEntry[] {
  return (run.sessions ?? []).map((role) => teamRoleTargetFromBinding(teamId, role));
}

function teamRoleTargetsFromBindings(teamId: string, roles: readonly TeamRoleBindingRecord[]): TeamRoleChatTargetIndexEntry[] {
  return roles.map((role) => teamRoleTargetFromBinding(teamId, role));
}

function collectTeamRoleChatTargetIndexEntries(input: TeamRoleChatTargetIndexInput): TeamRoleChatTargetIndexEntry[] {
  return input.teams.flatMap((team) => [
    ...teamRoleTargetsFromBindings(team.id, input.rolesByTeamId[team.id] ?? []),
    ...(input.runListByTeamId[team.id] ?? []).flatMap((run) => teamRoleTargetsFromRun(team.id, run)),
  ]);
}

export function buildTeamRoleChatTargetByIdentityKey(input: TeamRoleChatTargetIndexInput): Map<string, TeamRoleChatTarget> {
  return new Map(collectTeamRoleChatTargetIndexEntries(input).map((entry) => [entry.identityKey, entry.target] as const));
}

export function buildTeamRoleChatTargetIndex(input: TeamRoleChatTargetIndexInput): TeamRoleChatTargetIndex {
  const entries = collectTeamRoleChatTargetIndexEntries(input);
  const bySessionKey = new Map<string, TeamRoleChatTarget>();
  const localSessionKeys = new Set<string>();
  const endpointSessionIds = new Set<string>();
  const materializedSessionKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.localSessionKey) {
      localSessionKeys.add(entry.localSessionKey);
      bySessionKey.set(entry.localSessionKey, entry.target);
    }
    if (entry.endpointSessionId) {
      endpointSessionIds.add(entry.endpointSessionId);
      bySessionKey.set(entry.endpointSessionId, entry.target);
    }
    if (entry.materializedSessionKey) {
      materializedSessionKeys.add(entry.materializedSessionKey);
      bySessionKey.set(entry.materializedSessionKey, entry.target);
    }
  }
  return {
    byIdentityKey: new Map(entries.map((entry) => [entry.identityKey, entry.target] as const)),
    bySessionKey,
    localSessionKeys,
    endpointSessionIds,
    materializedSessionKeys,
  };
}

export function resolveTeamRoleChatTarget(targetsByIdentityKey: ReadonlyMap<string, TeamRoleChatTarget>, identity: SessionIdentity | null | undefined): TeamRoleChatTarget | null {
  if (!identity) {
    return null;
  }
  return targetsByIdentityKey.get(buildSessionIdentityKey(identity)) ?? null;
}

export function resolveTeamRoleChatTargetFromProbe(index: TeamRoleChatTargetIndex, probe: TeamRoleSessionProbe): TeamRoleChatTarget | null {
  const identityTarget = resolveTeamRoleChatTarget(index.byIdentityKey, probe.sessionIdentity);
  if (identityTarget) {
    return identityTarget;
  }
  const candidates = [
    probe.endpointSessionId,
    probe.sessionIdentity?.sessionKey,
    probe.sessionKey,
  ];
  for (const candidate of candidates) {
    const key = normalizeTeamRoleSessionKey(candidate);
    if (!key) {
      continue;
    }
    const target = index.bySessionKey.get(key);
    if (target) {
      return target;
    }
  }
  return null;
}

let cachedTeamRoleChatTargetIndexInput: TeamRoleChatTargetIndexInput | null = null;
let cachedTeamRoleChatTargetIndex: TeamRoleChatTargetIndex = buildTeamRoleChatTargetIndex({
  teams: [],
  runListByTeamId: {},
  rolesByTeamId: {},
});

export function selectTeamRoleChatTargetIndex(state: TeamRoleChatTargetIndexInput): TeamRoleChatTargetIndex {
  if (
    cachedTeamRoleChatTargetIndexInput
    && cachedTeamRoleChatTargetIndexInput.teams === state.teams
    && cachedTeamRoleChatTargetIndexInput.runListByTeamId === state.runListByTeamId
    && cachedTeamRoleChatTargetIndexInput.rolesByTeamId === state.rolesByTeamId
  ) {
    return cachedTeamRoleChatTargetIndex;
  }
  cachedTeamRoleChatTargetIndexInput = {
    teams: state.teams,
    runListByTeamId: state.runListByTeamId,
    rolesByTeamId: state.rolesByTeamId,
  };
  cachedTeamRoleChatTargetIndex = buildTeamRoleChatTargetIndex(cachedTeamRoleChatTargetIndexInput);
  return cachedTeamRoleChatTargetIndex;
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
  const packagePath = input.packagePath.trim();
  return {
    id: teamId,
    name: input.displayName.trim() || input.teamSkillPackage.name,
    teamSkillName: input.teamSkillPackage.name,
    teamSkillVersion: input.teamSkillPackage.version,
    teamSkillDescription: input.teamSkillPackage.description,
    packagePath,
    sourcePath: packagePath,
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

function freezeManualTeamCandidate(input: ManualTeamCandidate): ManualTeamCandidate {
  return Object.freeze({
    ...input,
    manualTeam: Object.freeze({
      ...input.manualTeam,
      members: Object.freeze(input.manualTeam.members.map((member) => Object.freeze({
        ...member,
        skills: Object.freeze([...member.skills]),
        tools: Object.freeze([...member.tools]),
      }))),
    }),
  }) as unknown as ManualTeamCandidate;
}

class ConfirmedTeamProvisionFailure extends Error {}

function isConfirmedProvisionFailure(call: CallRecord<'organization'>): boolean {
  return (call.status === 'failed' || call.status === 'rejected')
    && (call.detail.outcome === 'rejected' || call.detail.outcome === 'unavailable')
    && call.detail.provision?.commit !== 'outcome_unknown';
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

function collectTeamRunRoleSessionBindings(
  state: Pick<TeamsState, 'runListByTeamId' | 'rolesByTeamId'>,
  teamId: string,
  runIds: readonly string[],
): TeamRoleBindingRecord[] {
  const runIdSet = new Set(runIds);
  const bindings = [
    ...(state.runListByTeamId[teamId] ?? [])
      .filter((run) => runIdSet.has(run.runId))
      .flatMap((run) => run.sessions),
    ...(state.rolesByTeamId[teamId] ?? [])
      .filter((binding) => runIdSet.has(binding.runId)),
  ];
  const bindingsByIdentity = new Map<string, TeamRoleBindingRecord>();
  for (const binding of bindings) {
    bindingsByIdentity.set(`${binding.runId}:${binding.roleId}:${binding.localSessionId}`, binding);
  }
  return Array.from(bindingsByIdentity.values());
}

function removeTeamRunRoleSessions(bindings: readonly TeamRoleBindingRecord[]): void {
  if (bindings.length === 0) {
    return;
  }
  const identityKeys = new Set(bindings.map((binding) => buildSessionIdentityKey(binding.sessionIdentity)));
  useChatStore.setState((state) => {
    const sessionKeysToDelete = Object.entries(state.loadedSessions)
      .filter(([, record]) => record.meta.sessionIdentity && identityKeys.has(buildSessionIdentityKey(record.meta.sessionIdentity)))
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeTeamGraphNodes(nodes: unknown): TeamGraphSnapshotRecord['nodes'] {
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node) => {
    if (!isRecord(node)) return [];
    const nodeId = readNonEmptyString(node.nodeId);
    if (!nodeId) return [];
    return [{ ...node, nodeId } satisfies TeamGraphSnapshotRecord['nodes'][number]];
  });
}

function normalizeTeamGraphEdges(edges: unknown): TeamGraphSnapshotRecord['edges'] {
  if (!Array.isArray(edges)) return [];
  return edges.flatMap((edge) => {
    if (!isRecord(edge)) return [];
    const edgeId = readNonEmptyString(edge.edgeId);
    const sourceNodeId = readNonEmptyString(edge.sourceNodeId) ?? readNonEmptyString(edge.fromNodeId);
    const targetNodeId = readNonEmptyString(edge.targetNodeId) ?? readNonEmptyString(edge.toNodeId);
    if (!edgeId || !sourceNodeId || !targetNodeId) return [];
    return [{ ...edge, edgeId, sourceNodeId, targetNodeId } satisfies TeamGraphSnapshotRecord['edges'][number]];
  });
}

function normalizeTeamGraphLayout(layout: unknown): TeamGraphSnapshotRecord['layout'] {
  if (!isRecord(layout) || !isRecord(layout.nodePositions)) return { nodePositions: {} };
  const nodePositions: Record<string, { x: number; y: number }> = {};
  for (const [nodeId, position] of Object.entries(layout.nodePositions)) {
    if (!isRecord(position) || typeof position.x !== 'number' || typeof position.y !== 'number') continue;
    nodePositions[nodeId] = { x: position.x, y: position.y };
  }
  return { nodePositions };
}

function normalizeTeamGraphProjection(graph: TeamGraphSnapshotRecord | null | undefined, runId: string): TeamGraphSnapshotRecord | null {
  if (!graph) return null;
  return {
    ...graph,
    runId: graph.runId ?? runId,
    status: readNonEmptyString(graph.status) ?? 'draft',
    layout: normalizeTeamGraphLayout((graph as { layout?: unknown }).layout),
    nodes: normalizeTeamGraphNodes((graph as { nodes?: unknown }).nodes),
    edges: normalizeTeamGraphEdges((graph as { edges?: unknown }).edges),
  };
}

function patchTeamGraphNodeProjection(
  current: TeamGraphSnapshotRecord['nodes'][number],
  patch: Record<string, unknown>,
): TeamGraphSnapshotRecord['nodes'][number] {
  const { roleId: _roleId, groupId: _groupId, taskId: _taskId, executor: _executor, config: _config, ...runtimeProjection } = current;
  return { ...runtimeProjection, ...patch } as TeamGraphSnapshotRecord['nodes'][number];
}

function patchTeamGraphEdgeProjection(
  current: TeamGraphSnapshotRecord['edges'][number],
  patch: Record<string, unknown>,
): TeamGraphSnapshotRecord['edges'][number] {
  const { sourcePort: _sourcePort, targetPort: _targetPort, action: _action, payload: _payload, edgeType: _edgeType, kind: _kind, label: _label, ...runtimeProjection } = current;
  return { ...runtimeProjection, ...patch } as TeamGraphSnapshotRecord['edges'][number];
}

function applyTeamGraphPatchOperations(
  graph: TeamGraphSnapshotRecord,
  operations: readonly TeamGraphPatchOperation[],
): TeamGraphSnapshotRecord {
  let nodes = [...graph.nodes];
  let edges = [...graph.edges];
  let metadata = graph.metadata;
  let nodePositions = { ...(graph.layout?.nodePositions ?? {}) };
  for (const operation of operations) {
    switch (operation.op) {
      case 'add_node': {
        const [node] = normalizeTeamGraphNodes([operation.node]);
        if (node) nodes = [...nodes, node];
        break;
      }
      case 'replace_node':
        nodes = nodes.map((node) => node.nodeId === operation.node.nodeId ? patchTeamGraphNodeProjection(node, operation.node) : node);
        break;
      case 'remove_node':
        nodes = nodes.filter((node) => node.nodeId !== operation.nodeId);
        edges = edges.filter((edge) => edge.sourceNodeId !== operation.nodeId && edge.targetNodeId !== operation.nodeId);
        delete nodePositions[operation.nodeId];
        break;
      case 'add_edge': {
        const [edge] = normalizeTeamGraphEdges([operation.edge]);
        if (edge) edges = [...edges, edge];
        break;
      }
      case 'replace_edge':
        edges = edges.map((edge) => edge.edgeId === operation.edge.edgeId ? patchTeamGraphEdgeProjection(edge, operation.edge) : edge);
        break;
      case 'remove_edge':
        edges = edges.filter((edge) => edge.edgeId !== operation.edgeId);
        break;
      case 'set_node_position':
        nodePositions[operation.nodeId] = operation.position;
        break;
      case 'set_metadata':
        metadata = { ...(metadata ?? {}), ...operation.metadata };
        break;
    }
  }
  return { ...graph, layout: { nodePositions }, nodes, edges, metadata, updatedAt: Date.now() };
}

type TeamRunSnapshotUnavailableSection =
  | 'nodeInputStates'
  | 'roles'
  | 'stages'
  | 'workflowPlan'
  | 'dispatchGroups'
  | 'dispatchTasks'
  | 'dispatches'
  | 'dispatchExecutions'
  | 'messages'
  | 'nodePromptDeliveries'
  | 'gates'
  | 'kickbacks';

type TeamRunSnapshotRecord = Awaited<ReturnType<typeof readTeamRunSnapshot>> & {
  unavailableSections?: TeamRunSnapshotUnavailableSection[];
};

function isSnapshotSectionAvailable(snapshot: TeamRunSnapshotRecord, section: TeamRunSnapshotUnavailableSection): boolean {
  return !snapshot.unavailableSections?.includes(section);
}

function teamRunSnapshotPatch(teamId: string, runId: string, snapshot: TeamRunSnapshotRecord, state: TeamsState) {
  const runIds = appendRunId(state.runIdsByTeamId[teamId], runId);
  const eventsForRun = mergeEvents(state.eventsByRunId[runId] ?? [], snapshot.events);
  const currentRunList = state.runListByTeamId[teamId] ?? [];
  const currentRunListItem = currentRunList.find((teamRun) => teamRun.runId === runId);
  const snapshotRoles = isSnapshotSectionAvailable(snapshot, 'roles') ? snapshot.roles : currentRunListItem?.sessions ?? state.rolesByTeamId[teamId] ?? [];
  const snapshotRunListItem = snapshot.run ? { ...snapshot.run, sessions: snapshotRoles } : null;
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
    rolesByTeamId: isSnapshotSectionAvailable(snapshot, 'roles') ? { ...state.rolesByTeamId, [teamId]: snapshot.roles } : state.rolesByTeamId,
    stagesByTeamId: isSnapshotSectionAvailable(snapshot, 'stages') ? { ...state.stagesByTeamId, [teamId]: snapshot.stages } : state.stagesByTeamId,
    graphByTeamId: { ...state.graphByTeamId, [teamId]: normalizeTeamGraphProjection(snapshot.graph, runId) },
    workflowPlanByTeamId: isSnapshotSectionAvailable(snapshot, 'workflowPlan') ? { ...state.workflowPlanByTeamId, [teamId]: snapshot.workflowPlan } : state.workflowPlanByTeamId,
    dispatchGroupsByTeamId: isSnapshotSectionAvailable(snapshot, 'dispatchGroups') ? { ...state.dispatchGroupsByTeamId, [teamId]: snapshot.dispatchGroups } : state.dispatchGroupsByTeamId,
    dispatchTasksByTeamId: isSnapshotSectionAvailable(snapshot, 'dispatchTasks') ? { ...state.dispatchTasksByTeamId, [teamId]: snapshot.dispatchTasks } : state.dispatchTasksByTeamId,
    approvalsByTeamId: { ...state.approvalsByTeamId, [teamId]: snapshot.approvals },
    artifactsByTeamId: { ...state.artifactsByTeamId, [teamId]: snapshot.artifacts },
    messagesByTeamId: isSnapshotSectionAvailable(snapshot, 'messages') ? { ...state.messagesByTeamId, [teamId]: snapshot.messages } : state.messagesByTeamId,
    nodeExecutionsByTeamId: { ...state.nodeExecutionsByTeamId, [teamId]: snapshot.nodeExecutions },
    nodePromptDeliveryAttemptsByTeamId: isSnapshotSectionAvailable(snapshot, 'nodePromptDeliveries') ? { ...state.nodePromptDeliveryAttemptsByTeamId, [teamId]: snapshot.nodePromptDeliveries } : state.nodePromptDeliveryAttemptsByTeamId,
    dispatchesByTeamId: isSnapshotSectionAvailable(snapshot, 'dispatches') ? { ...state.dispatchesByTeamId, [teamId]: snapshot.dispatches } : state.dispatchesByTeamId,
    dispatchExecutionsByTeamId: isSnapshotSectionAvailable(snapshot, 'dispatchExecutions') ? { ...state.dispatchExecutionsByTeamId, [teamId]: snapshot.dispatchExecutions } : state.dispatchExecutionsByTeamId,
    gatesByTeamId: isSnapshotSectionAvailable(snapshot, 'gates') ? { ...state.gatesByTeamId, [teamId]: snapshot.gates } : state.gatesByTeamId,
    kickbacksByTeamId: isSnapshotSectionAvailable(snapshot, 'kickbacks') ? { ...state.kickbacksByTeamId, [teamId]: snapshot.kickbacks } : state.kickbacksByTeamId,
    decisionsByTeamId: { ...state.decisionsByTeamId, [teamId]: snapshot.decisions },
    eventsByTeamId: { ...state.eventsByTeamId, [teamId]: eventsForRun },
    startGateByTeamId: { ...state.startGateByTeamId, [teamId]: snapshot.startGate },
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
    startGateByTeamId: { ...state.startGateByTeamId, [teamId]: undefined },
    eventCursorByTeamId: { ...state.eventCursorByTeamId, [teamId]: undefined },
  };
}

export const useTeamsStore = create<TeamsState>()(
  persist(
    (set, get) => ({
      teams: [],
      activeTeamId: null,
      manualTeamCreation: null,
      designByRunId: {},
      refreshDesignSnapshot: async (requestedTarget, options) => {
        const target = { ...requestedTarget };
        resolveTeamMeta(get().teams, target.teamId);
        const key = designTargetKey(target);
        const existing = designReads.get(key);
        if (existing) {
          if (options?.invalidate) existing.dirty = true;
          return existing.promise;
        }
        const frozenTarget = { ...target };
        const entry: TeamDesignRead = { dirty: false, removed: false, promise: Promise.resolve() };
        designReads.set(key, entry);
        entry.promise = Promise.resolve().then(async () => {
          if (entry.removed) return;
          set((state) => ({ designByRunId: { ...state.designByRunId, [target.runId]: {
            snapshot: state.designByRunId[target.runId]?.snapshot ?? null, loading: true, mutationPending: state.designByRunId[target.runId]?.mutationPending ?? false, error: null,
          } } }));
          try {
            do {
              entry.dirty = false;
              let snapshot: TeamDesignSnapshot;
              try {
                snapshot = await readTeamDesignSnapshot(frozenTarget);
              } catch (error) {
                if (entry.dirty && !entry.removed) continue;
                throw error;
              }
              if (entry.removed) return;
              if (entry.dirty) continue;
              set((state) => state.teams.some((team) => team.id === target.teamId) ? {
                designByRunId: { ...state.designByRunId, [target.runId]: { snapshot, loading: false, mutationPending: state.designByRunId[target.runId]?.mutationPending ?? false, error: null } },
              } : {});
            } while (entry.dirty && !entry.removed);
          } catch (error) {
            if (!entry.removed) set((state) => {
              const current = state.designByRunId[target.runId];
              return current ? { designByRunId: { ...state.designByRunId, [target.runId]: {
                ...current, loading: false, error: error instanceof Error ? error.message : String(error),
              } } } : {};
            });
            throw error;
          } finally {
            if (designReads.get(key) === entry) designReads.delete(key);
          }
        });
        return entry.promise;
      },
      observeTeamDesign: (target) => {
        resolveTeamMeta(get().teams, target.teamId);
        const key = designTargetKey(target);
        const observer = designObservers.get(key) ?? { target: { ...target }, count: 0 };
        observer.count += 1;
        designObservers.set(key, observer);
        if (!disposeDesignEvents) {
          const disposeChanged = subscribeHostEvent('team:changed', refreshObservedDesigns);
          const disposeRestart = subscribeHostEvent('runtime-host:restart', refreshObservedDesigns);
          const disposeRecovery = subscribeBrowserRecovery(refreshObservedDesigns);
          disposeDesignEvents = () => { disposeChanged(); disposeRestart(); disposeRecovery(); };
        }
        void get().refreshDesignSnapshot(observer.target).catch(() => {});
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          observer.count -= 1;
          if (observer.count === 0 && designObservers.get(key) === observer) designObservers.delete(key);
          if (designObservers.size === 0) {
            disposeDesignEvents?.();
            disposeDesignEvents = null;
          }
        };
      },
      startDesign: async (target) => {
        const frozenTarget = { ...target };
        await mutateTeamDesign(frozenTarget, 'design-start', (requestId) => startTeamDesign({ ...frozenTarget, idempotencyKey: requestId }));
      },
      startRun: async (target) => {
        const frozenTarget = { ...target };
        const snapshot = get().designByRunId[frozenTarget.runId]?.snapshot;
        if (snapshot?.teamId !== frozenTarget.teamId || snapshot.runId !== frozenTarget.runId
          || !(snapshot.startGate.status === 'intake' && snapshot.designEpoch === null
            || snapshot.startGate.status === 'designing' && snapshot.startGate.designEpoch === snapshot.designEpoch
              && snapshot.startGate.graphVersion === snapshot.graphVersion)) {
          throw new Error('Team run start snapshot is required');
        }
        const designEpoch = snapshot.designEpoch;
        const expectedGraphVersion = snapshot.graphVersion;
        await mutateTeamDesign(frozenTarget, `run-start:${JSON.stringify([designEpoch, expectedGraphVersion])}`, (requestId) => startTeamRun({
          ...frozenTarget, designEpoch, expectedGraphVersion, idempotencyKey: requestId,
        }));
      },
      exitDesign: async (target) => {
        const frozenTarget = { ...target };
        const snapshot = get().designByRunId[frozenTarget.runId]?.snapshot;
        if (snapshot?.teamId !== frozenTarget.teamId || snapshot.runId !== frozenTarget.runId
          || snapshot.startGate.status !== 'designing'
          || !snapshot.designEpoch || snapshot.startGate.designEpoch !== snapshot.designEpoch) {
          throw new Error('Team design snapshot is required');
        }
        const designEpoch = snapshot.designEpoch;
        await mutateTeamDesign(frozenTarget, `design-exit:${designEpoch}`, () => exitTeamDesign({ ...frozenTarget, designEpoch }));
      },
      submitRunGraphPatch: async (target, operations) => {
        if (operations.length === 0) return;
        const frozenTarget = { ...target };
        const snapshot = get().designByRunId[target.runId]?.snapshot;
        if (!snapshot || snapshot.teamId !== target.teamId || snapshot.runId !== target.runId) {
          throw new Error('Team run snapshot is required');
        }
        const designActive = snapshot.startGate.status === 'designing';
        const designEpoch = snapshot.designEpoch;
        if (designActive && !designEpoch) throw new Error('Team design snapshot is required');
        await mutateTeamDesign(frozenTarget, 'run-graph-patch', async (requestId) => {
          if (designActive) return await patchTeamDesignGraph({
            ...frozenTarget,
            designEpoch: designEpoch!,
            expectedGraphVersion: snapshot.graphVersion,
            commandId: requestId,
            idempotencyKey: requestId,
            operations,
          });
          await submitTeamRunGraphPatch({
            runId: frozenTarget.runId,
            summary: 'graph_patch',
            patch: {
              ...(snapshot.graph.graphId ? { baseGraphId: snapshot.graph.graphId } : {}),
              ...(snapshot.graph.workflowPlanId ? { baseWorkflowPlanId: snapshot.graph.workflowPlanId } : {}),
              operations,
            },
            idempotencyKey: requestId,
          });
          if (get().teams.find((team) => team.id === frozenTarget.teamId)?.activeRunId === frozenTarget.runId) {
            await get().refreshSnapshot(frozenTarget.teamId, { force: true });
          }
        });
      },
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
      startGateByTeamId: {},
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
          startGateByTeamId: { ...state.startGateByTeamId, [id]: undefined },
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
          startGateByTeamId: { ...state.startGateByTeamId, [id]: undefined },
        }));
        return id;
      },
      createManualTeamWithProgress: async (input) => {
        if (get().manualTeamCreation) throw new Error('The previous manual team creation must be resolved before creating another team');
        const candidate = freezeManualTeamCandidate(input);
        const startedAt = Date.now();
        let teamId: string | null = null;
        let callId: string | null = null;
        let revision = 0;
        set({ manualTeamCreation: { status: 'running', cleanup: 'none', teamId, candidate, startedAt, endedAt: null, phase: 'submitting', preparationObserved: false, progress: null, error: null } });
        const updatePhase = (phase: ManualTeamCreationPhase) => set((state) => {
          const current = state.manualTeamCreation;
          return current?.candidate === candidate && current.status === 'running'
            ? { manualTeamCreation: { ...current, phase } } : {};
        });
        try {
          teamId = get().createManualTeam(candidate);
          set((state) => ({ manualTeamCreation: { ...state.manualTeamCreation!, teamId } }));
          const memberCount = candidate.manualTeam.members.filter((member) => !member.isLeader).length;
          await get().provisionTeamAgents(teamId, { onUpdate: (call) => {
            const current = get().manualTeamCreation;
            if (current?.candidate !== candidate || current.status !== 'running') return;
            if (callId !== null && call.callId !== callId) throw new Error('Manual team progress does not match the provision call');
            if (call.revision <= revision) return;
            const progress = call.detail.provision?.progress;
            if (progress && progress.members.length !== memberCount) throw new Error('Manual team progress does not match the selected members');
            callId = call.callId;
            revision = call.revision;
            set((state) => {
              const current = state.manualTeamCreation;
              return current?.candidate === candidate && current.status === 'running'
                ? { manualTeamCreation: {
                  ...current,
                  phase: progress?.stage ?? current.phase,
                  preparationObserved: current.preparationObserved || progress?.stage === 'reading_profiles' || progress?.stage === 'generating_introductions',
                  progress: progress ? { ...progress, members: [...progress.members], callId: call.callId, revision: call.revision } : null,
                } } : {};
            });
          } });
          await get().createRun(teamId, { onPhase: updatePhase });
          set({ manualTeamCreation: null });
          return teamId;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const current = get().manualTeamCreation!;
          if (teamId === null) {
            set({ manualTeamCreation: { ...current, status: 'failed', cleanup: 'confirmed', error: message, endedAt: Date.now() } });
          } else if (error instanceof ConfirmedTeamProvisionFailure) {
            set({ manualTeamCreation: { ...current, status: 'cleaning_up', cleanup: 'none', error: message, endedAt: null } });
            try {
              const result = await get().deleteTeam(teamId);
              if (result.state !== 'tombstoned' || result.teamId !== teamId) throw new Error('Manual team cleanup was not confirmed', { cause: error });
              set({ manualTeamCreation: { ...current, status: 'failed', cleanup: 'confirmed', error: message, endedAt: Date.now() } });
            } catch {
              set({ manualTeamCreation: { ...current, status: 'unconfirmed', cleanup: 'unknown', error: message, endedAt: Date.now() } });
            }
          } else {
            set({ manualTeamCreation: { ...current, status: 'unconfirmed', cleanup: 'none', error: message, endedAt: Date.now() } });
          }
          throw error;
        }
      },
      resetManualTeamCreation: () => {
        const current = get().manualTeamCreation;
        if (current?.status === 'failed' && current.cleanup === 'confirmed') set({ manualTeamCreation: null });
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
          teams: state.teams.map((team) => {
            const packagePath = input.candidate.packagePath.trim();
            return team.id === input.teamId
              ? {
                ...team,
                name: input.candidate.displayName.trim() || team.name,
                teamSkillVersion: input.candidate.teamSkillPackage.version,
                teamSkillDescription: input.candidate.teamSkillPackage.description,
                packagePath,
                sourcePath: packagePath,
                activeRunId: undefined,
                updatedAt: now,
              }
              : team;
          }),
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
        set((state) => {
          const selectedRun = runId ? state.runListByTeamId[teamId]?.find((run) => run.runId === runId) : undefined;
          return {
            teams: state.teams.map((team) => team.id === teamId ? { ...team, activeRunId: runId ?? undefined, updatedAt: Date.now() } : team),
            ...emptyTeamRunProjection(teamId, state),
            runByTeamId: { ...state.runByTeamId, [teamId]: selectedRun ?? (runId ? state.runsById[runId] : undefined) },
            rolesByTeamId: { ...state.rolesByTeamId, [teamId]: selectedRun?.sessions ?? [] },
            eventsByTeamId: { ...state.eventsByTeamId, [teamId]: runId ? state.eventsByRunId[runId] ?? [] : [] },
            startGateByTeamId: { ...state.startGateByTeamId, [teamId]: undefined },
            eventCursorByTeamId: { ...state.eventCursorByTeamId, [teamId]: runId ? state.eventCursorByRunId[runId] : undefined },
          };
        });
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
          const receipt = await deleteTeamInstance({ teamId });
          const call = await waitForCall(receipt, 'organization');
          if (call.command !== 'team.delete'
            || !await matchesOrganizationIdentity(call.detail.teamId, call.detail.teamIdHash, teamId)
            || call.status !== 'succeeded' || call.detail.outcome !== 'tombstoned') {
            throw new Error(call.status === 'unknown'
              ? 'Team deletion outcome is unknown'
              : 'Team deletion was not confirmed');
          }
          const runIdsToDelete = mergeRunIds(runIds, get().runIdsByTeamId[teamId] ?? []);
          removeDesignReads(teamId);
          const result: TeamDeleteResult = { teamId, deleted: true, state: 'tombstoned', deletedRunIds: [], deletedAgentIds: [] };
          removeTeamRunRoleSessions(collectTeamRunRoleSessionBindings(get(), teamId, runIdsToDelete));
          set((state) => ({
            teams: state.teams.filter((team) => team.id !== teamId),
            manualTeamCreation: state.manualTeamCreation?.status === 'unconfirmed' && state.manualTeamCreation.teamId === teamId
              ? null : state.manualTeamCreation,
            activeTeamId: state.activeTeamId === teamId ? null : state.activeTeamId,
            runIdsByTeamId: withoutKey(state.runIdsByTeamId, teamId),
            runListByTeamId: withoutKey(state.runListByTeamId, teamId),
            runsById: removeRunIdsFromRecord(state.runsById, runIdsToDelete),
            designByRunId: Object.fromEntries(Object.entries(state.designByRunId).filter(([runId, record]) => !runIdsToDelete.includes(runId) && record?.snapshot?.teamId !== teamId)),
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
            startGateByTeamId: withoutKey(state.startGateByTeamId, teamId),
            eventsByRunId: runIdsToDelete.reduce((eventsByRunId, runId) => withoutKey(eventsByRunId, runId), state.eventsByRunId),
            eventCursorByTeamId: withoutKey(state.eventCursorByTeamId, teamId),
            eventCursorByRunId: runIdsToDelete.reduce((eventCursorByRunId, runId) => withoutKey(eventCursorByRunId, runId), state.eventCursorByRunId),
            loadingByTeamId: withoutKey(state.loadingByTeamId, teamId),
            errorByTeamId: withoutKey(state.errorByTeamId, teamId),
          }));
          return result;
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
      provisionTeamAgents: async (teamId, options) => {
        const team = resolveTeamMeta(get().teams, teamId);
        const started = performance.now();
        let traceId = createSessionTraceId('team-provision');
        logSessionTrace('renderer.team.provision.start', traceId, {
          teamHash: summarizeIdentifier(team.id).hash,
          sourceType: team.sourceType,
          memberCount: team.manualTeam?.members.length ?? null,
        });
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          const receipt = await provisionTeamAgents({
            teamId: team.id,
            packagePath: team.packagePath,
            idempotencyKey: idempotencyKey(team.id, provisionActionKey(team)),
            ...(team.sourceType ? { sourceType: team.sourceType } : {}),
            ...(team.manualTeam ? { manualTeam: team.manualTeam } : {}),
          });
          const callTraceId = `session-trace:team-call:${receipt.callId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}`;
          logSessionTrace('renderer.team.provision.admitted', traceId, {
            callId: receipt.callId,
            callTraceId,
            elapsedMs: performance.now() - started,
          });
          traceId = callTraceId;
          const call = await waitForCall(receipt, 'organization', options?.onUpdate ? { onUpdate: async (call) => {
            if (call.command !== 'team.provisionAgents'
              || !await matchesOrganizationIdentity(call.detail.teamId, call.detail.teamIdHash, team.id)) {
              throw new Error('Team provision progress does not match the requested team');
            }
            await options.onUpdate!(call);
          } } : undefined);
          const identityMatches = call.command === 'team.provisionAgents'
            && await matchesOrganizationIdentity(call.detail.teamId, call.detail.teamIdHash, team.id);
          logSessionTrace('renderer.team.provision.terminal', traceId, {
            callId: receipt.callId,
            commandMatches: call.command === 'team.provisionAgents',
            identityMatches,
            status: call.status,
            outcome: call.detail.outcome,
            nativeInstalled: call.detail.provision?.nativeInstalled ?? null,
            commit: call.detail.provision?.commit ?? null,
            elapsedMs: performance.now() - started,
          });
          if (call.command !== 'team.provisionAgents'
            || !identityMatches
            || call.status !== 'succeeded' || call.detail.outcome !== 'materialized'
            || call.detail.provision?.nativeInstalled !== true || call.detail.provision.commit !== 'committed') {
            const message = call.status === 'unknown'
              ? 'Team provision outcome is unknown'
              : 'Team provision was not confirmed';
            if (identityMatches && isConfirmedProvisionFailure(call)) throw new ConfirmedTeamProvisionFailure(message);
            throw new Error(message);
          }
        } catch (error) {
          logSessionTrace('renderer.team.provision.error', traceId, {
            error: summarizeError(error),
            elapsedMs: performance.now() - started,
          });
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
      createRun: async (teamId, options) => {
        const state = get();
        const team = resolveTeamMeta(state.teams, teamId);
        const runId = createGeneratedTeamRunId();
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          options?.onPhase?.('initializing_sessions');
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
          options?.onPhase?.('loading_team');
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
          const receipt = await deleteTeamRun({ runId });
          const call = await waitForCall(receipt, 'organization');
          if (call.command !== 'team.runDelete'
            || !await matchesOrganizationIdentity(call.detail.runId, call.detail.runIdHash, runId)
            || call.status !== 'succeeded' || call.detail.outcome !== 'purged') {
            throw new Error(call.status === 'unknown'
              ? 'Team run deletion outcome is unknown'
              : 'Team run deletion was not confirmed');
          }
          removeDesignReads(teamId, runId);
          removeTeamRunRoleSessions(collectTeamRunRoleSessionBindings(get(), teamId, [runId]));
          set((state) => {
            const remainingRunIds = (state.runIdsByTeamId[teamId] ?? []).filter((candidate) => candidate !== runId);
            const nextRunId = selectMostRecentRunId(remainingRunIds, state.runsById);
            return {
              teams: state.teams.map((team) => team.id === teamId ? { ...team, activeRunId: nextRunId, updatedAt: Date.now() } : team),
              runIdsByTeamId: { ...state.runIdsByTeamId, [teamId]: remainingRunIds },
              runListByTeamId: { ...state.runListByTeamId, [teamId]: (state.runListByTeamId[teamId] ?? []).filter((run) => run.runId !== runId) },
              runsById: withoutKey(state.runsById, runId),
              designByRunId: withoutKey(state.designByRunId, runId),
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
      submitGraphPatch: async (teamId, operations) => {
        const state = get();
        const runId = resolveActiveRunId(state, teamId);
        const currentGraph = normalizeTeamGraphProjection(state.graphByTeamId[teamId], runId) ?? {
          runId,
          status: 'draft',
          layout: { nodePositions: {} },
          nodes: [],
          edges: [],
        };
        if (operations.length === 0) return;
        set((state) => ({
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          await submitTeamRunGraphPatch({
            runId,
            summary: 'graph_patch',
            patch: {
              ...(currentGraph.graphId ? { baseGraphId: currentGraph.graphId } : {}),
              ...(currentGraph.workflowPlanId ? { baseWorkflowPlanId: currentGraph.workflowPlanId } : {}),
              operations,
            },
            idempotencyKey: createRequestId('graph-patch'),
          });
          set((state) => ({
            graphByTeamId: { ...state.graphByTeamId, [teamId]: applyTeamGraphPatchOperations(currentGraph, operations) },
          }));
          await invalidateRunGraph({ teamId, runId });
        } catch (error) {
          await invalidateRunGraph({ teamId, runId });
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
          await invalidateRunGraph({ teamId, runId });
          return result;
        } catch (error) {
          await invalidateRunGraph({ teamId, runId });
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
