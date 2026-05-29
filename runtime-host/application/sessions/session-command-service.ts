import type {
  SessionApprovalDecision,
  SessionListResult,
  SessionLoadResult,
  SessionNewResult,
  SessionWindowResult,
} from '../../shared/session-adapter-types';
import {
  createLatestWindowState,
} from './session-window-model';
import {
  readPatchedSessionResolvedModel,
} from './session-state-model';
import {
  readAbortSessionKey,
  readCreateSessionRequest,
  readPatchSessionRequest,
  readRenameSessionRequest,
  readRequiredSessionKey,
  readSessionLoadRequest,
  readSessionWindowRequest,
} from './session-runtime-requests';
import type { SessionWindowMode } from './session-window-model';
import type { SessionCatalogPort } from './session-catalog';
import { SessionRuntimeStateStore } from './session-runtime-state';
import { SessionSnapshotService } from './session-snapshot-service';
import type { SessionStoragePort } from './session-storage-repository';
import { SessionTimelineRuntime } from './session-timeline-runtime';
import {
  accepted,
  badRequest,
  conflict,
  notFound,
  ok,
  type ApplicationResponseOf,
} from '../common/application-response';
import type { GatewayRpcPort } from '../gateway/gateway-runtime-port';
import { isRunActive } from '../../shared/session-adapter-types';
import type { RuntimeClockPort, RuntimeIdGeneratorPort } from '../common/runtime-ports';
import type {
  SessionHydrationJobPort,
  SessionHydrationJobSubmission,
} from './session-hydration-jobs';
import type { SessionCatalogJobPort } from './session-catalog-jobs';
import type { TaskSnapshotEvent } from '../../shared/session-adapter-types';
import { SessionOperationCoordinator } from './session-operation-coordinator';
import type { CanonicalSessionEvent } from './canonical/canonical-events';

export interface SessionCommandServiceDeps {
  sessionCatalog: SessionCatalogPort;
  sessionCatalogJobs: Pick<SessionCatalogJobPort, 'submitRefreshCatalog' | 'getRefreshCatalogJob'>;
  sessionStorage: SessionStoragePort;
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
  operationCoordinator: SessionOperationCoordinator;
  clock: RuntimeClockPort;
  idGenerator: RuntimeIdGeneratorPort;
  sessionHydrationJobs: SessionHydrationJobPort;
  readTaskSnapshot?: (sessionKey: string) => Promise<TaskSnapshotEvent | null>;
  emitTaskSnapshot?: (event: TaskSnapshotEvent) => void;
}

type SessionHydratingLoadResult = Partial<SessionLoadResult> & {
  hydrationJob: SessionHydrationJobSubmission['job'];
};

type SessionHydratingWindowResult = Partial<SessionWindowResult> & {
  hydrationJob: SessionHydrationJobSubmission['job'];
};

export class SessionCommandService {
  constructor(private readonly deps: SessionCommandServiceDeps) {}

  private submitHydrationJob(input: {
    sessionKey: string;
    snapshot: Parameters<SessionHydrationJobPort['submitSessionHydration']>[0]['snapshot'];
  }): SessionHydrationJobSubmission['job'] {
    return this.deps.sessionHydrationJobs.submitSessionHydration({
      sessionKey: input.sessionKey,
      snapshot: input.snapshot,
    }).job;
  }

  private acceptHydrationJob(input: {
    sessionKey: string;
    snapshot: Parameters<SessionHydrationJobPort['submitSessionHydration']>[0]['snapshot'];
  }): ApplicationResponseOf<SessionHydratingLoadResult | SessionHydratingWindowResult> {
    return accepted({
      hydrationJob: this.submitHydrationJob(input),
    });
  }

  private withTaskSnapshot<T extends { snapshot: SessionLoadResult['snapshot'] }>(
    sessionKey: string,
    result: T,
  ): T {
    if (!this.deps.readTaskSnapshot) {
      return result;
    }
    void this.deps.readTaskSnapshot(sessionKey)
      .then((taskSnapshot) => {
        if (taskSnapshot) {
          this.deps.emitTaskSnapshot?.(taskSnapshot);
        }
      })
      .catch(() => undefined);
    return result;
  }

