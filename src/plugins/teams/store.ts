import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { shallow } from 'zustand/shallow';
import i18n from '@/i18n';
import { waitForCall } from '@/lib/call-log-await';
import { subscribeBrowserRecovery, subscribeHostEvent } from '@/lib/host-events';
import { isTeamDesignFailure, isTeamDesignPatchOperation, isTeamGraphSourcePortActions, isTeamGraphReworkLimits, isTeamGraphVersion, isTeamReworkLimit, type TeamGraphEditBase, type TeamDesignRecord, type TeamDesignSnapshot, type TeamDesignTarget, type TeamLayoutSave, type TeamRunReworkContinueInput } from '@/types/team-design';
import { isTeamRunRecordProjection } from '@/types/team-workspace';
import { createSessionTraceId, logSessionTrace, summarizeError, summarizeIdentifier } from '@/lib/session-trace';
import { matchesOrganizationIdentity, type TeamCreationFailure } from '@/types/call-log/organization';
import type { CallReceipt, CallRecord } from '@/types/call-log';
import type { WaitForCallOptions } from '@/types/call-log/wait';
import type { ManualTeamCreation, TeamCreationObserver } from '@/plugins/teams/types/team-creation';
import { forgetOwnedSessions } from '@/plugins/chat/session-actions';
import { useChatStore } from '@/plugins/chat/store';
import { agentScope, runtimeEndpointsEqual, sessionIdentitiesEqual, runtimeInstanceScope, validateRuntimeScope, type AgentScope, type RuntimeInstanceScope, type SessionIdentity } from '@/types/desktop/runtime-address';
import {
  cancelTeamRun,
  classifyTeamCreationFailure,
  createTeamRun,
  createTeamRoleSession,
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
  continueTeamRunRework,
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
  type TeamRunSnapshot,
  type TeamRunStartGateProjection,
  type TeamRunSummary,
  type TeamRunWorkflowPlan,
  type TeamStageRecord,
} from '@/plugins/teams/services/team-runtime-client';

import type { ManualTeamCandidate, TeamSkillCandidate, TeamSkillCreationPlan } from '@/plugins/teams/types/team-creation';
import { mergeTeamMessageFragments } from './services/team-message-pages';
import type { TeamMeta } from '@/plugins/teams/types/team';

interface TeamOperationOptions {
  errorFeedback?: 'store' | 'caller';
}

export interface TeamReworkContinuation {
  input: TeamRunReworkContinueInput;
  leaderIdentity: SessionIdentity;
  scope: AgentScope;
  status: 'unconfirmed' | 'outcome-unknown' | 'acknowledged';
  error: string | null;
}

const REWORK_CONTINUE_REJECTIONS = new Set([
  'rework_context_invalid', 'run_not_active', 'execution_expired', 'graph_version_mismatch',
  'invalid_rework_continuation', 'idempotency_conflict', 'command_id_conflict', 'node_not_found',
  'stale_node_execution', 'attempt_number_overflow', 'batch_number_overflow', 'batch_mismatch',
  'scope_busy', 'invalid_rework_port', 'rework_not_blocked', 'rework_limit_not_increased',
  'graph_base_mismatch', 'invalid_graph_patch', 'invalid_settlement_event', 'invalid_node_output_port',
]);

export type TeamRunSnapshotReadRecord = {
  teamId: string;
  snapshot: TeamRunSnapshot | null;
  loading: boolean;
  error: string | null;
};

export type TeamApprovalRunEligibility = 'actionable' | 'cancelled' | 'readonly';

export function selectTeamApprovalRunEligibility(
  state: Pick<TeamsState, 'runSnapshotsByRunId'>,
  teamId: string,
  runId: string,
): TeamApprovalRunEligibility {
  const record = state.runSnapshotsByRunId[runId];
  const snapshot = record?.snapshot;
  if (record?.teamId !== teamId || snapshot?.run?.runId !== runId) return 'readonly';
  if (snapshot.lifecycle === 'cancelled') return 'cancelled';
  return snapshot.lifecycle === 'active' && !record.error
    && snapshot.startGate?.status === 'started' ? 'actionable' : 'readonly';
}

export function isTeamApprovalActionable(approval: TeamApprovalRecord, runEligibility: TeamApprovalRunEligibility): boolean {
  return runEligibility === 'actionable' && approval.status === 'pending'
    && (approval.subject === 'work_node' || approval.subject === 'human_decision');
}

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
  approvalsByRunId: Record<string, TeamApprovalRecord[]>;
  artifactsByRunId: Record<string, TeamArtifactRecord[]>;
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
  runSnapshotsByRunId: Record<string, TeamRunSnapshotReadRecord | undefined>;
  refreshDesignSnapshot: (target: TeamDesignTarget, options?: { invalidate?: boolean }) => Promise<void>;
  observeTeamDesign: (target: TeamDesignTarget) => () => void;
  startDesign: (target: TeamDesignTarget) => Promise<void>;
  startRun: (target: TeamDesignTarget) => Promise<void>;
  reworkContinuations: Record<string, TeamReworkContinuation | undefined>;
  continueRework: (input: TeamRunReworkContinueInput) => Promise<void>;
  exitDesign: (target: TeamDesignTarget) => Promise<void>;
  submitRunGraphPatch: (target: TeamDesignTarget, operations: TeamGraphPatchOperation[], base?: TeamGraphEditBase) => Promise<void>;
  retryRunLayoutSave: (target: TeamDesignTarget) => Promise<void>;
  createRoleSession: (target: TeamDesignTarget, roleId: string, requestId: string) => Promise<TeamRoleBindingRecord>;
  createManualTeamWithProgress: (input: ManualTeamCandidate) => Promise<{ teamId: string; runId: string }>;
  resetManualTeamCreation: () => void;
  replaceTeamSkillVersion: (input: { teamId: string; expectedCurrentVersion: string; candidate: TeamSkillCandidate }) => string;
  setActiveTeam: (teamId: string | null) => void;
  setActiveRun: (teamId: string, runId: string | null) => void;
  deleteTeam: (teamId: string, options?: TeamOperationOptions) => Promise<TeamDeleteResult>;
  provisionTeamAgents: (teamId: string, options?: TeamOperationOptions & TeamCreationObserver & Pick<WaitForCallOptions<'organization'>, 'onUpdate'>) => Promise<void>;
  createRun: (teamId: string, options?: TeamOperationOptions & TeamCreationObserver & { onPhase?: (phase: 'initializing_sessions' | 'loading_team') => void }) => Promise<TeamRunSummary>;
  syncRunList: (teamId: string) => Promise<void>;
  deleteRun: (teamId: string, runId?: string) => Promise<void>;
  refreshSnapshot: (teamId: string, options?: TeamOperationOptions & { force?: boolean; runId?: string; completeMessages?: boolean }) => Promise<void>;
  submitGraphPatch: (teamId: string, operations: TeamGraphPatchOperation[]) => Promise<void>;
  exportGraphYaml: (teamId: string, runId?: string) => Promise<TeamGraphYamlExportResult>;
  importGraphYaml: (teamId: string, yaml: string, runId?: string) => Promise<TeamGraphYamlImportResult>;
  resumeRun: (teamId: string) => Promise<void>;
  cancelRun: (teamId: string, reason?: string, runId?: string) => Promise<void>;
  resolveApproval: (
    target: TeamDesignTarget,
    approvalId: string,
    decision: 'approve' | 'deny' | 'abort',
    note?: string,
  ) => Promise<void>;
  submitDecision: (teamId: string, decision: TeamDecisionType, note?: string) => Promise<void>;
}

interface TeamSnapshotRead {
  dirty: boolean;
  removed: boolean;
  promise: Promise<void>;
}

interface RoleSessionCreation {
  roleId: string;
  removed: boolean;
  receipt?: CallReceipt;
  sessionRef?: string;
  promise?: Promise<TeamRoleBindingRecord>;
}

type TeamLayoutBatch = {
  positions: TeamLayoutSave['positions'];
} & (
  | { status: 'unconfirmed' | 'outcome-unknown'; send: () => Promise<unknown> }
  | { status: 'acknowledged' }
);

interface TeamLayoutWrite {
  target: TeamDesignTarget;
  pending: TeamLayoutSave['positions'];
  batch?: TeamLayoutBatch;
  failure?: { error: unknown };
  promise?: Promise<void>;
  removed: boolean;
  reconciling: boolean;
}

const layoutWrites = new Map<string, TeamLayoutWrite>();
const deletingTeams = new Set<string>();
const roleSessionCreations = new Map<string, RoleSessionCreation>();
const designReads = new Map<string, TeamSnapshotRead>();
const designObservers = new Map<string, { target: TeamDesignTarget; count: number }>();
let disposeDesignEvents: (() => void) | null = null;

function designTargetKey(target: TeamDesignTarget): string {
  return JSON.stringify([target.teamId, target.runId]);
}

export function reworkContinuationKey(input: Pick<TeamRunReworkContinueInput, 'teamId' | 'runId' | 'batchId' | 'nodeId' | 'sourcePort' | 'sourceNodeExecutionId'>): string {
  return JSON.stringify([input.teamId, input.runId, input.batchId, input.nodeId, input.sourcePort, input.sourceNodeExecutionId]);
}

function summarizeTeamDesignSnapshot(snapshot: TeamDesignSnapshot) {
  const nodeStatusCounts = { pending: 0, ready: 0, queued: 0, running: 0, waiting_for_user: 0, completed: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, other: 0 };
  for (const node of snapshot.graph.nodes) {
    const status = node.status && Object.hasOwn(nodeStatusCounts, node.status) ? node.status as keyof typeof nodeStatusCounts : 'other';
    nodeStatusCounts[status] += 1;
  }
  return {
    teamHash: summarizeIdentifier(snapshot.teamId).hash,
    runHash: summarizeIdentifier(snapshot.runId).hash,
    versionHash: summarizeIdentifier(snapshot.graphVersion).hash,
    epochHash: summarizeIdentifier(snapshot.designEpoch).hash,
    startGate: snapshot.startGate.status,
    nodeCount: snapshot.graph.nodes.length,
    nodeStatusCounts,
    runtimeErrorCode: snapshot.runtimeError?.errorCode ?? null,
  };
}

function teamRunErrorMessage(snapshot: TeamDesignSnapshot): string | null {
  const failure = snapshot.runtimeError;
  if (!failure) return null;
  const nodeLabel = (nodeId: string) => snapshot.graph.nodes.find((node) => node.nodeId === nodeId)?.title || nodeId;
  const edge = failure.edgeId && snapshot.graph.edges.find((edge) => edge.edgeId === failure.edgeId);
  const location = edge
    ? `${nodeLabel(edge.sourceNodeId)} → ${nodeLabel(edge.targetNodeId)}`
    : failure.nodeId ? nodeLabel(failure.nodeId) : null;
  return location ? `${location}: ${failure.error}` : failure.error;
}

