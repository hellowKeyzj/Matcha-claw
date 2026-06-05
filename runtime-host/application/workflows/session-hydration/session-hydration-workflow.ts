import type {
  SessionLoadResult,
  SessionWindowResult,
} from '../../../shared/session-adapter-types';
import { validateRuntimeAddress, type RuntimeAddress } from '../../agent-runtime/contracts/runtime-address';
import type { AgentRuntimeRegistry } from '../../agent-runtime/contracts/agent-runtime-registry';
import type { SessionOperationCoordinator } from '../../sessions/session-operation-coordinator';
import {
  type SessionHydrationJobPayload,
  type SessionHydrationJobPort,
  type SessionHydrationJobSubmission,
} from '../../sessions/session-hydration-jobs';
import type { SessionRuntimeStateStore } from '../../sessions/session-runtime-state';
import type { SessionSnapshotService } from '../../sessions/session-snapshot-service';
import type { SessionTimelineRuntime } from '../../sessions/session-timeline-runtime';
import { createLatestWindowState, type SessionWindowMode } from '../../sessions/session-window-model';
import { readRequiredSessionKey, readSessionWindowRequest } from '../../sessions/session-runtime-requests';
import {
  accepted,
  ok,
  type ApplicationResponseOf,
} from '../../common/application-response';

export type SessionHydratingLoadResult = Partial<SessionLoadResult> & {
  hydrationJob: SessionHydrationJobSubmission['job'];
};

export type SessionHydratingWindowResult = Partial<SessionWindowResult> & {
  hydrationJob: SessionHydrationJobSubmission['job'];
};

export interface SessionHydrationWorkflowDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  agentRuntimeRegistry: AgentRuntimeRegistry;
  operationCoordinator: SessionOperationCoordinator;
  sessionHydrationJobs: SessionHydrationJobPort;
}

export class SessionHydrationWorkflow {
  constructor(private readonly deps: SessionHydrationWorkflowDeps) {}

