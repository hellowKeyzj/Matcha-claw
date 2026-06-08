import type {
  SessionListResult,
  SessionNewResult,
} from '../../../shared/session-adapter-types';
import type { AgentRuntimeRegistry } from '../../agent-runtime/contracts/agent-runtime-registry';
import { buildSessionIdentityKey, type RuntimeEndpointRef, type SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import type { RuntimeEndpointProfile, RuntimeSessionContext } from '../../agent-runtime/contracts/runtime-endpoint-types';
import {
  conflict,
  notFound,
  ok,
  type ApplicationResponseOf,
} from '../../common/application-response';
import type { RuntimeClockPort, RuntimeIdGeneratorPort } from '../../common/runtime-ports';
import type { SessionCatalogPort } from '../../sessions/session-catalog';
import type { SessionCatalogJobPort } from '../../sessions/session-catalog-jobs';
import type { SessionRuntimeStateStore } from '../../sessions/session-runtime-state';
import type { SessionSnapshotService } from '../../sessions/session-snapshot-service';
import type { SessionStoragePort } from '../../sessions/session-storage-repository';
import type { SessionTimelineRuntime } from '../../sessions/session-timeline-runtime';

export interface SessionLifecycleWorkflowDeps {
  sessionCatalog: SessionCatalogPort;
  sessionCatalogJobs: Pick<SessionCatalogJobPort, 'getRefreshCatalogJob'>;
  sessionStorage: SessionStoragePort;
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  agentRuntimeRegistry: AgentRuntimeRegistry;
  clock: RuntimeClockPort;
  idGenerator: RuntimeIdGeneratorPort;
}

export class SessionLifecycleWorkflow {
  constructor(private readonly deps: SessionLifecycleWorkflowDeps) {}

  async create(input: {
    explicitSessionKey: string | null;
    endpoint: RuntimeEndpointRef;
    agentId: string;
  }): Promise<ApplicationResponseOf<SessionNewResult>> {
    const endpoint = this.deps.agentRuntimeRegistry.resolveEndpointForRef(input.endpoint, input.agentId);
    const sessionKey = input.explicitSessionKey || this.buildSessionKey(endpoint, input.agentId);
    if (!sessionKey) {
      return conflict(`Runtime endpoint session keying is not configured: ${endpoint.id}`);
    }
    const identity: SessionIdentity = { endpoint: input.endpoint, agentId: input.agentId, sessionKey };
    const context = this.rememberSessionIdentityContext(identity);
    const state = await this.deps.timelineRuntime.activateSession(sessionKey, {
      resetWindowToLatest: true,
      context,
    });
    await this.deps.sessionStorage.upsertSessionIdentity(context.identity);
    const result: SessionNewResult = {
      success: true,
      sessionKey,
      snapshot: await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, state),
    };
    await this.deps.stateStore.flushPersistedStore();
    return ok(result);
  }

  async delete(input: { identity: SessionIdentity }): Promise<ApplicationResponseOf> {
    const ownership = await this.verifySessionIdentity(input.identity);
    if (ownership) {
      return ownership;
    }

    const context = this.rememberSessionIdentityContext(input.identity);
    await this.deps.sessionStorage.deleteSession(input.identity);
    this.deps.stateStore.deleteSessionState(input.identity.sessionKey, context);
    this.deps.stateStore.persistStore();
    await this.deps.stateStore.flushPersistedStore();
    await this.refreshCatalogQuietly();
    return ok({ success: true });
  }

  async updateStatus(input: {
    identity: SessionIdentity;
    status: 'active' | 'completed' | 'archived' | 'deleted';
  }): Promise<ApplicationResponseOf> {
    const ownership = await this.verifySessionIdentity(input.identity);
    if (ownership) {
      return ownership;
    }
    const updated = await this.deps.sessionStorage.updateSessionStatus(input.identity, input.status);
    if (!updated) {
      return notFound(`Unknown sessionKey: ${input.identity.sessionKey}`);
    }
    if (input.status === 'deleted') {
      const context = this.rememberSessionIdentityContext(input.identity);
      this.deps.stateStore.deleteSessionState(input.identity.sessionKey, context);
    }
    await this.refreshCatalogQuietly();
    return ok({ success: true, sessionKey: input.identity.sessionKey, status: input.status });
  }

  async rename(input: {
    identity: SessionIdentity;
    label: string;
  }): Promise<ApplicationResponseOf> {
    const ownership = await this.verifySessionIdentity(input.identity);
    if (ownership) {
      return ownership;
    }
    const updated = await this.deps.sessionStorage.renameSession(input.identity, input.label);
    if (!updated) {
      return notFound(`Unknown sessionKey: ${input.identity.sessionKey}`);
    }
    await this.refreshCatalogQuietly();
    return ok({ success: true, sessionKey: input.identity.sessionKey, label: input.label });
  }

  async list(input: { endpoint: RuntimeEndpointRef }): Promise<ApplicationResponseOf<SessionListResult>> {
    const metaBeforeList = this.deps.sessionCatalog.getSnapshotMeta();
    if (!metaBeforeList.ready) {
      await this.deps.sessionCatalog.refreshCache();
    }
    const result: SessionListResult = await this.deps.sessionCatalog.listSessions({
      endpoint: input.endpoint,
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

  private async verifySessionIdentity(identity: SessionIdentity): Promise<ApplicationResponseOf | null> {
    const state = this.deps.stateStore.findSessionStateByIdentity(identity);
    if (state) {
      return this.isSameSessionIdentity(state.canonical.context.identity, identity)
        ? null
        : conflict(`SessionIdentity does not match session: ${identity.sessionKey}`);
    }

    const descriptor = await this.deps.timelineRuntime.findStorageDescriptor(identity);
    if (!descriptor) {
      return notFound(`Unknown sessionKey: ${identity.sessionKey}`);
    }
    return this.isSameSessionIdentity(descriptor.sessionIdentity, identity)
      ? null
      : conflict(`SessionIdentity does not match session: ${identity.sessionKey}`);
  }

  private isSameSessionIdentity(stored: SessionIdentity, requested: SessionIdentity): boolean {
    return buildSessionIdentityKey(stored) === buildSessionIdentityKey(requested);
  }

  private rememberSessionIdentityContext(identity: SessionIdentity): RuntimeSessionContext {
    return this.deps.agentRuntimeRegistry.rememberSessionIdentity(identity);
  }

  private buildSessionKey(endpoint: RuntimeEndpointProfile, agentId: string): string | null {
    const namespace = endpoint.keying?.namespace.trim();
    if (!namespace) {
      return null;
    }
    return `${namespace}:${agentId}:session-${this.deps.clock.nowMs()}-${this.deps.idGenerator.randomId()}`;
  }

  private async refreshCatalogQuietly(): Promise<void> {
    await this.deps.sessionCatalog.refreshCache().catch(() => undefined);
  }
}
