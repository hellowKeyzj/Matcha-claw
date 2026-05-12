import type {
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
  readRequiredSessionKey,
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
  notFound,
  ok,
  serverError,
  type ApplicationResponseOf,
} from '../common/application-response';
import type { GatewayRpcPort } from '../gateway/gateway-runtime-port';
import type { RuntimeClockPort, RuntimeIdGeneratorPort } from '../common/runtime-ports';
import type {
  SessionHydrationJobPort,
  SessionHydrationJobSubmission,
} from './session-hydration-jobs';
import type { SessionCatalogJobPort } from './session-catalog-jobs';
import type { TaskSnapshotEvent } from '../../shared/session-adapter-types';

export interface SessionCommandServiceDeps {
  sessionCatalog: SessionCatalogPort;
  sessionCatalogJobs: Pick<SessionCatalogJobPort, 'submitRefreshCatalog' | 'getRefreshCatalogJob'>;
  sessionStorage: SessionStoragePort;
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
  clock: RuntimeClockPort;
  idGenerator: RuntimeIdGeneratorPort;
  sessionHydrationJobs: SessionHydrationJobPort;
  readTaskSnapshot?: (sessionKey: string) => Promise<TaskSnapshotEvent | null>;
  emitTaskSnapshot?: (event: TaskSnapshotEvent) => void;
}

type SessionHydratingLoadResult = SessionLoadResult & {
  hydrationJob: SessionHydrationJobSubmission['job'];
};