  load(input: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    limit: number;
  }): ApplicationResponseOf<SessionHydratingLoadResult> {
    return this.acceptHydrationJob({
      sessionKey: input.sessionKey,
      runtimeAddress: input.runtimeAddress,
      snapshot: {
        kind: 'window',
        mode: 'latest',
        limit: input.limit,
        offset: null,
      },
    });
  }

  resume(input: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
  }): ApplicationResponseOf<SessionHydratingLoadResult> {
    return this.acceptHydrationJob({
      sessionKey: input.sessionKey,
      runtimeAddress: input.runtimeAddress,
      snapshot: { kind: 'state' },
    });
  }

  state(input: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
  }): ApplicationResponseOf<SessionHydratingLoadResult> {
    return this.acceptHydrationJob({
      sessionKey: input.sessionKey,
      runtimeAddress: input.runtimeAddress,
      snapshot: { kind: 'state' },
    });
  }

  async window(input: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    mode: SessionWindowMode;
    limit: number;
    offset: number | null;
  }): Promise<ApplicationResponseOf<SessionWindowResult | SessionHydratingWindowResult>> {
    const context = this.deps.agentRuntimeRegistry.rememberSessionAddress(input.sessionKey, input.runtimeAddress);
    const currentState = this.deps.stateStore.findSessionState(input.sessionKey, context);
    if (currentState?.hydrated) {
      const snapshot = await this.deps.snapshotService.buildWindowSnapshotAsync(input.sessionKey, currentState, {
        mode: input.mode,
        limit: input.limit,
        offset: input.offset,
      });
      currentState.window = snapshot.window;
      this.deps.stateStore.persistStore();
      await this.deps.stateStore.flushPersistedStore();
      return ok({ snapshot });
    }

    return this.acceptHydrationJob({
      sessionKey: input.sessionKey,
      runtimeAddress: input.runtimeAddress,
      snapshot: {
        kind: 'window',
        mode: input.mode,
        limit: input.limit,
        offset: input.offset,
      },
    });
  }

  private acceptHydrationJob(input: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    snapshot: SessionHydrationJobPayload['snapshot'];
  }): ApplicationResponseOf<SessionHydratingLoadResult | SessionHydratingWindowResult> {
    return accepted({
      hydrationJob: this.submit(input),
    });
  }

  private submit(input: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    snapshot: SessionHydrationJobPayload['snapshot'];
  }): SessionHydrationJobSubmission['job'] {
    return this.deps.sessionHydrationJobs.submitSessionHydration({
      sessionKey: input.sessionKey,
      runtimeAddress: {
        ...input.runtimeAddress,
        sessionKey: input.sessionKey,
      },
      snapshot: input.snapshot,
    }).job;
  }

  async execute(payload: unknown): Promise<SessionLoadResult | SessionWindowResult> {
    const request = this.readHydrationRequest(payload);
    const context = this.deps.agentRuntimeRegistry.rememberSessionAddress(request.sessionKey, request.runtimeAddress);
    return await this.hydrateFromTranscriptSlowPath(request, context);
  }

  private async hydrateFromTranscriptSlowPath(
    request: {
      sessionKey: string;
      runtimeAddress: RuntimeAddress;
      snapshot: SessionHydrationJobPayload['snapshot'];
    },
    context: ReturnType<AgentRuntimeRegistry['rememberSessionAddress']>,
  ): Promise<SessionLoadResult | SessionWindowResult> {
    return await this.deps.operationCoordinator.run(request.sessionKey, 'reconcile', async () => {
      const state = await this.deps.timelineRuntime.hydrateSession(request.sessionKey, context);
      const snapshot = await this.buildHydratedSnapshot(request, state);
      state.window = snapshot.window;
      await this.persistHydratedState();
      return { snapshot };
    });
  }

  private async buildHydratedSnapshot(
    request: {
      sessionKey: string;
      snapshot: SessionHydrationJobPayload['snapshot'];
    },
    state: ReturnType<SessionRuntimeStateStore['getSessionState']>,
  ): Promise<SessionLoadResult['snapshot'] | SessionWindowResult['snapshot']> {
    if (request.snapshot.kind === 'window') {
      return await this.deps.snapshotService.buildWindowSnapshotAsync(request.sessionKey, state, {
        mode: request.snapshot.mode,
        limit: request.snapshot.limit,
        offset: request.snapshot.offset,
      });
    }
    if (request.snapshot.kind === 'latest') {
      return await this.deps.snapshotService.buildLatestSnapshotAsync(request.sessionKey, state);
    }
    return await this.deps.snapshotService.buildSnapshotAsync(request.sessionKey, state, {
      window: state.window.totalItemCount > 0
        ? state.window
        : createLatestWindowState(state.renderItems.length),
      replayComplete: true,
    });
  }

  private async persistHydratedState(): Promise<void> {
    this.deps.stateStore.persistStore();
    await this.deps.stateStore.flushPersistedStore();
  }

  private readHydrationRequest(payload: unknown): {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    snapshot: SessionHydrationJobPayload['snapshot'];
  } {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as { sessionKey?: unknown; runtimeAddress?: unknown; snapshot?: unknown }
      : {};
    const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '';
    if (!sessionKey) {
      throw new Error('sessionKey is required');
    }
    const addressError = validateRuntimeAddress(body.runtimeAddress);
    if (addressError) {
      throw new Error(addressError);
    }
    return {
      sessionKey,
      runtimeAddress: body.runtimeAddress as RuntimeAddress,
      snapshot: this.readHydrationSnapshotRequest(payload),
    };
  }

  private readHydrationSnapshotRequest(payload: unknown):
    | { kind: 'latest' }
    | { kind: 'state' }
    | {
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
        runtimeAddress: (payload as { runtimeAddress?: unknown }).runtimeAddress,
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