function refreshObservedDesigns(): void {
  const state = useTeamsStore.getState();
  for (const { target } of designObservers.values()) {
    const key = designTargetKey(target);
    const mutation = actionInFlightByKey.get(`design:${key}`);
    const layout = layoutWrites.get(key);
    if (layout?.promise ? layout.batch && !layout.reconciling
      : (mutation?.operation === 'run-graph-patch' || mutation?.operation === 'run-graph-import' || mutation?.operation?.startsWith('run-rework-continue:')) && !mutation.reconciling) continue;
    void state.refreshDesignSnapshot(target, { invalidate: true }).catch(() => {});
    void state.refreshSnapshot(target.teamId, { force: true, runId: target.runId }).catch(() => {});
  }
}

function removeRunReads(teamId: string, runId?: string): void {
  useTeamsStore.setState((state) => ({
    reworkContinuations: Object.fromEntries(Object.entries(state.reworkContinuations)
      .filter(([, request]) => request && (request.input.teamId !== teamId || runId !== undefined && request.input.runId !== runId))),
    runSnapshotsByRunId: Object.fromEntries(Object.entries(state.runSnapshotsByRunId)
      .filter(([entryRunId, record]) => record?.teamId !== teamId || runId !== undefined && entryRunId !== runId)),
  }));
  for (const [key, entry] of layoutWrites) {
    if (entry.target.teamId === teamId && (runId === undefined || entry.target.runId === runId)) {
      entry.removed = true;
      layoutWrites.delete(key);
    }
  }
  for (const [key, entry] of roleSessionCreations) {
    const [entryTeamId, entryRunId] = JSON.parse(key) as [string, string, string];
    if (entryTeamId === teamId && (runId === undefined || entryRunId === runId)) {
      entry.removed = true;
      roleSessionCreations.delete(key);
    }
  }
  for (const [key, entry] of actionInFlightByKey) {
    if (!key.startsWith('design:')) continue;
    const [entryTeamId, entryRunId] = JSON.parse(key.slice('design:'.length)) as [string, string];
    if (entryTeamId === teamId && (runId === undefined || entryRunId === runId)) {
      entry.removed = true;
      actionInFlightByKey.delete(key);
    }
  }
  for (const reads of [designReads, snapshotReads]) {
    for (const [key, entry] of reads) {
      const [entryTeamId, entryRunId] = JSON.parse(key) as [string, string];
      if (entryTeamId === teamId && (runId === undefined || entryRunId === runId)) {
        entry.removed = true;
        reads.delete(key);
      }
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

function prepareRunGraphPatch(target: TeamDesignTarget, operations: TeamGraphPatchOperation[], requestId: string, base?: TeamGraphEditBase): () => Promise<unknown> {
  const snapshot = useTeamsStore.getState().designByRunId[target.runId]?.snapshot;
  if (snapshot?.teamId !== target.teamId || snapshot.runId !== target.runId) throw new Error('Team run snapshot is required');
  for (const [expected, current] of [
    [base?.node, base?.node ? snapshot.graph.nodes.find((node) => node.nodeId === base.node!.nodeId) : undefined],
    [base?.edge, base?.edge ? snapshot.graph.edges.find((edge) => edge.edgeId === base.edge!.edgeId) : undefined],
  ] as const) {
    if (expected && (!current || !equalTeamDesignValue(expected,
      Object.fromEntries(Object.keys(expected).map((key) => [key, Reflect.get(current, key)]))))) {
      throw new Error(i18n.t('teams:run.graphCanvas.editConflict'));
    }
  }
  if (base?.reworkLimit) {
    const { nodeId, sourcePort, maxReworks } = base.reworkLimit;
    const node = snapshot.graph.nodes.find((node) => node.nodeId === nodeId);
    if (!node || node.reworkLimits[sourcePort] !== maxReworks) throw new Error(i18n.t('teams:run.graphCanvas.editConflict'));
  }
  const frozenTarget = { ...target, scope: resolveTeamRuntimeScope(target.teamId, target.runId) };
  if (snapshot.startGate.status === 'designing') {
    const designEpoch = snapshot.designEpoch;
    if (!designEpoch) throw new Error('Team design snapshot is required');
    return () => patchTeamDesignGraph({
      ...frozenTarget, designEpoch, expectedGraphVersion: snapshot.graphVersion,
      commandId: requestId, idempotencyKey: requestId, operations,
    });
  }
  return () => submitTeamRunGraphPatch({
    scope: frozenTarget.scope, runId: frozenTarget.runId, summary: 'graph_patch',
    patch: {
      ...(snapshot.graph.graphId ? { baseGraphId: snapshot.graph.graphId } : {}),
      ...(snapshot.graph.workflowPlanId ? { baseWorkflowPlanId: snapshot.graph.workflowPlanId } : {}),
      operations,
    },
    idempotencyKey: requestId,
  });
}

async function reconcileRunGraph(target: TeamDesignTarget): Promise<void> {
  const state = useTeamsStore.getState();
  const [designRead, runRead] = await Promise.allSettled([
    state.refreshDesignSnapshot(target, { invalidate: true }),
    state.refreshSnapshot(target.teamId, { force: true, runId: target.runId }),
  ]);
  if (runRead.status === 'rejected') throw runRead.reason;
  if (designRead.status === 'rejected') throw designRead.reason;
}

function publishLayoutSave(entry: TeamLayoutWrite): void {
  if (entry.removed) return;
  const positions = { ...entry.batch?.positions, ...entry.pending };
  const layoutSave: TeamLayoutSave | undefined = Object.keys(positions).length === 0 ? undefined
    : entry.failure ? { status: 'failed', positions, error: entry.failure.error instanceof Error ? entry.failure.error.message : String(entry.failure.error) }
      : { status: 'saving', positions };
  useTeamsStore.setState((state) => {
    const current = state.designByRunId[entry.target.runId];
    return current?.snapshot?.teamId === entry.target.teamId ? { designByRunId: { ...state.designByRunId,
      [entry.target.runId]: { ...current, layoutSave },
    } } : {};
  });
}

function layoutWriteFailure(error: unknown): 'design-context-stale' | 'context-stale' | 'node-not-found' | 'unconfirmed' {
  if (!(error instanceof Error) || !isTeamDesignFailure(error.cause)) return 'unconfirmed';
  switch (error.cause.errorCode) {
    case 'graph_version_mismatch':
    case 'stale_design_epoch':
    case 'not_designing':
      return 'design-context-stale';
    case 'graph_base_mismatch':
      return 'context-stale';
    case 'node_not_found':
      return 'node-not-found';
    default:
      return 'unconfirmed';
  }
}

function drainRunLayout(entry: TeamLayoutWrite): Promise<void> {
  if (entry.promise) return entry.promise;
  entry.failure = undefined;
  entry.promise = Promise.resolve().then(async () => {
    try {
      while (!entry.removed && (entry.batch || Object.keys(entry.pending).length > 0)) {
        if (!entry.batch) {
          const positions = entry.pending;
          const operations = Object.entries(positions).map(([nodeId, position]) => ({ op: 'set_node_position' as const, nodeId, position }));
          entry.batch = { status: 'unconfirmed', positions, send: prepareRunGraphPatch(entry.target, operations, createRequestId('run-layout')) };
          entry.pending = Object.create(null);
        }
        const batch = entry.batch;
        let failure: { error: unknown } | undefined;
        let rejectedMissingNode = false;
        try {
          if (batch.status !== 'acknowledged') {
            await batch.send();
            entry.batch = { status: 'acknowledged', positions: batch.positions };
          }
        } catch (error) {
          failure = { error };
          const rejection = layoutWriteFailure(error);
          // Renderer design guards run only after the original command is absent from the ledger.
          if (rejection === 'design-context-stale'
            || batch.status === 'unconfirmed' && (rejection === 'context-stale' || rejection === 'node-not-found')) {
            entry.pending = Object.assign(Object.create(null), batch.positions, entry.pending);
            entry.batch = undefined;
            rejectedMissingNode = rejection === 'node-not-found';
          } else if (batch.status !== 'acknowledged') {
            entry.batch = { ...batch, status: 'outcome-unknown' };
          }
        }
        if (entry.removed) {
          if (failure) throw failure.error;
          return;
        }
        entry.reconciling = true;
        try {
          await reconcileRunGraph(entry.target);
          if (rejectedMissingNode) {
            const snapshot = useTeamsStore.getState().designByRunId[entry.target.runId]?.snapshot;
            if (snapshot?.teamId === entry.target.teamId && snapshot.runId === entry.target.runId) {
              const nodeIds = new Set(snapshot.graph.nodes.map((node) => node.nodeId));
              for (const [nodeId, position] of Object.entries(entry.pending)) {
                if (!nodeIds.has(nodeId) && position === batch.positions[nodeId]) delete entry.pending[nodeId];
              }
              if (Object.keys(entry.pending).length === 0) failure = undefined;
            }
          }
        } catch (error) {
          failure ??= { error };
        } finally {
          entry.reconciling = false;
        }
        if (failure) throw failure.error;
        if (entry.removed) return;
        entry.batch = undefined;
        publishLayoutSave(entry);
      }
    } catch (error) {
      entry.failure = { error };
      publishLayoutSave(entry);
      throw error;
    } finally {
      entry.promise = undefined;
      if (!entry.batch && Object.keys(entry.pending).length === 0 && layoutWrites.get(designTargetKey(entry.target)) === entry) {
        layoutWrites.delete(designTargetKey(entry.target));
      }
    }
  });
  publishLayoutSave(entry);
  return entry.promise;
}

async function waitForRunLayout(target: TeamDesignTarget): Promise<void> {
  const entry = layoutWrites.get(designTargetKey(target));
  if (entry?.promise) await entry.promise;
  if (entry?.failure) throw entry.failure.error;
}

function submitRunLayout(target: TeamDesignTarget, operations: Extract<TeamGraphPatchOperation, { op: 'set_node_position' }>[]): Promise<void> {
  resolveTeamMeta(useTeamsStore.getState().teams, target.teamId);
  const key = designTargetKey(target);
  if (deletingTeams.has(target.teamId) || actionInFlightByKey.has(`design:${key}`)) throw new Error('Team run mutation is already pending');
  const snapshot = useTeamsStore.getState().designByRunId[target.runId]?.snapshot;
  if (snapshot?.teamId !== target.teamId || snapshot.runId !== target.runId) throw new Error('Team run snapshot is required');
  const entry: TeamLayoutWrite = layoutWrites.get(key) ?? { target: { ...target }, pending: Object.create(null), removed: false, reconciling: false };
  for (const { nodeId, position } of operations) entry.pending[nodeId] = { ...position };
  layoutWrites.set(key, entry);
  entry.failure = undefined;
  if (entry.promise) publishLayoutSave(entry);
  return drainRunLayout(entry);
}

async function mutateTeamDesign(target: TeamDesignTarget, operation: string, completion: 'acknowledged' | 'reconciled', action: (requestId: string) => Promise<unknown>): Promise<void> {
  resolveTeamMeta(useTeamsStore.getState().teams, target.teamId);
  if (deletingTeams.has(target.teamId)) throw new Error('Team deletion is already pending');
  const key = `design:${designTargetKey(target)}`;
  const existing = actionInFlightByKey.get(key);
  if (existing) {
    if (existing.operation !== operation || operation === 'run-graph-patch' || operation === 'run-graph-import' || operation.startsWith('run-rework-continue:')) throw new Error('Team run mutation is already pending');
    return existing.promise;
  }
  const entry = { requestId: createRequestId(operation.split(':', 1)[0]), operation, removed: false, reconciling: false, promise: Promise.resolve() };
  entry.promise = Promise.resolve().then(async () => {
    if (entry.removed) return;
    try {
      if (operation === 'run-delete' || operation === 'run-cancel') await layoutWrites.get(designTargetKey(target))?.promise?.catch(() => {});
      else await waitForRunLayout(target);
      if (entry.removed) return;
      let actionFailure: { error: unknown } | undefined;
      try {
        await action(entry.requestId);
      } catch (error) {
        actionFailure = { error };
      }
      entry.reconciling = true;
      if (!entry.removed) {
        const state = useTeamsStore.getState();
        const [designRead, runRead] = await Promise.allSettled([
          state.refreshDesignSnapshot(target, { invalidate: true }),
          operation === 'run-graph-patch' || operation === 'run-graph-import' || operation.startsWith('run-rework-continue:')
            ? state.refreshSnapshot(target.teamId, { force: true, runId: target.runId })
            : Promise.resolve(),
        ]);
        // Read errors stay in their records; only reconciled actions require readback to complete.
        const failure = actionFailure ?? (completion === 'reconciled' && runRead.status === 'rejected' ? { error: runRead.reason } : undefined);
        if (failure) {
          const error = failure.error;
          if (!entry.removed) useTeamsStore.setState((state) => {
            const current = state.designByRunId[target.runId];
            return current ? { designByRunId: { ...state.designByRunId, [target.runId]: {
              ...current, error: error instanceof Error ? error.message : String(error),
            } } } : {};
          });
          throw error;
        }
        if (completion === 'reconciled' && designRead.status === 'rejected') throw designRead.reason;
      }
      if (actionFailure) throw actionFailure.error;
    } finally {
      if (actionInFlightByKey.get(key) === entry) {
        actionInFlightByKey.delete(key);
        if (!entry.removed) useTeamsStore.setState((state) => {
          const current = state.designByRunId[target.runId];
          return current ? { designByRunId: { ...state.designByRunId, [target.runId]: { ...current, mutationPending: deletingTeams.has(target.teamId) } } } : {};
        });
      }
    }
  });
  actionInFlightByKey.set(key, entry);
  useTeamsStore.setState((state) => ({ designByRunId: { ...state.designByRunId, [target.runId]: {
    ...state.designByRunId[target.runId],
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

interface TeamRunListRead {
  promise: Promise<void>;
  deletedRunIds: Set<string>;
  // Same-value snapshots still supersede this list's older read without changing projection refs.
  acceptedRunIds: Set<string>;
  acceptedListRoleRunIds: Set<string>;
  acceptedActiveRoleRunIds: Set<string>;
  reading: boolean;
  next?: TeamRunListRead;
}

const snapshotReads = new Map<string, TeamSnapshotRead & { completeMessages: boolean }>();
const runListReads = new Map<string, TeamRunListRead>();
const actionInFlightByKey = new Map<string, { requestId: string; promise: Promise<void>; operation?: string; removed?: boolean; reconciling?: boolean }>();

export function planTeamSkillCreation(state: Pick<TeamsState, 'teams' | 'designByRunId' | 'runListByTeamId' | 'rolesByTeamId'>, candidate: TeamSkillCandidate): TeamSkillCreationPlan {
  const teamSkillName = candidate.teamSkillPackage.name;
  const teamSkillVersion = candidate.teamSkillPackage.version;
  const scope = runtimeInstanceScope(candidate.runtimeScope.endpoint);
  const teams = state.teams.filter((team) => {
    if (team.teamSkillName !== teamSkillName) return false;
    const teamScope = selectTeamRuntimeScope(state, team.id);
    if (!teamScope) throw new Error(i18n.t('teams:chat.runtimeScopeUnavailable'));
    return runtimeEndpointsEqual(teamScope.endpoint, scope.endpoint);
  });
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

export function selectTeamRuntimeScope(
  state: Pick<TeamsState, 'teams' | 'designByRunId' | 'runListByTeamId' | 'rolesByTeamId'>,
  teamId: string,
  runId?: string,
): AgentScope | RuntimeInstanceScope | null {
  const team = state.teams.find((team) => team.id === teamId);
  if (!team) return null;
  const targetRunId = runId ?? team.activeRunId;
  const roles = targetRunId
    ? state.designByRunId[targetRunId]?.snapshot?.roles
      ?? state.runListByTeamId[teamId]?.find((run) => run.runId === targetRunId)?.sessions
      ?? state.rolesByTeamId[teamId]?.filter((role) => role.runId === targetRunId)
    : state.rolesByTeamId[teamId];
  const role = roles?.find((role) => role.roleId === 'leader');
  if (role) return agentScope(role.sessionIdentity.endpoint, role.sessionIdentity.agentId);
  const leader = team.manualTeam?.members.find((member) => member.isLeader);
  if (leader?.endpoint) return agentScope(leader.endpoint, leader.agentId);
  return team.runtimeScope ?? null;
}

export function resolveTeamRuntimeScope(teamId: string, runId?: string): AgentScope | RuntimeInstanceScope {
  const state = useTeamsStore.getState();
  resolveTeamMeta(state.teams, teamId);
  const scope = selectTeamRuntimeScope(state, teamId, runId);
  if (!scope) throw new Error(i18n.t('teams:chat.runtimeScopeUnavailable'));
  return scope;
}

function toTeamMeta(input: TeamSkillCandidate, teamId: string, now: number): TeamMeta {
  const packagePath = input.packagePath.trim();
  return {
    id: teamId,
    runtimeScope: runtimeInstanceScope(input.runtimeScope.endpoint),
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
  const leaders = input.manualTeam.members.filter((member) => member.isLeader);
  if (leaders.length !== 1) throw new Error(i18n.t('teams:create.manualLeaderRequired'));
  const leader = leaders[0];
  return {
    id: teamId,
    runtimeScope: agentScope(leader.endpoint, leader.agentId),
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
      members: input.manualTeam.members.map((member) => ({ ...member, endpoint: { ...member.endpoint }, skills: [...member.skills], tools: [...member.tools] })),
    },
    createdAt: now,
    updatedAt: now,
  };
}

function freezeManualTeamCandidate(input: ManualTeamCandidate): ManualTeamCandidate {
  return Object.freeze({
    ...input,
    runtimeScope: Object.freeze({ ...input.runtimeScope, endpoint: Object.freeze({ ...input.runtimeScope.endpoint }) }),
    manualTeam: Object.freeze({
      ...input.manualTeam,
      members: Object.freeze(input.manualTeam.members.map((member) => Object.freeze({
        ...member,
        endpoint: Object.freeze({ ...member.endpoint }),
        skills: Object.freeze([...member.skills]),
        tools: Object.freeze([...member.tools]),
      }))),
    }),
  }) as unknown as ManualTeamCandidate;
}

class ConfirmedTeamProvisionFailure extends Error {}

function reportTeamError(teamId: string, error: unknown, options?: TeamOperationOptions): void {
  if (options?.errorFeedback === 'caller') return;
  const message = error instanceof Error ? error.message : String(error);
  useTeamsStore.setState((state) => ({ errorByTeamId: { ...state.errorByTeamId, [teamId]: message } }));
}

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

function removeRunIdsFromRecord<T>(record: Record<string, T>, runIds: string[]): Record<string, T> {
  return runIds.reduce((next, runId) => withoutKey(next, runId), record);
}

function collectTeamRunRoleSessionBindings(
  state: Pick<TeamsState, 'runListByTeamId' | 'rolesByTeamId' | 'designByRunId'>,
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
    ...runIds.flatMap((runId) => {
      const snapshot = state.designByRunId[runId]?.snapshot;
      return snapshot?.teamId === teamId ? snapshot.roles : [];
    }),
  ];
  const bindingsByIdentity = new Map<string, TeamRoleBindingRecord>();
  for (const binding of bindings) {
    bindingsByIdentity.set(`${binding.runId}:${binding.roleId}:${binding.localSessionId}`, binding);
  }
  return Array.from(bindingsByIdentity.values());
}

function removeTeamRunRoleSessions(bindings: readonly TeamRoleBindingRecord[]): void {
  forgetOwnedSessions(bindings.map((binding) => binding.sessionIdentity));
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
    && (record.runtimeScope === undefined || validateRuntimeScope(record.runtimeScope) === null && isRecord(record.runtimeScope)
      && (record.runtimeScope.kind === 'agent' || record.runtimeScope.kind === 'runtime-instance'))
    && typeof record.teamSkillName === 'string'
    && typeof record.teamSkillVersion === 'string'
    && typeof record.packagePath === 'string'
    && typeof record.sourcePath === 'string'
    && (record.sourceType === undefined || record.sourceType === 'teamskill' || record.sourceType === 'manual')
    && (record.activeRunId === undefined || (typeof record.activeRunId === 'string' && isSafeRunId(record.activeRunId)));
}

function isTeamRunRecord(value: unknown): value is TeamRunRecord {
  return isTeamRunRecordProjection(value, ['sessions']);
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
    const sourcePortActions = node.sourcePortActions;
    const reworkLimits = node.reworkLimits;
    if (!nodeId || !isTeamGraphSourcePortActions(sourcePortActions, node.sourcePorts)
      || !isTeamGraphReworkLimits(reworkLimits, sourcePortActions)) return [];
    return [{ ...node, nodeId, sourcePortActions, reworkLimits } satisfies TeamGraphSnapshotRecord['nodes'][number]];
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
  const nodePositions: Record<string, { x: number; y: number }> = Object.create(null);
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

function mergeRunMessagePage(previous: TeamRunSnapshotRecord | null, page: TeamRunSnapshotRecord, cursor?: NonNullable<TeamRunSnapshot['messagePage']['nextCursor']>): TeamRunSnapshotRecord {
  if (!cursor) {
    if (page.messages.some((message) => message.bodyOffset !== 0)) throw new Error('Team run message page is not contiguous');
    return previous?.messagePage.revision === page.messagePage.revision
      ? { ...page, messages: previous.messages, messagePage: previous.messagePage } : page;
  }
  const first = page.messages[0];
  const nextCursor = page.messagePage.nextCursor;
  if (!previous || previous.messagePage.revision !== page.messagePage.revision
    || !first || first.messageId !== cursor.messageId || first.bodyOffset !== cursor.bodyOffset
    || nextCursor && nextCursor.messageId === cursor.messageId && nextCursor.bodyOffset === cursor.bodyOffset) {
    throw new Error('Team run message page did not advance');
  }
  return { ...page, messages: mergeTeamMessageFragments(previous.messages, page.messages) };
}

function retainTeamRoleBindings(current: TeamRoleBindingRecord[] | undefined, incoming: TeamRoleBindingRecord[]): TeamRoleBindingRecord[] {
  if (current === incoming || !current) return incoming;
  const currentByBinding = new Map(current.map((role) => [JSON.stringify([role.runId, role.roleId, role.sessionRef]), role]));
  const roles = incoming.map((role) => {
    const previous = currentByBinding.get(JSON.stringify([role.runId, role.roleId, role.sessionRef]));
    if (!previous) return role;
    const next = {
      ...role,
      endpointRef: runtimeEndpointsEqual(previous.endpointRef, role.endpointRef) ? previous.endpointRef : role.endpointRef,
      sessionIdentity: sessionIdentitiesEqual(previous.sessionIdentity, role.sessionIdentity) ? previous.sessionIdentity : role.sessionIdentity,
    };
    return shallow(previous, next) ? previous : next;
  });
  return shallow(current, roles) ? current : roles;
}

// These values come from validated JSON Teams projections, not arbitrary runtime objects.
function equalTeamDesignValue(current: unknown, incoming: unknown): boolean {
  if (Object.is(current, incoming)) return true;
  if (Array.isArray(current)) {
    return Array.isArray(incoming) && current.length === incoming.length
      && current.every((value, index) => equalTeamDesignValue(value, incoming[index]));
  }
  if (!isRecord(current) || !isRecord(incoming)) return false;
  const keys = Object.keys(incoming);
  return keys.length === Object.keys(current).length
    && keys.every((key) => Object.hasOwn(current, key) && equalTeamDesignValue(current[key], incoming[key]));
}

function retainTeamDesignGraph(current: TeamGraphSnapshotRecord | undefined, incoming: TeamGraphSnapshotRecord): TeamGraphSnapshotRecord {
  if (!current || current.runId !== incoming.runId || current.graphId !== incoming.graphId) return incoming;
  const currentNodes = new Map(current.nodes.map((node) => [node.nodeId, node]));
  const nodes = incoming.nodes.map((node) => {
    const previous = currentNodes.get(node.nodeId);
    return equalTeamDesignValue(previous, node) ? previous! : node;
  });
  const currentEdges = new Map(current.edges.map((edge) => [edge.edgeId, edge]));
  const edges = incoming.edges.map((edge) => {
    const previous = currentEdges.get(edge.edgeId);
    return equalTeamDesignValue(previous, edge) ? previous! : edge;
  });
  const graph = {
    ...incoming,
    nodes: shallow(current.nodes, nodes) ? current.nodes : nodes,
    edges: shallow(current.edges, edges) ? current.edges : edges,
    layout: equalTeamDesignValue(current.layout, incoming.layout) ? current.layout : incoming.layout,
    rework: equalTeamDesignValue(current.rework, incoming.rework) ? current.rework : incoming.rework,
  };
  return shallow(current, graph) ? current : graph;
}

function teamRunSnapshotPatch(teamId: string, runId: string, snapshot: TeamRunSnapshotRecord, state: TeamsState) {
  const runIds = appendRunId(state.runIdsByTeamId[teamId], runId);
  const eventsForRun = mergeEvents(state.eventsByRunId[runId] ?? [], snapshot.events);
  const currentRunList = state.runListByTeamId[teamId] ?? [];
  const currentRunListItem = currentRunList.find((teamRun) => teamRun.runId === runId);
  const rolesAvailable = isSnapshotSectionAvailable(snapshot, 'roles');
  const snapshotRoles = rolesAvailable ? retainTeamRoleBindings(currentRunListItem?.sessions, snapshot.roles)
    : currentRunListItem?.sessions ?? state.rolesByTeamId[teamId]?.filter((role) => role.runId === runId) ?? [];
  const currentRun = state.runsById[runId];
  const incomingRun = snapshot.run && { ...snapshot.run,
    workspace: currentRun?.workspace.status === snapshot.run.workspace.status ? currentRun.workspace : snapshot.run.workspace };
  const run = currentRun && shallow(currentRun, incomingRun) ? currentRun : incomingRun;
  snapshot = {
    ...snapshot,
    run: run ?? null,
    roles: snapshotRoles,
    graph: normalizeTeamGraphProjection(snapshot.graph, runId),
    approvals: equalTeamDesignValue(state.approvalsByRunId[runId], snapshot.approvals) ? state.approvalsByRunId[runId] : snapshot.approvals,
    artifacts: equalTeamDesignValue(state.artifactsByRunId[runId], snapshot.artifacts) ? state.artifactsByRunId[runId] : snapshot.artifacts,
    events: eventsForRun,
  };
  const snapshotRunListItem = run ? { ...run, sessions: snapshotRoles } : null;
  const nextRunList = snapshotRunListItem && !shallow(currentRunListItem, snapshotRunListItem)
    ? currentRunListItem
      ? currentRunList.map((teamRun) => teamRun.runId === runId ? snapshotRunListItem : teamRun)
      : [...currentRunList, snapshotRunListItem]
    : currentRunList;
  const listRead = runListReads.get(teamId);
  const isActiveRun = state.teams.find((team) => team.id === teamId)?.activeRunId === runId;
  if (listRead?.reading) {
    if (snapshot.run) {
      listRead.acceptedRunIds.add(runId);
      if (rolesAvailable) listRead.acceptedListRoleRunIds.add(runId);
    }
    if (isActiveRun && rolesAvailable) listRead.acceptedActiveRoleRunIds.add(runId);
  }
  const runPatch = {
    runSnapshotsByRunId: { ...state.runSnapshotsByRunId, [runId]: { teamId, snapshot, loading: false, error: null } },
    runIdsByTeamId: state.runIdsByTeamId[teamId] === runIds ? state.runIdsByTeamId : { ...state.runIdsByTeamId, [teamId]: runIds },
    runListByTeamId: nextRunList === currentRunList ? state.runListByTeamId : { ...state.runListByTeamId, [teamId]: nextRunList },
    runsById: snapshot.run && run !== state.runsById[runId] ? { ...state.runsById, [runId]: run } : state.runsById,
    eventsByRunId: { ...state.eventsByRunId, [runId]: eventsForRun },
    eventCursorByRunId: { ...state.eventCursorByRunId, [runId]: snapshot.nextEventCursor },
    approvalsByRunId: { ...state.approvalsByRunId, [runId]: snapshot.approvals },
    artifactsByRunId: { ...state.artifactsByRunId, [runId]: snapshot.artifacts },
  };
  if (!isActiveRun) return runPatch;
  const activeRun = run ?? state.runsById[runId];
  const activeRoles = rolesAvailable ? snapshotRoles : state.rolesByTeamId[teamId];
  return {
    ...runPatch,
    runByTeamId: shallow(state.runByTeamId[teamId], activeRun) ? state.runByTeamId : { ...state.runByTeamId, [teamId]: activeRun },
    rolesByTeamId: activeRoles === state.rolesByTeamId[teamId] ? state.rolesByTeamId : { ...state.rolesByTeamId, [teamId]: activeRoles },
    stagesByTeamId: isSnapshotSectionAvailable(snapshot, 'stages') ? { ...state.stagesByTeamId, [teamId]: snapshot.stages } : state.stagesByTeamId,
    graphByTeamId: { ...state.graphByTeamId, [teamId]: snapshot.graph },
    workflowPlanByTeamId: isSnapshotSectionAvailable(snapshot, 'workflowPlan') ? { ...state.workflowPlanByTeamId, [teamId]: snapshot.workflowPlan } : state.workflowPlanByTeamId,
    dispatchGroupsByTeamId: isSnapshotSectionAvailable(snapshot, 'dispatchGroups') ? { ...state.dispatchGroupsByTeamId, [teamId]: snapshot.dispatchGroups } : state.dispatchGroupsByTeamId,
    dispatchTasksByTeamId: isSnapshotSectionAvailable(snapshot, 'dispatchTasks') ? { ...state.dispatchTasksByTeamId, [teamId]: snapshot.dispatchTasks } : state.dispatchTasksByTeamId,
    approvalsByTeamId: { ...state.approvalsByTeamId, [teamId]: snapshot.approvals },
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
      runSnapshotsByRunId: {},
      reworkContinuations: {},
      refreshDesignSnapshot: async (requestedTarget, options) => {
        const target = { ...requestedTarget };
        resolveTeamMeta(get().teams, target.teamId);
        const key = designTargetKey(target);
        const traceId = createSessionTraceId('team-design-snapshot');
        const existing = designReads.get(key);
        if (existing) {
          if (options?.invalidate) existing.dirty = true;
          logSessionTrace('renderer.team_run.design_snapshot.in_flight', traceId, () => ({
            teamHash: summarizeIdentifier(target.teamId).hash,
            runHash: summarizeIdentifier(target.runId).hash,
            invalidated: options?.invalidate === true,
            dirty: existing.dirty,
          }));
          return existing.promise;
        }
        const frozenTarget = { ...target, scope: resolveTeamRuntimeScope(target.teamId, target.runId) };
        const entry: TeamSnapshotRead = { dirty: false, removed: false, promise: Promise.resolve() };
        designReads.set(key, entry);
        entry.promise = Promise.resolve().then(async () => {
          if (entry.removed) return;
          set((state) => ({ designByRunId: { ...state.designByRunId, [target.runId]: {
            ...state.designByRunId[target.runId],
            snapshot: state.designByRunId[target.runId]?.snapshot ?? null, loading: true, mutationPending: state.designByRunId[target.runId]?.mutationPending ?? false, error: state.designByRunId[target.runId]?.error ?? null,
          } } }));
          try {
            do {
              entry.dirty = false;
              let snapshot: TeamDesignSnapshot;
              try {
                snapshot = await readTeamDesignSnapshot(frozenTarget);
              } catch (error) {
                if (entry.dirty && !entry.removed) {
                  logSessionTrace('renderer.team_run.design_snapshot.dirty_discarded', traceId, () => ({
                    teamHash: summarizeIdentifier(target.teamId).hash,
                    runHash: summarizeIdentifier(target.runId).hash,
                    result: 'error',
                    error: 'design_snapshot_failed',
                  }));
                  continue;
                }
                throw error;
              }
              if (entry.removed) return;
              if (entry.dirty) {
                logSessionTrace('renderer.team_run.design_snapshot.dirty_discarded', traceId, () => ({
                  ...summarizeTeamDesignSnapshot(snapshot), result: 'success',
                }));
                continue;
              }
              set((state) => {
                if (!state.teams.some((team) => team.id === target.teamId)) return {};
                const current = state.designByRunId[target.runId];
                const previous = current?.snapshot;
                snapshot = {
                  ...snapshot,
                  workspace: previous?.workspace.status === snapshot.workspace.status ? previous.workspace : snapshot.workspace,
                  graph: retainTeamDesignGraph(previous?.teamId === snapshot.teamId && previous.runId === snapshot.runId ? previous.graph : undefined, snapshot.graph),
                  roles: retainTeamRoleBindings(previous?.roles, snapshot.roles),
                };
                return {
                  designByRunId: { ...state.designByRunId, [target.runId]: { ...current,
                    snapshot, loading: false, mutationPending: current?.mutationPending ?? false, error: teamRunErrorMessage(snapshot) } },
                };
              });
              if (traceId && get().designByRunId[target.runId]?.snapshot?.graph === snapshot.graph) {
                logSessionTrace('renderer.team_run.design_snapshot.applied', traceId, () => ({
                  ...summarizeTeamDesignSnapshot(snapshot),
                  mutationPending: get().designByRunId[target.runId]?.mutationPending ?? false,
                }));
              }
            } while (entry.dirty && !entry.removed);
          } catch (error) {
            if (!entry.removed) set((state) => {
              const current = state.designByRunId[target.runId];
              return current ? { designByRunId: { ...state.designByRunId, [target.runId]: {
                ...current, loading: false, error: error instanceof Error ? error.message : String(error),
              } } } : {};
            });
            logSessionTrace('renderer.team_run.design_snapshot.error', traceId, () => {
              const retained = get().designByRunId[target.runId]?.snapshot;
              return {
                teamHash: summarizeIdentifier(target.teamId).hash,
                runHash: summarizeIdentifier(target.runId).hash,
                error: 'design_snapshot_failed',
                removed: entry.removed,
                retainedSnapshot: Boolean(retained),
                versionHash: summarizeIdentifier(retained?.graphVersion).hash,
                epochHash: summarizeIdentifier(retained?.designEpoch).hash,
                startGate: retained?.startGate.status ?? null,
              };
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
      startDesign: async (requestedTarget) => {
        const target = { ...requestedTarget };
        await mutateTeamDesign(target, 'design-start', 'reconciled', (requestId) => startTeamDesign({
          ...target, scope: resolveTeamRuntimeScope(target.teamId, target.runId), idempotencyKey: requestId,
        }));
      },
      startRun: async (target) => {
        const requestedTarget = { ...target };
        await mutateTeamDesign(requestedTarget, 'run-start', 'reconciled', async (requestId) => {
          const frozenTarget = { ...requestedTarget, scope: resolveTeamRuntimeScope(requestedTarget.teamId, requestedTarget.runId) };
          const snapshot = get().designByRunId[frozenTarget.runId]?.snapshot;
          if (snapshot?.teamId !== frozenTarget.teamId || snapshot.runId !== frozenTarget.runId
            || !(snapshot.startGate.status === 'intake' && snapshot.designEpoch === null
              || snapshot.startGate.status === 'designing' && snapshot.startGate.designEpoch === snapshot.designEpoch
                && snapshot.startGate.graphVersion === snapshot.graphVersion)) {
            throw new Error('Team run start snapshot is required');
          }
          const designEpoch = snapshot.designEpoch;
          const expectedGraphVersion = snapshot.graphVersion;
          const traceId = createSessionTraceId('team-run-start');
          logSessionTrace('renderer.team_run.run_start.requested', traceId, () => summarizeTeamDesignSnapshot(snapshot));
          try {
            const result = await startTeamRun({
              ...frozenTarget, designEpoch, expectedGraphVersion, idempotencyKey: requestId,
            });
            logSessionTrace('renderer.team_run.run_start.returned', traceId, () => ({
              teamHash: summarizeIdentifier(frozenTarget.teamId).hash,
              runHash: summarizeIdentifier(frozenTarget.runId).hash,
              versionHash: summarizeIdentifier(expectedGraphVersion).hash,
              epochHash: summarizeIdentifier(designEpoch).hash,
              outcome: result.outcome,
              readbackPending: true,
            }));
            return result;
          } catch (error) {
            logSessionTrace('renderer.team_run.run_start.error', traceId, () => ({
              teamHash: summarizeIdentifier(frozenTarget.teamId).hash,
              runHash: summarizeIdentifier(frozenTarget.runId).hash,
              error: 'run_start_failed',
              readbackPending: true,
            }));
            throw error;
          }
        });
      },
      continueRework: async (input) => {
        const request = { ...input };
        const target = { teamId: request.teamId, runId: request.runId };
        const key = reworkContinuationKey(request);
        let continuation: TeamReworkContinuation | undefined;
        try {
          await mutateTeamDesign(target, `run-rework-continue:${request.idempotencyKey}`, 'reconciled', async () => {
            const snapshot = get().designByRunId[target.runId]?.snapshot;
            const chat = useChatStore.getState();
            const conversation = chat.currentConversation;
            const meta = conversation?.kind === 'session' ? chat.loadedSessions[conversation.sessionRecordKey]?.meta : null;
            const ownership = meta?.ownership;
            if (snapshot?.teamId !== target.teamId || snapshot.runId !== target.runId || snapshot.startGate.status !== 'started'
              || conversation?.kind !== 'session' || !meta?.sessionIdentity || !sessionIdentitiesEqual(meta.sessionIdentity, conversation.sessionIdentity)
              || ownership?.kind !== 'team' || ownership.roleId !== 'leader' || ownership.teamId !== target.teamId || ownership.teamRunId !== target.runId
              || !snapshot.roles.some((role) => role.roleId === 'leader' && role.runId === target.runId
                && sessionIdentitiesEqual(role.sessionIdentity, conversation.sessionIdentity))) {
              throw new Error('The current team run leader session is required');
            }
            if (Object.keys(request).length !== 10 || ![request.teamId, request.runId, request.nodeId, request.sourcePort,
              request.sourceNodeExecutionId, request.commandId, request.idempotencyKey].every((value) => readNonEmptyString(value) !== null)
              || !Number.isSafeInteger(request.batchId) || request.batchId <= 0 || !isTeamReworkLimit(request.maxReworks)
              || !isTeamGraphVersion(request.expectedGraphVersion)) throw new Error('A valid rework continuation request is required');
            const scope = resolveTeamRuntimeScope(target.teamId, target.runId);
            if (scope.kind !== 'agent' || scope.agentId !== conversation.sessionIdentity.agentId
              || !runtimeEndpointsEqual(scope.endpoint, conversation.sessionIdentity.endpoint)) throw new Error('The current team run leader scope is required');
            const existing = get().reworkContinuations[key];
            if (existing) {
              if (!equalTeamDesignValue(existing.input, request) || !sessionIdentitiesEqual(existing.leaderIdentity, conversation.sessionIdentity)
                || !equalTeamDesignValue(existing.scope, scope)) throw new Error('The original rework continuation request and leader are required');
              continuation = existing;
            } else {
              const blocked = snapshot.graph.rework.blocked.find((entry) => entry.batchId === request.batchId
                && entry.sourceNodeId === request.nodeId && entry.sourcePort === request.sourcePort
                && entry.sourceNodeExecutionId === request.sourceNodeExecutionId);
              if (!blocked || request.maxReworks <= blocked.maxReworks || request.maxReworks <= blocked.used) {
                throw new Error('A matching blocked rework and a higher rework limit are required');
              }
              continuation = { input: request, leaderIdentity: conversation.sessionIdentity, scope, status: 'unconfirmed', error: null };
              set((state) => ({ reworkContinuations: { ...state.reworkContinuations, [key]: continuation } }));
            }
            if (continuation.status === 'acknowledged') return;
            await continueTeamRunRework({ ...continuation.input, scope: continuation.scope });
            continuation = { ...continuation, status: 'acknowledged', error: null };
            if (get().reworkContinuations[key]) set((state) => ({ reworkContinuations: { ...state.reworkContinuations, [key]: continuation } }));
          });
          if (continuation && get().reworkContinuations[key] === continuation) set((state) => ({ reworkContinuations: withoutKey(state.reworkContinuations, key) }));
        } catch (cause) {
          if (continuation && get().reworkContinuations[key] === continuation) {
            if (continuation.status === 'unconfirmed' && cause instanceof Error && isTeamDesignFailure(cause.cause)
              && REWORK_CONTINUE_REJECTIONS.has(cause.cause.errorCode)) {
              set((state) => ({ reworkContinuations: withoutKey(state.reworkContinuations, key) }));
            } else {
              continuation = { ...continuation, status: continuation.status === 'acknowledged' ? 'acknowledged' : 'outcome-unknown',
                error: cause instanceof Error ? cause.message : String(cause) };
              set((state) => ({ reworkContinuations: { ...state.reworkContinuations, [key]: continuation } }));
            }
          }
          throw cause;
        }
      },
      exitDesign: async (requestedTarget) => {
        const target = { ...requestedTarget };
        await mutateTeamDesign(target, 'design-exit', 'reconciled', () => {
          const snapshot = get().designByRunId[target.runId]?.snapshot;
          if (snapshot?.teamId !== target.teamId || snapshot.runId !== target.runId
            || snapshot.startGate.status !== 'designing'
            || !snapshot.designEpoch || snapshot.startGate.designEpoch !== snapshot.designEpoch) {
            throw new Error('Team design snapshot is required');
          }
          return exitTeamDesign({ ...target, scope: resolveTeamRuntimeScope(target.teamId, target.runId), designEpoch: snapshot.designEpoch });
        });
      },
      submitRunGraphPatch: (requestedTarget, operations, base) => {
        if (operations.some((operation) => operation.op === 'set_node_position' && !isTeamDesignPatchOperation(operation))) {
          return Promise.reject(new Error(i18n.t('common:calls.values.invalidRequest')));
        }
        if (operations.length === 0) return Promise.resolve();
        const target = { ...requestedTarget };
        if (operations.every((operation) => operation.op === 'set_node_position')) {
          try {
            return submitRunLayout(target, operations);
          } catch (error) {
            return Promise.reject(error);
          }
        }
        return mutateTeamDesign(target, 'run-graph-patch', 'acknowledged', (requestId) => prepareRunGraphPatch(target, operations, requestId, base)());
      },
      retryRunLayoutSave: (target) => {
        try {
          resolveTeamMeta(get().teams, target.teamId);
          const key = designTargetKey(target);
          if (deletingTeams.has(target.teamId) || actionInFlightByKey.has(`design:${key}`)) throw new Error('Team run mutation is already pending');
          const entry = layoutWrites.get(key);
          return entry ? drainRunLayout(entry) : Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      },
      createRoleSession: (requestedTarget, roleId, requestId) => {
        const target = { ...requestedTarget };
        const snapshot = get().designByRunId[target.runId]?.snapshot;
        if (snapshot?.teamId !== target.teamId || snapshot.runId !== target.runId) {
          return Promise.reject(new Error('Team run snapshot is required'));
        }
        const key = JSON.stringify([target.teamId, target.runId, requestId]);
        const existing = roleSessionCreations.get(key);
        if (existing && existing.roleId !== roleId) return Promise.reject(new Error('Team role session request conflicts with the original role'));
        if (existing?.promise) return existing.promise;
        const actionKey = `design:${designTargetKey(target)}`;
        if (deletingTeams.has(target.teamId) || actionInFlightByKey.has(actionKey)) return Promise.reject(new Error('Team run mutation is already pending'));
        const creation: RoleSessionCreation = existing ?? { roleId, removed: false };
        const action = { requestId, operation: `role-session-create:${requestId}`, removed: false, promise: Promise.resolve() };
        const requireCurrentRun = () => {
          const current = get().designByRunId[target.runId]?.snapshot;
          if (creation.removed || current?.teamId !== target.teamId || current.runId !== target.runId
            || !get().teams.some((team) => team.id === target.teamId)) {
            throw new Error('Team run is no longer available');
          }
        };
        creation.promise = Promise.resolve().then(async () => {
          try {
            await waitForRunLayout(target);
            requireCurrentRun();
            const frozenTarget = { ...target, scope: resolveTeamRuntimeScope(target.teamId, target.runId) };
            if (!creation.sessionRef) {
              creation.receipt ??= await createTeamRoleSession({ ...frozenTarget, roleId, idempotencyKey: requestId });
              requireCurrentRun();
              const call = await waitForCall(creation.receipt, 'organization', { timeoutMs: null });
              requireCurrentRun();
              if (call.command !== 'team.roleSessionCreate'
                || !await matchesOrganizationIdentity(call.detail.teamId, call.detail.teamIdHash, target.teamId)
                || !await matchesOrganizationIdentity(call.detail.runId, call.detail.runIdHash, target.runId)) {
                throw new Error('Team role session result does not match the requested run');
              }
              if (call.status !== 'succeeded') {
                creation.receipt = undefined;
                throw new Error(call.status === 'unknown' ? 'Team role session creation outcome is unknown' : 'Team role session creation was not confirmed');
              }
              if (call.detail.outcome !== 'created' || call.detail.roleSession?.roleId !== roleId) {
                throw new Error('Team role session creation was not confirmed');
              }
              creation.sessionRef = call.detail.roleSession.sessionRef;
            }
            requireCurrentRun();
            const readback = await readTeamDesignSnapshot(frozenTarget);
            requireCurrentRun();
            const binding = readback.roles.find((role) => role.roleId === roleId && role.sessionRef === creation.sessionRef);
            if (!binding) throw new Error('Created Team role session is not available in the run snapshot');
            const designRead = designReads.get(designTargetKey(target));
            if (designRead) designRead.dirty = true;
            const runRead = snapshotReads.get(designTargetKey(target));
            if (runRead) runRead.dirty = true;
            set((state) => {
              const current = state.designByRunId[target.runId]!;
              const roles = [...new Map([...current.snapshot!.roles, ...readback.roles]
                .map((role) => [JSON.stringify([role.roleId, role.sessionRef]), role])).values()];
              return {
                designByRunId: { ...state.designByRunId, [target.runId]: {
                  ...current, snapshot: { ...current.snapshot!, roles },
                } },
                runListByTeamId: { ...state.runListByTeamId, [target.teamId]: (state.runListByTeamId[target.teamId] ?? [])
                  .map((run) => run.runId === target.runId ? { ...run, sessions: roles } : run) },
                ...(state.teams.find((team) => team.id === target.teamId)?.activeRunId === target.runId
                  ? { rolesByTeamId: { ...state.rolesByTeamId, [target.teamId]: roles } } : {}),
              };
            });
            roleSessionCreations.delete(key);
            return binding;
          } finally {
            creation.promise = undefined;
            if (!creation.receipt && !creation.sessionRef) roleSessionCreations.delete(key);
            if (actionInFlightByKey.get(actionKey) === action) {
              actionInFlightByKey.delete(actionKey);
              if (!creation.removed) set((state) => {
                const current = state.designByRunId[target.runId];
                return current?.snapshot?.teamId === target.teamId ? { designByRunId: { ...state.designByRunId, [target.runId]: {
                  ...current, mutationPending: deletingTeams.has(target.teamId),
                } } } : {};
              });
            }
          }
        });
        action.promise = creation.promise.then(() => {}, () => {});
        roleSessionCreations.set(key, creation);
        actionInFlightByKey.set(actionKey, action);
        set((state) => ({ designByRunId: { ...state.designByRunId, [target.runId]: {
          ...state.designByRunId[target.runId]!, mutationPending: true,
        } } }));
        return creation.promise;
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
      approvalsByRunId: {},
      artifactsByRunId: {},
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
      planTeamSkillCreation: (candidate) => planTeamSkillCreation(get(), candidate),
      createTeam: (input) => {
        const plan = planTeamSkillCreation(get(), input);
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
        let runPhase: 'initializing_sessions' | 'loading_team' | null = null;
        let callbackFailure: TeamCreationFailure | null = null;
        const memberCount = candidate.manualTeam.members.filter((member) => !member.isLeader).length;
        const onFailure = (failure: TeamCreationFailure) => {
          if (failure.memberIndex !== undefined && failure.memberIndex >= memberCount) throw new Error('Manual team failure does not match the selected members');
          callbackFailure ??= { ...failure };
        };
        set({ manualTeamCreation: { status: 'running', cleanup: 'none', teamId, candidate, startedAt, endedAt: null, phase: 'submitting', preparationObserved: false, progress: null, failure: null } });
        const updatePhase = (phase: 'initializing_sessions' | 'loading_team') => {
          runPhase = phase;
          set((state) => {
            const current = state.manualTeamCreation;
            return current?.candidate === candidate && current.status === 'running'
              ? { manualTeamCreation: { ...current, phase } } : {};
          });
        };
        try {
          teamId = get().createManualTeam(candidate);
          set((state) => ({ manualTeamCreation: { ...state.manualTeamCreation!, teamId } }));
          await get().provisionTeamAgents(teamId, { errorFeedback: 'caller', onFailure, onUpdate: (call) => {
            const current = get().manualTeamCreation;
            if (current?.candidate !== candidate || current.status !== 'running') return;
            if (callId !== null && call.callId !== callId) throw new Error('Manual team progress does not match the provision call');
            if (call.revision <= revision) return;
            const progress = call.detail.provision?.progress;
            if (progress && progress.members.length !== memberCount) throw new Error('Manual team progress does not match the selected members');
            const failure = call.detail.creationFailure;
            if (failure?.memberIndex !== undefined && failure.memberIndex >= memberCount) throw new Error('Manual team failure does not match the selected members');
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
                  failure: current.failure ?? (failure ? { ...failure } : null),
                } } : {};
            });
          } });
          const run = await get().createRun(teamId, { errorFeedback: 'caller', onFailure, onPhase: updatePhase });
          set({ manualTeamCreation: null });
          return { teamId, runId: run.runId };
        } catch (error) {
          const observed = get().manualTeamCreation!;
          const failure: TeamCreationFailure | null = observed.failure ?? callbackFailure
            ?? (teamId === null ? { stage: 'submitting', reason: 'invalid_input' }
              : error instanceof ConfirmedTeamProvisionFailure ? null
                : classifyTeamCreationFailure(error, runPhase ?? 'submitting'));
          const current = { ...observed, failure };
          if (teamId === null) {
            set({ manualTeamCreation: { ...current, status: 'failed', cleanup: 'confirmed', endedAt: Date.now() } });
          } else if (error instanceof ConfirmedTeamProvisionFailure) {
            set({ manualTeamCreation: { ...current, status: 'cleaning_up', cleanup: 'none', endedAt: null } });
            try {
              const result = await get().deleteTeam(teamId, { errorFeedback: 'caller' });
              if (result.state !== 'tombstoned' || result.teamId !== teamId) throw new Error('Manual team cleanup was not confirmed', { cause: error });
              set({ manualTeamCreation: { ...current, status: 'failed', cleanup: 'confirmed', endedAt: Date.now() } });
            } catch {
              set({ manualTeamCreation: { ...current, status: 'unconfirmed', cleanup: 'unknown', endedAt: Date.now() } });
            }
          } else {
            set({ manualTeamCreation: { ...current, status: 'unconfirmed', cleanup: 'none', endedAt: Date.now() } });
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
        const candidateScope = runtimeInstanceScope(input.candidate.runtimeScope.endpoint);
        if (!runtimeEndpointsEqual(resolveTeamRuntimeScope(current.id).endpoint, candidateScope.endpoint)) {
          throw new Error('TeamSkill replacement must keep the same runtime endpoint');
        }
        if (current.teamSkillVersion !== input.expectedCurrentVersion) {
          throw new Error(`TeamSkill version changed from ${input.expectedCurrentVersion} to ${current.teamSkillVersion}.`);
        }
        if (current.teamSkillName !== input.candidate.teamSkillPackage.name) {
          throw new Error(`TeamSkill replacement must keep the same name: ${current.teamSkillName}`);
        }
        const duplicate = get().teams.find((team) => (
          team.id !== input.teamId
          && runtimeEndpointsEqual(resolveTeamRuntimeScope(team.id).endpoint, candidateScope.endpoint)
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
                runtimeScope: candidateScope,
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
      deleteTeam: async (teamId, options) => {
        const state = get();
        const team = state.teams.find((row) => row.id === teamId);
        if (!team) {
          const error = new Error(`Team not found: ${teamId}`);
          reportTeamError(teamId, error, options);
          throw error;
        }

        const storedRunIds = state.runIdsByTeamId[teamId] ?? [];
        const runIds = storedRunIds.length > 0 ? storedRunIds : team.activeRunId ? [team.activeRunId] : [];
        if (deletingTeams.has(teamId)) throw new Error('Team deletion is already pending');
        deletingTeams.add(teamId);
        set((state) => ({
          designByRunId: Object.fromEntries(Object.entries(state.designByRunId).map(([runId, record]) => [runId,
            record?.snapshot?.teamId === teamId ? { ...record, mutationPending: true } : record])),
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          ...(options?.errorFeedback === 'caller' ? {} : { errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined } }),
        }));
        try {
          const pending = [
            ...[...actionInFlightByKey].filter(([key]) => key.startsWith('design:')
              && (JSON.parse(key.slice('design:'.length)) as [string, string])[0] === teamId).map(([, action]) => action.promise),
            ...[...layoutWrites.values()].filter((entry) => entry.target.teamId === teamId).flatMap((entry) => entry.promise ? [entry.promise] : []),
          ];
          if (pending.length > 0) await Promise.allSettled(pending);
          const receipt = await deleteTeamInstance({ teamId, scope: resolveTeamRuntimeScope(teamId) });
          const call = await waitForCall(receipt, 'organization', { timeoutMs: null });
          if (call.command !== 'team.delete'
            || !await matchesOrganizationIdentity(call.detail.teamId, call.detail.teamIdHash, teamId)
            || call.status !== 'succeeded' || call.detail.outcome !== 'tombstoned') {
            throw new Error(call.status === 'unknown'
              ? 'Team deletion outcome is unknown'
              : 'Team deletion was not confirmed');
          }
          const runIdsToDelete = mergeRunIds(runIds, get().runIdsByTeamId[teamId] ?? []);
          removeRunReads(teamId);
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
            approvalsByRunId: removeRunIdsFromRecord(state.approvalsByRunId, runIdsToDelete),
            artifactsByRunId: removeRunIdsFromRecord(state.artifactsByRunId, runIdsToDelete),
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
          }));
          reportTeamError(teamId, error, options);
          throw error;
        } finally {
          deletingTeams.delete(teamId);
          set((state) => ({ designByRunId: Object.fromEntries(Object.entries(state.designByRunId).map(([runId, record]) => [runId,
            record?.snapshot?.teamId === teamId ? { ...record, mutationPending: actionInFlightByKey.has(`design:${designTargetKey({ teamId, runId })}`) } : record])),
          }));
        }
      },
      provisionTeamAgents: async (teamId, options) => {
        const team = resolveTeamMeta(get().teams, teamId);
        let traceId = createSessionTraceId('team-provision');
        const started = traceId ? performance.now() : 0;
        let admitted = false;
        let failure: TeamCreationFailure | null = null;
        logSessionTrace('renderer.team.provision.start', traceId, () => ({
          teamHash: summarizeIdentifier(team.id).hash,
          sourceType: team.sourceType,
          memberCount: team.manualTeam?.members.length ?? null,
        }));
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          ...(options?.errorFeedback === 'caller' ? {} : { errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined } }),
        }));
        try {
          const receipt = await provisionTeamAgents({
            scope: resolveTeamRuntimeScope(teamId),
            teamId: team.id,
            packagePath: team.packagePath,
            idempotencyKey: idempotencyKey(team.id, provisionActionKey(team)),
            ...(team.sourceType ? { sourceType: team.sourceType } : {}),
            ...(team.manualTeam ? { manualTeam: team.manualTeam } : {}),
          });
          admitted = true;
          const callTraceId = traceId ? `session-trace:team-call:${receipt.callId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}` : null;
          logSessionTrace('renderer.team.provision.admitted', traceId, () => ({
            callId: receipt.callId,
            callTraceId,
            elapsedMs: performance.now() - started,
          }));
          traceId = callTraceId;
          const call = await waitForCall(receipt, 'organization', options?.onUpdate ? { timeoutMs: null, onUpdate: async (call) => {
            if (call.command !== 'team.provisionAgents'
              || !await matchesOrganizationIdentity(call.detail.teamId, call.detail.teamIdHash, team.id)) {
              throw new Error('Team provision progress does not match the requested team');
            }
            await options.onUpdate!(call);
          } } : { timeoutMs: null });
          const identityMatches = call.command === 'team.provisionAgents'
            && await matchesOrganizationIdentity(call.detail.teamId, call.detail.teamIdHash, team.id);
          logSessionTrace('renderer.team.provision.terminal', traceId, () => ({
            callId: receipt.callId,
            commandMatches: call.command === 'team.provisionAgents',
            identityMatches,
            status: call.status,
            outcome: call.detail.outcome,
            nativeInstalled: call.detail.provision?.nativeInstalled ?? null,
            commit: call.detail.provision?.commit ?? null,
            elapsedMs: performance.now() - started,
          }));
          if (identityMatches && call.detail.creationFailure) failure = { ...call.detail.creationFailure };
          if (call.command !== 'team.provisionAgents'
            || !identityMatches
            || call.status !== 'succeeded' || call.detail.outcome !== 'materialized'
            || call.detail.provision?.nativeInstalled !== true || call.detail.provision.commit !== 'committed') {
            const message = call.status === 'unknown'
              ? 'Team provision outcome is unknown'
              : 'Team provision was not confirmed';
            if (identityMatches && isConfirmedProvisionFailure(call)) throw new ConfirmedTeamProvisionFailure(message);
            if (identityMatches && (call.status === 'unknown' || call.detail.outcome === 'outcome_unknown' || call.detail.provision?.commit === 'outcome_unknown')) {
              failure ??= { stage: 'submitting', reason: 'outcome_unknown' };
            }
            throw new Error(message);
          }
        } catch (error) {
          logSessionTrace('renderer.team.provision.error', traceId, () => ({
            error: summarizeError(error),
            elapsedMs: performance.now() - started,
          }));
          if (!(error instanceof ConfirmedTeamProvisionFailure)) {
            failure ??= classifyTeamCreationFailure(error, 'submitting', admitted ? 'observation_interrupted' : 'unavailable');
          }
          reportTeamError(teamId, error, options);
          if (failure) options?.onFailure?.(failure);
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
        let phase: 'initializing_sessions' | 'loading_team' = 'initializing_sessions';
        let failure: TeamCreationFailure | null = null;
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          ...(options?.errorFeedback === 'caller' ? {} : { errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined } }),
        }));
        try {
          options?.onPhase?.(phase);
          const payload = {
            scope: resolveTeamRuntimeScope(teamId),
            teamId: team.id,
            packagePath: team.packagePath,
            runId,
            idempotencyKey: idempotencyKey(team.id, `create:${runId}`),
            ...(team.sourceType ? { sourceType: team.sourceType } : {}),
          };
          const created = options?.onFailure
            ? await createTeamRun(payload, { onFailure: (observed) => { failure ??= { ...observed }; } })
            : await createTeamRun(payload);
          set((state) => ({
            teams: state.teams.map((team) => team.id === teamId ? { ...team, activeRunId: created.runId, updatedAt: Date.now() } : team),
            runIdsByTeamId: { ...state.runIdsByTeamId, [teamId]: appendRunId(state.runIdsByTeamId[teamId], created.runId) },
          }));
          phase = 'loading_team';
          options?.onPhase?.(phase);
          await get().syncRunList(teamId);
          await get().refreshSnapshot(teamId, { force: true, runId: created.runId, errorFeedback: 'caller' });
          return get().runsById[created.runId] ?? created;
        } catch (error) {
          failure ??= classifyTeamCreationFailure(error, phase);
          reportTeamError(teamId, error, options);
          options?.onFailure?.(failure);
          throw error;
        } finally {
          set((state) => ({
            loadingByTeamId: { ...state.loadingByTeamId, [teamId]: false },
          }));
        }
      },
      syncRunList: async (teamId) => {
        resolveTeamMeta(get().teams, teamId);
        const previous = runListReads.get(teamId);
        if (previous?.next) return previous.next.promise;
        const entry: TeamRunListRead = { promise: Promise.resolve(), deletedRunIds: new Set(), acceptedRunIds: new Set(), acceptedListRoleRunIds: new Set(), acceptedActiveRoleRunIds: new Set(), reading: false };
        if (previous) previous.next = entry;
        else runListReads.set(teamId, entry);
        // Coalesce only the next requested list; snapshots and other teams stay independent.
        entry.promise = (previous ? previous.promise.catch(() => {}) : Promise.resolve()).then(async () => {
          const baseline = get();
          const team = baseline.teams.find((team) => team.id === teamId);
          if (!team) return;
          entry.reading = true;
          const result = await listTeamRuns({ teamId, scope: resolveTeamRuntimeScope(teamId) });
          set((state) => {
            const currentTeam = state.teams.find((team) => team.id === teamId);
            if (!currentTeam) return state;
            const baselineRunIds = new Set(baseline.runIdsByTeamId[teamId] ?? []);
            const currentRunIds = state.runIdsByTeamId[teamId] ?? [];
            const currentRunIdSet = new Set(currentRunIds);
            const baselineRuns = new Map((baseline.runListByTeamId[teamId] ?? []).map((run) => [run.runId, run]));
            const currentRuns = new Map((state.runListByTeamId[teamId] ?? []).map((run) => [run.runId, run]));
            const selectionChanged = currentTeam !== team;
            const activeRunId = currentTeam.activeRunId;
            const currentProjectedRunId = state.runByTeamId[teamId]?.runId;
            const runtimeRuns = result.runs.filter((run) => !entry.deletedRunIds.has(run.runId) && (!baselineRunIds.has(run.runId) || currentRunIdSet.has(run.runId)));
            const runtimeRunIds = new Set(runtimeRuns.map((run) => run.runId));
            const retainedRunIds = currentRunIds.filter((runId) => !runtimeRunIds.has(runId) && (
              !baselineRunIds.has(runId)
              || state.runsById[runId] !== baseline.runsById[runId]
              || currentRuns.get(runId) !== baselineRuns.get(runId)
              || entry.acceptedRunIds.has(runId)
              || (selectionChanged && activeRunId === runId)
            ));
            const nextRunIds = [...runtimeRunIds, ...retainedRunIds];
            const nextRunIdSet = new Set(nextRunIds);
            const runsById = { ...removeRunIdsFromRecord(state.runsById, currentRunIds.filter((runId) => !nextRunIdSet.has(runId))) };
            const nextRunList = runtimeRuns.map((run) => {
              const currentRun = state.runsById[run.runId];
              const record = currentRun && (currentRun !== baseline.runsById[run.runId] || entry.acceptedRunIds.has(run.runId)) ? currentRun : run;
              const current = currentRuns.get(run.runId);
              const sessions = current && (current.sessions !== baselineRuns.get(run.runId)?.sessions || entry.acceptedListRoleRunIds.has(run.runId)) ? current.sessions : run.sessions;
              runsById[run.runId] = record;
              return record === run && sessions === run.sessions ? run : { ...record, sessions };
            });
            for (const runId of retainedRunIds) {
              const current = currentRuns.get(runId);
              if (current) nextRunList.push(current);
            }
            const nextActiveRunId = selectionChanged ? activeRunId
              : activeRunId && nextRunIdSet.has(activeRunId) ? activeRunId : selectMostRecentRunId(nextRunIds, runsById);
            const nextActiveRun = nextActiveRunId ? runsById[nextActiveRunId] : undefined;
            const nextActiveSessions = nextRunList.find((run) => run.runId === nextActiveRunId)?.sessions ?? [];
            const shouldClearTeamRunProjection = activeRunId !== nextActiveRunId || (currentProjectedRunId !== undefined && currentProjectedRunId !== nextActiveRunId);
            const shouldUpdateActiveRunId = activeRunId !== nextActiveRunId;
            const shouldUpdateRunIds = !equalStringArray(currentRunIds, nextRunIds);
            return {
              teams: shouldUpdateActiveRunId
                ? state.teams.map((team) => team.id === teamId ? { ...team, activeRunId: nextActiveRunId, updatedAt: Date.now() } : team)
                : state.teams,
              runIdsByTeamId: shouldUpdateRunIds ? { ...state.runIdsByTeamId, [teamId]: nextRunIds } : state.runIdsByTeamId,
              runListByTeamId: { ...state.runListByTeamId, [teamId]: nextRunList },
              runsById,
              ...(shouldClearTeamRunProjection ? emptyTeamRunProjection(teamId, state) : {}),
              ...(shouldClearTeamRunProjection || state.runByTeamId[teamId] === baseline.runByTeamId[teamId]
                && !(nextActiveRunId && entry.acceptedRunIds.has(nextActiveRunId)) ? {
                runByTeamId: { ...state.runByTeamId, [teamId]: nextActiveRun },
              } : {}),
              ...(shouldClearTeamRunProjection || state.rolesByTeamId[teamId] === baseline.rolesByTeamId[teamId]
                && !(nextActiveRunId && entry.acceptedActiveRoleRunIds.has(nextActiveRunId)) ? {
                rolesByTeamId: { ...state.rolesByTeamId, [teamId]: nextActiveSessions },
              } : {}),
            };
          });
        }).finally(() => {
          entry.reading = false;
          if (runListReads.get(teamId) === entry) {
            if (entry.next) runListReads.set(teamId, entry.next);
            else runListReads.delete(teamId);
          }
        });
        return entry.promise;
      },
      deleteRun: async (teamId, requestedRunId) => {
        const state = get();
        const runId = requestedRunId ?? resolveActiveRunId(state, teamId);
        await mutateTeamDesign({ teamId, runId }, 'run-delete', 'reconciled', async () => {
        set((state) => ({
          loadingByTeamId: { ...state.loadingByTeamId, [teamId]: true },
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          const receipt = await deleteTeamRun({ runId, scope: resolveTeamRuntimeScope(teamId, runId) });
          const call = await waitForCall(receipt, 'organization', { timeoutMs: null });
          if (call.command !== 'team.runDelete'
            || !await matchesOrganizationIdentity(call.detail.runId, call.detail.runIdHash, runId)
            || call.status !== 'succeeded' || call.detail.outcome !== 'purged') {
            throw new Error(call.status === 'unknown'
              ? 'Team run deletion outcome is unknown'
              : 'Team run deletion was not confirmed');
          }
          runListReads.get(teamId)?.deletedRunIds.add(runId);
          removeRunReads(teamId, runId);
          removeTeamRunRoleSessions(collectTeamRunRoleSessionBindings(get(), teamId, [runId]));
          set((state) => {
            const remainingRunIds = (state.runIdsByTeamId[teamId] ?? []).filter((candidate) => candidate !== runId);
            const activeRunId = state.teams.find((team) => team.id === teamId)?.activeRunId;
            const deletingActiveRun = activeRunId === runId;
            const nextRunId = deletingActiveRun ? selectMostRecentRunId(remainingRunIds, state.runsById) : activeRunId;
            return {
              teams: deletingActiveRun
                ? state.teams.map((team) => team.id === teamId ? { ...team, activeRunId: nextRunId, updatedAt: Date.now() } : team)
                : state.teams,
              runIdsByTeamId: { ...state.runIdsByTeamId, [teamId]: remainingRunIds },
              runListByTeamId: { ...state.runListByTeamId, [teamId]: (state.runListByTeamId[teamId] ?? []).filter((run) => run.runId !== runId) },
              runsById: withoutKey(state.runsById, runId),
              designByRunId: withoutKey(state.designByRunId, runId),
              approvalsByRunId: withoutKey(state.approvalsByRunId, runId),
              artifactsByRunId: withoutKey(state.artifactsByRunId, runId),
              eventsByRunId: withoutKey(state.eventsByRunId, runId),
              eventCursorByRunId: withoutKey(state.eventCursorByRunId, runId),
              ...(deletingActiveRun ? {
                ...emptyTeamRunProjection(teamId, state),
                runByTeamId: { ...state.runByTeamId, [teamId]: nextRunId ? state.runsById[nextRunId] : undefined },
                eventsByTeamId: { ...state.eventsByTeamId, [teamId]: nextRunId ? state.eventsByRunId[nextRunId] ?? [] : [] },
                eventCursorByTeamId: { ...state.eventCursorByTeamId, [teamId]: nextRunId ? state.eventCursorByRunId[nextRunId] : undefined },
              } : {}),
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
        });
      },
      refreshSnapshot: async (teamId, options) => {
        const team = get().teams.find((team) => team.id === teamId);
        if (!team) return;
        const runId = options?.runId ?? team.activeRunId;
        if (!runId) {
          set((state) => emptyTeamRunProjection(teamId, state));
          return;
        }
        const key = designTargetKey({ teamId, runId });
        const inFlight = snapshotReads.get(key);
        const entry = inFlight ?? { dirty: false, removed: false, completeMessages: Boolean(options?.completeMessages), promise: Promise.resolve() };
        if (inFlight) {
          if (options?.force) entry.dirty = true;
          if (options?.completeMessages) entry.completeMessages = true;
        } else {
          snapshotReads.set(key, entry);
          entry.promise = Promise.resolve().then(async () => {
            if (entry.removed) return;
            const accepted = get().runSnapshotsByRunId[runId];
            let snapshot: TeamRunSnapshotRecord | null = options?.completeMessages && !options.force && accepted?.teamId === teamId ? accepted.snapshot : null;
            let restartedStale = false;
            let retainMessages = true;
            set((state) => ({ runSnapshotsByRunId: { ...state.runSnapshotsByRunId, [runId]: {
              teamId, snapshot: accepted?.teamId === teamId ? accepted.snapshot : null, loading: true, error: accepted?.teamId === teamId ? accepted.error : null,
            } } }));
            try {
              const scope = resolveTeamRuntimeScope(teamId, runId);
              for (;;) {
                if (entry.removed || !get().teams.some((team) => team.id === teamId)) return;
                if (entry.dirty) {
                  entry.dirty = false;
                  snapshot = null;
                }
                const cursor = entry.completeMessages && snapshot?.messagePage.status === 'incomplete' ? snapshot.messagePage.nextCursor : null;
                if (!snapshot || cursor) {
                  let page: TeamRunSnapshotRecord;
                  try {
                    page = await readTeamRunSnapshot({
                      scope, runId, eventCursor: get().eventCursorByRunId[runId], eventLimit: 200,
                      ...(cursor ? { messageCursor: cursor } : {}),
                    });
                  } catch (error) {
                    if (entry.removed) return;
                    if (entry.dirty) continue;
                    throw error;
                  }
                  if (entry.removed) return;
                  if (entry.dirty) continue;
                  if (page.messagePage.status === 'stale' || cursor && page.messagePage.revision !== cursor.revision) {
                    if (restartedStale) throw new Error('Team run messages changed while reading; retry the snapshot');
                    restartedStale = true;
                    retainMessages = false;
                    snapshot = null;
                    continue;
                  }
                  const previous = get().runSnapshotsByRunId[runId];
                  snapshot = mergeRunMessagePage(snapshot ?? (retainMessages && previous?.teamId === teamId ? previous.snapshot : null), page, cursor ?? undefined);
                  continue;
                }
                set((state) => state.teams.some((team) => team.id === teamId)
                  ? teamRunSnapshotPatch(teamId, runId, snapshot!, state) : {});
                if (entry.dirty) continue;
                if (!entry.completeMessages || snapshot.messagePage.status !== 'incomplete' || !snapshot.messagePage.nextCursor) return;
                set((state) => ({ runSnapshotsByRunId: { ...state.runSnapshotsByRunId, [runId]: {
                  ...state.runSnapshotsByRunId[runId]!, loading: true,
                } } }));
              }
            } catch (error) {
              if (!entry.removed) set((state) => {
                const current = state.runSnapshotsByRunId[runId];
                return current?.teamId === teamId ? { runSnapshotsByRunId: { ...state.runSnapshotsByRunId, [runId]: {
                  ...current, loading: false, error: error instanceof Error ? error.message : String(error),
                } } } : {};
              });
              throw error;
            }
          }).finally(() => {
            if (snapshotReads.get(key) === entry) snapshotReads.delete(key);
          });
        }
        try {
          await entry.promise;
        } catch (error) {
          if (!entry.removed && get().teams.find((team) => team.id === teamId)?.activeRunId === runId) {
            reportTeamError(teamId, error, options);
          }
          throw error;
        }
      },
      submitGraphPatch: async (teamId, operations) => {
        const state = get();
        const runId = resolveActiveRunId(state, teamId);
        const currentGraph = state.graphByTeamId[teamId];
        if (operations.length === 0) return;
        set((state) => ({
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          await submitTeamRunGraphPatch({
            scope: resolveTeamRuntimeScope(teamId, runId),
            runId,
            summary: 'graph_patch',
            patch: {
              ...(currentGraph?.graphId ? { baseGraphId: currentGraph.graphId } : {}),
              ...(currentGraph?.workflowPlanId ? { baseWorkflowPlanId: currentGraph.workflowPlanId } : {}),
              operations,
            },
            idempotencyKey: createRequestId('graph-patch'),
          });
          await get().refreshSnapshot(teamId, { force: true });
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
      exportGraphYaml: async (teamId, requestedRunId) => {
        const state = get();
        const runId = requestedRunId ?? resolveActiveRunId(state, teamId);
        set((state) => ({
          errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined },
        }));
        try {
          await waitForRunLayout({ teamId, runId });
          return await exportTeamRunGraphYaml({ runId, scope: resolveTeamRuntimeScope(teamId, runId) });
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
      importGraphYaml: async (teamId, yaml, requestedRunId) => {
        const runId = requestedRunId ?? resolveActiveRunId(get(), teamId);
        let result: TeamGraphYamlImportResult | undefined;
        set((state) => ({ errorByTeamId: { ...state.errorByTeamId, [teamId]: undefined } }));
        try {
          await mutateTeamDesign({ teamId, runId }, 'run-graph-import', 'reconciled', async (requestId) => {
            result = await importTeamRunGraphYaml({ runId, scope: resolveTeamRuntimeScope(teamId, runId), yaml, idempotencyKey: requestId });
            if (result.snapshot) {
              const snapshot = result.snapshot;
              set((state) => state.teams.some((team) => team.id === teamId) && (state.runIdsByTeamId[teamId] ?? []).includes(runId)
                ? teamRunSnapshotPatch(teamId, runId, snapshot, state) : {});
            }
          });
          if (!result) throw new Error('Team graph import was not confirmed');
          return result;
        } catch (error) {
          reportTeamError(teamId, error);
          throw error;
        }
      },
      resumeRun: async (teamId) => {
        const actionKey = idempotencyKey(teamId, 'resume');
        await runActionOnce(actionKey, async (requestId) => {
          const result = await resumeTeam({
            scope: resolveTeamRuntimeScope(teamId),
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
      cancelRun: async (teamId, reason, requestedRunId) => {
        const state = get();
        const runId = requestedRunId ?? resolveActiveRunId(state, teamId);
        await mutateTeamDesign({ teamId, runId }, 'run-cancel', 'reconciled', async () => {
          try {
            await cancelTeamRun({
              scope: resolveTeamRuntimeScope(teamId, runId),
              runId,
              reason,
              idempotencyKey: idempotencyKey(teamId, `cancel:${runId}`),
            });
          } finally {
            await get().refreshSnapshot(teamId, { force: true, runId });
          }
        });
      },
      resolveApproval: async ({ teamId, runId }, approvalId, decision, note) => {
        await mutateTeamDesign({ teamId, runId }, `approval:${approvalId}:${decision}`, 'reconciled', async (requestId) => {
          try {
            const current = get();
            const latest = current.approvalsByRunId[runId]?.find((row) => row.runId === runId && row.approvalId === approvalId);
            if (!latest || !isTeamApprovalActionable(latest, selectTeamApprovalRunEligibility(current, teamId, runId))) {
              throw new Error('A pending node approval is required');
            }
            await resolveTeamApproval({
              scope: resolveTeamRuntimeScope(teamId, runId),
              runId,
              approvalId,
              decision,
              note,
              idempotencyKey: requestId,
            });
          } finally {
            await get().refreshSnapshot(teamId, { force: true, runId });
          }
        });
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
            scope: resolveTeamRuntimeScope(teamId, runId),
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
      version: 5,
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