type SessionHydratingWindowResult = SessionWindowResult & {
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

    await this.deps.sessionStorage.updateSessionStatus(sessionKey, 'deleted');
    this.deps.stateStore.deleteSessionState(sessionKey);
    this.deps.stateStore.persistStore();
    await this.deps.stateStore.flushPersistedStore();
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
    const refreshJob = this.deps.sessionCatalogJobs.submitRefreshCatalog().job;
    const result: SessionListResult = await this.deps.sessionCatalog.listSessions({
      runtimeOverlays: this.deps.stateStore.listRuntimeOverlays(),
    });
    const latestRefreshJob = this.deps.sessionCatalogJobs.getRefreshCatalogJob() ?? refreshJob;
    const meta = this.deps.sessionCatalog.getSnapshotMeta();
    const refreshing = latestRefreshJob?.status === 'queued' || latestRefreshJob?.status === 'running';
    return ok({
      ...result,
      ready: meta.ready,
      refreshing: refreshing || !meta.ready,
      updatedAt: meta.updatedAt,
      error: meta.error,
    });
  }

  async loadSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    const sessionKey = readRequiredSessionKey(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }

    const state = await this.deps.timelineRuntime.activateSession(sessionKey, {
      resetWindowToLatest: true,
    });
    const result: SessionLoadResult = this.withTaskSnapshot(sessionKey, {
      snapshot: await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, state, {
        replayComplete: state.hydrated,
      }),
    });
    await this.deps.stateStore.flushPersistedStore();
    if (!state.hydrated) {
      return accepted({
        ...result,
        hydrationJob: this.submitHydrationJob({
          sessionKey,
          snapshot: { kind: 'latest' },
        }),
      });
    }
    return ok(result);
  }

  async resumeSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    const sessionKey = readRequiredSessionKey(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }

    const state = await this.deps.timelineRuntime.activateSession(sessionKey, {
      resetWindowToLatest: false,
    });
    const result: SessionLoadResult = this.withTaskSnapshot(sessionKey, {
      snapshot: await this.deps.snapshotService.buildSnapshotAsync(sessionKey, state, {
        window: state.window.totalItemCount > 0
          ? state.window
          : createLatestWindowState(state.renderItems.length),
        replayComplete: state.hydrated,
      }),
    });
    await this.deps.stateStore.flushPersistedStore();
    if (!state.hydrated) {
      return accepted({
        ...result,
        hydrationJob: this.submitHydrationJob({
          sessionKey,
          snapshot: { kind: 'state' },
        }),
      });
    }
    return ok(result);
  }

  async patchSession(payload: unknown): Promise<ApplicationResponseOf> {
    const { sessionKey, model } = readPatchSessionRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (!model) {
      return badRequest('model is required');
    }
    const patchResult = await this.deps.gateway.gatewayRpc('sessions.patch', {
      key: sessionKey,
      model,
    }, 30000);
    this.deps.stateStore.setResolvedSessionModel(sessionKey, readPatchedSessionResolvedModel(model, patchResult));

    const state = await this.deps.timelineRuntime.activateSession(sessionKey, {
      resetWindowToLatest: false,
    });
    this.deps.timelineRuntime.clearSessionRuntimeErrorState(sessionKey);
    const snapshot = await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, state, {
      replayComplete: state.hydrated,
    });
    await this.deps.stateStore.flushPersistedStore();

    return ok({
      success: true,
      snapshot,
    });
  }

  async switchSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    return await this.loadSession(payload);
  }

  async getSessionStateSnapshot(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    const sessionKey = readRequiredSessionKey(payload) || this.deps.stateStore.getActiveSessionKey() || '';
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    const state = await this.deps.timelineRuntime.activateSession(sessionKey);
    const data: SessionLoadResult = this.withTaskSnapshot(sessionKey, {
      snapshot: await this.deps.snapshotService.buildSnapshotAsync(sessionKey, state, {
        window: state.window.totalItemCount > 0
          ? state.window
          : createLatestWindowState(state.renderItems.length),
        replayComplete: state.hydrated,
      }),
    });
    await this.deps.stateStore.flushPersistedStore();
    if (!state.hydrated) {
      return accepted({
        ...data,
        hydrationJob: this.submitHydrationJob({
          sessionKey,
          snapshot: { kind: 'state' },
        }),
      });
    }
    return ok(data);
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

    const state = await this.deps.timelineRuntime.activateSession(sessionKey);
    if (!state.hydrated) {
      const result: SessionWindowResult = this.withTaskSnapshot(sessionKey, {
        snapshot: await this.deps.snapshotService.buildSnapshotAsync(sessionKey, state, {
          window: state.window.totalItemCount > 0
            ? state.window
            : createLatestWindowState(state.renderItems.length),
          replayComplete: false,
        }),
      });
      await this.deps.stateStore.flushPersistedStore();
      return accepted({
        ...result,
        hydrationJob: this.submitHydrationJob({
          sessionKey,
          snapshot: {
            kind: 'window',
            mode,
            limit,
            offset,
          },
        }),
      });
    }
    const result: SessionWindowResult = this.withTaskSnapshot(sessionKey, {
      snapshot: await this.deps.snapshotService.buildWindowSnapshotAsync(sessionKey, state, {
        mode,
        limit,
        offset,
      }),
    });
    await this.deps.stateStore.flushPersistedStore();
    return ok(result);
  }

  async abortSessionRuntime(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult & { success: boolean } | { success: false; error: string }>> {
    const sessionKey = readAbortSessionKey(payload, this.deps.stateStore.getActiveSessionKey());
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }

    const runtime = this.deps.timelineRuntime.resolveLifecycleRuntime(sessionKey, {
      phase: 'aborted',
      runId: null,
    });
    const state = await this.deps.timelineRuntime.activateSession(sessionKey, {
      resetWindowToLatest: true,
    });
    const result: SessionLoadResult & { success: boolean } = {
      success: true,
      snapshot: {
        ...await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, state, {
          replayComplete: state.hydrated,
        }),
        runtime,
      },
    };
    await this.deps.stateStore.flushPersistedStore();
    return ok(result);
  }

  async listPendingApprovals(): Promise<ApplicationResponseOf<unknown>> {
    return ok(await this.deps.gateway.gatewayRpc('exec.approvals.get', {}));
  }

  async resolveApproval(payload: unknown): Promise<ApplicationResponseOf> {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
    if (!id) {
      return badRequest('approval id is required');
    }
    if (!decision) {
      return badRequest('approval decision is required');
    }
    return ok(await this.deps.gateway.gatewayRpc('exec.approval.resolve', { id, decision }));
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
    for (const rawApprovalId of rawApprovalIds) {
      const approvalId = typeof rawApprovalId === 'string' ? rawApprovalId.trim() : '';
      if (!approvalId) {
        continue;
      }
      await this.deps.gateway.gatewayRpc('exec.approval.resolve', {
        id: approvalId,
        decision: 'deny',
      });
    }

    await this.deps.gateway.gatewayRpc('chat.abort', { sessionKey });
    return await this.abortSessionRuntime({ sessionKey });
  }

  async executeSessionHydration(payload: unknown): Promise<SessionLoadResult | SessionWindowResult> {
    const sessionKey = readRequiredSessionKey(payload);
    if (!sessionKey) {
      throw new Error('sessionKey is required');
    }
    const state = await this.deps.timelineRuntime.hydrateSession(sessionKey);
    const snapshotRequest = this.readHydrationSnapshotRequest(payload);
    const snapshot = snapshotRequest.kind === 'latest'
      ? await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, state)
      : snapshotRequest.kind === 'window'
        ? await this.deps.snapshotService.buildWindowSnapshotAsync(sessionKey, state, {
            mode: snapshotRequest.mode,
            limit: snapshotRequest.limit,
            offset: snapshotRequest.offset,
          })
        : await this.deps.snapshotService.buildSnapshotAsync(sessionKey, state, {
            window: state.window.totalItemCount > 0
              ? state.window
              : createLatestWindowState(state.renderItems.length),
            replayComplete: true,
          });
    await this.deps.stateStore.flushPersistedStore();
    return this.withTaskSnapshot(sessionKey, { snapshot });
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