  async createSession(payload: unknown): Promise<ApplicationResponseOf<SessionNewResult>> {
    const { explicitSessionKey, canonicalPrefix } = readCreateSessionRequest(payload);
    const sessionKey = explicitSessionKey || `${canonicalPrefix}:session-${this.deps.clock.nowMs()}-${this.deps.idGenerator.randomId()}`;
    const state = await this.deps.timelineRuntime.activateSession(sessionKey, {
      resetWindowToLatest: true,
    });
    const result: SessionNewResult = this.withTaskSnapshot(sessionKey, {
      success: true,
      sessionKey,
      snapshot: await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, state),
    });
    await this.deps.stateStore.flushPersistedStore();
    return ok(result);
  }

  async deleteSession(payload: unknown): Promise<ApplicationResponseOf> {
    const sessionKey = readRequiredSessionKey(payload);
    if (!sessionKey || !sessionKey.startsWith('agent:')) {
      return badRequest(`Invalid sessionKey: ${sessionKey}`);
    }
    const hasStorage = Boolean(await this.deps.timelineRuntime.findStorageDescriptor(sessionKey));
    if (!this.deps.stateStore.hasSessionState(sessionKey) && !hasStorage) {
      return notFound(`Unknown sessionKey: ${sessionKey}`);
    }

    await this.deps.sessionStorage.deleteSession(sessionKey);
    this.deps.stateStore.deleteSessionState(sessionKey);
    this.deps.stateStore.persistStore();
    await this.deps.stateStore.flushPersistedStore();
    await this.deps.sessionCatalog.refreshCache().catch(() => undefined);
    return ok({ success: true });
  }

  async archiveSession(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.updateSessionStatus(payload, 'archived');
  }

  async unarchiveSession(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.updateSessionStatus(payload, 'completed');
  }

  async updateSessionStatus(
    payload: unknown,
    forcedStatus?: 'active' | 'completed' | 'archived' | 'deleted',
  ): Promise<ApplicationResponseOf> {
    const sessionKey = readRequiredSessionKey(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    const body = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const status = forcedStatus ?? (
      body.status === 'active'
      || body.status === 'completed'
      || body.status === 'archived'
      || body.status === 'deleted'
        ? body.status
        : null
    );
    if (!status) {
      return badRequest('status is required');
    }
    const updated = await this.deps.sessionStorage.updateSessionStatus(sessionKey, status);
    if (!updated) {
      return notFound(`Unknown sessionKey: ${sessionKey}`);
    }
    if (status === 'deleted') {
      this.deps.stateStore.deleteSessionState(sessionKey);
    }
    await this.deps.sessionCatalog.refreshCache().catch(() => undefined);
    return ok({ success: true, sessionKey, status });
  }

  async listSessions(): Promise<ApplicationResponseOf<SessionListResult>> {
    const metaBeforeList = this.deps.sessionCatalog.getSnapshotMeta();
    if (!metaBeforeList.ready) {
      await this.deps.sessionCatalog.refreshCache();
    }
    const result: SessionListResult = await this.deps.sessionCatalog.listSessions({
      runtimeOverlays: this.deps.stateStore.listRuntimeOverlays(),
    });
    const latestRefreshJob = this.deps.sessionCatalogJobs.getRefreshCatalogJob();
    const meta = this.deps.sessionCatalog.getSnapshotMeta();
    const refreshing = latestRefreshJob?.status === 'queued' || latestRefreshJob?.status === 'running';
    return ok({
      ...result,
      ready: meta.ready,
      refreshing,
      updatedAt: meta.updatedAt,
      error: meta.error,
    });
  }

  async loadSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    const { sessionKey, limit } = readSessionLoadRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    return this.acceptHydrationJob({
      sessionKey,
      snapshot: {
        kind: 'window',
        mode: 'latest',
        limit,
        offset: null,
      },
    });
  }

  async resumeSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    const sessionKey = readRequiredSessionKey(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    return this.acceptHydrationJob({
      sessionKey,
      snapshot: { kind: 'state' },
    });
  }

  async patchSession(payload: unknown): Promise<ApplicationResponseOf> {
    const { sessionKey, model } = readPatchSessionRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (!model) {
      return badRequest('model is required');
    }
    return await this.deps.operationCoordinator.run(sessionKey, 'patch-model', async () => {
      const current = this.deps.stateStore.getSessionState(sessionKey).runtime;
      if (isRunActive(current) || current.activeRunId) {
        const state = await this.deps.timelineRuntime.activateSession(sessionKey, {
          resetWindowToLatest: false,
        });
        const snapshot = await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, state, {
          replayComplete: state.hydrated,
        });
        return conflict({
          success: false,
          code: 'ACTIVE_RUN',
          error: 'Cannot switch model while a session run is active',
          snapshot,
        });
      }
      const patchResult = await this.deps.gateway.gatewayRpc('sessions.patch', {
        key: sessionKey,
        model,
      }, 10000);
      this.deps.stateStore.setResolvedSessionModel(sessionKey, readPatchedSessionResolvedModel(model, patchResult));

      const state = await this.deps.timelineRuntime.activateSession(sessionKey, {
        resetWindowToLatest: false,
      });
      const snapshot = await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, state, {
        replayComplete: state.hydrated,
      });
      await this.deps.stateStore.flushPersistedStore();

      return ok({
        success: true,
        snapshot,
      });
    });
  }

  async renameSession(payload: unknown): Promise<ApplicationResponseOf> {
    const { sessionKey, label } = readRenameSessionRequest(payload);
    if (!sessionKey || !sessionKey.startsWith('agent:')) {
      return badRequest(`Invalid sessionKey: ${sessionKey}`);
    }
    if (!label) {
      return badRequest('label is required');
    }
    const updated = await this.deps.sessionStorage.renameSession(sessionKey, label);
    if (!updated) {
      return notFound(`Unknown sessionKey: ${sessionKey}`);
    }
    await this.deps.sessionCatalog.refreshCache().catch(() => undefined);
    return ok({ success: true, sessionKey, label });
  }

  async switchSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    return await this.loadSession(payload);
  }

  async getSessionStateSnapshot(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    const sessionKey = readRequiredSessionKey(payload) || this.deps.stateStore.getActiveSessionKey() || '';
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    return this.acceptHydrationJob({
      sessionKey,
      snapshot: { kind: 'state' },
    });
  }

  async getSessionWindow(payload: unknown): Promise<ApplicationResponseOf<SessionWindowResult | SessionHydratingWindowResult | { success: false; error: string }>> {
    const {
      sessionKey,
      mode,
      limit,
      offset,
    } = readSessionWindowRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }

    if ((mode === 'older' || mode === 'newer') && offset == null) {
      return badRequest(`offset is required for mode: ${mode}`);
    }

    const currentState = this.deps.stateStore.findSessionState(sessionKey);
    if (currentState?.hydrated) {
      const snapshot = await this.deps.snapshotService.buildWindowSnapshotAsync(sessionKey, currentState, {
        mode,
        limit,
        offset,
      });
      currentState.window = snapshot.window;
      this.deps.stateStore.persistStore();
      await this.deps.stateStore.flushPersistedStore();
      return ok(this.withTaskSnapshot(sessionKey, { snapshot }));
    }

    return this.acceptHydrationJob({
      sessionKey,
      snapshot: {
        kind: 'window',
        mode,
        limit,
        offset,
      },
    });
  }

  private async commitAbortSession(sessionKey: string): Promise<ApplicationResponseOf<SessionLoadResult & { success: boolean } | { success: false; error: string }>> {
    return await this.deps.operationCoordinator.run(sessionKey, 'abort', async () => {
      const currentRunId = this.deps.stateStore.getSessionState(sessionKey).runtime.activeRunId ?? undefined;
      const committed = this.deps.timelineRuntime.appendCanonicalEvents(sessionKey, [{
        eventId: `local:lifecycle:${sessionKey}:${currentRunId ?? 'active'}:aborted`,
        type: 'lifecycle',
        provider: 'openclaw-v4',
        source: 'live',
        sessionId: sessionKey,
        ...(currentRunId ? { runId: currentRunId } : {}),
        timestamp: this.deps.clock.nowMs(),
        laneKey: 'main',
        origin: {
          providerEventType: 'local.abort',
          providerIds: {
            sessionKey,
            ...(currentRunId ? { runId: currentRunId } : {}),
          },
        },
        phase: 'aborted',
        runPhase: 'aborted',
        error: null,
      }]);
      committed.state.window = createLatestWindowState(committed.state.renderItems.length);
      const result: SessionLoadResult & { success: boolean } = {
        success: true,
        snapshot: {
          ...await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, committed.state, {
            replayComplete: committed.state.hydrated,
          }),
          runtime: committed.runtime,
        },
      };
      await this.deps.stateStore.flushPersistedStore();
      return ok(result);
    });
  }

  async abortSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult & { success: boolean } | { success: false; error: string }>> {
    const sessionKey = readAbortSessionKey(payload, this.deps.stateStore.getActiveSessionKey());
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }

    const body = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const rawApprovalIds = Array.isArray(body.approvalIds) ? body.approvalIds : [];
    void Promise.all(rawApprovalIds.map((rawApprovalId) => {
      const approvalId = typeof rawApprovalId === 'string' ? rawApprovalId.trim() : '';
      if (!approvalId) {
        return Promise.resolve();
      }
      return this.deps.gateway.gatewayRpc('exec.approval.resolve', {
        id: approvalId,
        decision: 'deny',
      }, 5000).catch(() => undefined);
    })).catch(() => undefined);

    const response = await this.commitAbortSession(sessionKey);
    void this.deps.gateway.gatewayRpc('chat.abort', { sessionKey }, 5000).catch(() => undefined);
    return response;
  }

  async listPendingApprovals(): Promise<ApplicationResponseOf<unknown>> {
    return ok({
      approvals: this.deps.stateStore.listSessionStates()
        .flatMap(([, state]) => state.canonical.approvals)
        .map((approval) => structuredClone(approval))
        .sort((left, right) => left.createdAtMs - right.createdAtMs),
    });
  }

  private findPendingApproval(approvalId: string): { sessionKey: string; runId?: string } | null {
    for (const [sessionKey, state] of this.deps.stateStore.listSessionStates()) {
      const approval = state.canonical.approvals.find((candidate) => candidate.id === approvalId);
      if (approval) {
        return {
          sessionKey,
          ...(approval.runId ? { runId: approval.runId } : {}),
        };
      }
    }
    return null;
  }

  private appendResolvedApprovalEvent(input: { id: string; decision: SessionApprovalDecision; sessionKey: string; runId?: string }): void {
    const now = this.deps.clock.nowMs();
    const event: CanonicalSessionEvent = {
      eventId: `local:approval:resolved:${input.sessionKey}:${input.id}:${input.decision}`,
      type: 'approval',
      provider: 'openclaw-v4',
      source: 'live',
      sessionId: input.sessionKey,
      ...(input.runId ? { runId: input.runId } : {}),
      timestamp: now,
      laneKey: 'main',
      origin: {
        providerEventType: 'local.approval.resolved',
        providerIds: {
          sessionKey: input.sessionKey,
          ...(input.runId ? { runId: input.runId } : {}),
          approvalId: input.id,
        },
      },
      approvalId: input.id,
      status: 'resolved',
      decision: input.decision,
      title: 'approval',
      allowedDecisions: ['allow-once', 'allow-always', 'deny'],
      createdAtMs: now,
    };
    this.deps.timelineRuntime.appendCanonicalEvents(input.sessionKey, [event]);
  }

  async resolveApproval(payload: unknown): Promise<ApplicationResponseOf> {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const rawDecision = typeof body.decision === 'string' ? body.decision.trim() : '';
    const decision = rawDecision === 'allow-once' || rawDecision === 'allow-always' || rawDecision === 'deny'
      ? rawDecision
      : '';
    if (!id) {
      return badRequest('approval id is required');
    }
    if (!decision) {
      return badRequest('approval decision is required');
    }
    const pendingApproval = this.findPendingApproval(id);
    const result = await this.deps.gateway.gatewayRpc('exec.approval.resolve', { id, decision });
    if (pendingApproval) {
      this.appendResolvedApprovalEvent({
        id,
        decision,
        sessionKey: pendingApproval.sessionKey,
        ...(pendingApproval.runId ? { runId: pendingApproval.runId } : {}),
      });
    }
    return ok(result);
  }

  async executeSessionHydration(payload: unknown): Promise<SessionLoadResult | SessionWindowResult> {
    const sessionKey = readRequiredSessionKey(payload);
    if (!sessionKey) {
      throw new Error('sessionKey is required');
    }
    return await this.deps.operationCoordinator.run(sessionKey, 'reconcile', async () => {
      const state = await this.deps.timelineRuntime.hydrateSession(sessionKey);
      const snapshotRequest = this.readHydrationSnapshotRequest(payload);
      const snapshot = snapshotRequest.kind === 'window'
        ? await this.deps.snapshotService.buildWindowSnapshotAsync(sessionKey, state, {
            mode: snapshotRequest.mode,
            limit: snapshotRequest.limit,
            offset: snapshotRequest.offset,
          })
        : snapshotRequest.kind === 'latest'
          ? await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, state)
          : await this.deps.snapshotService.buildSnapshotAsync(sessionKey, state, {
              window: state.window.totalItemCount > 0
                ? state.window
                : createLatestWindowState(state.renderItems.length),
              replayComplete: true,
            });
      state.window = snapshot.window;
      this.deps.stateStore.persistStore();
      await this.deps.stateStore.flushPersistedStore();
      return this.withTaskSnapshot(sessionKey, { snapshot });
    });
  }

  private readHydrationSnapshotRequest(payload: unknown): {
    kind: 'latest';
  } | {
    kind: 'state';
  } | {
    kind: 'window';
    mode: SessionWindowMode;
    limit: number;
    offset: number | null;
  } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { kind: 'state' };
    }
    const snapshot = (payload as { snapshot?: unknown }).snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return { kind: 'state' };
    }
    const kind = (snapshot as { kind?: unknown }).kind;
    if (kind === 'latest') {
      return { kind: 'latest' };
    }
    if (kind === 'window') {
      const request = readSessionWindowRequest({
        sessionKey: readRequiredSessionKey(payload),
        mode: (snapshot as { mode?: unknown }).mode,
        limit: (snapshot as { limit?: unknown }).limit,
        offset: (snapshot as { offset?: unknown }).offset,
      });
      return {
        kind: 'window',
        mode: request.mode,
        limit: request.limit,
        offset: request.offset,
      };
    }
    return { kind: 'state' };
  }
}
