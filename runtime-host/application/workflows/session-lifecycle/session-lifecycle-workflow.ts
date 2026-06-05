import type {
  SessionListResult,
  SessionNewResult,
} from '../../../shared/session-adapter-types';
import type { AgentRuntimeRegistry } from '../../agent-runtime/contracts/agent-runtime-registry';
import { buildRuntimeAddressKey, validateRuntimeAddress, type RuntimeAddress } from '../../agent-runtime/contracts/runtime-address';
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
    runtimeAddress: RuntimeAddress;
  }): Promise<ApplicationResponseOf<SessionNewResult>> {
    const endpoint = this.deps.agentRuntimeRegistry.resolveEndpointForAddress(input.runtimeAddress);
    const sessionKey = input.explicitSessionKey || this.buildSessionKey(endpoint, input.runtimeAddress);
    if (!sessionKey) {
      return conflict(`Runtime endpoint session keying is not configured: ${endpoint.id}`);
    }
    const context = this.rememberRuntimeAddressContext(sessionKey, input.runtimeAddress);
    const state = await this.deps.timelineRuntime.activateSession(sessionKey, {
      resetWindowToLatest: true,
      context,
    });
    await this.deps.sessionStorage.upsertSessionRuntimeAddress(sessionKey, context.address);
    const result: SessionNewResult = {
      success: true,
      sessionKey,
      snapshot: await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, state),
    };
    await this.deps.stateStore.flushPersistedStore();
    return ok(result);
  }

  async delete(input: { sessionKey: string; runtimeAddress: RuntimeAddress }): Promise<ApplicationResponseOf> {
    const ownership = await this.verifySessionRuntimeAddress(input.sessionKey, input.runtimeAddress);
    if (ownership) {
      return ownership;
    }

    const context = this.rememberRuntimeAddressContext(input.sessionKey, input.runtimeAddress);
    await this.deps.sessionStorage.deleteSession(input.sessionKey);
    this.deps.stateStore.deleteSessionState(input.sessionKey, context);
    this.deps.stateStore.persistStore();
    await this.deps.stateStore.flushPersistedStore();
    await this.refreshCatalogQuietly();
    return ok({ success: true });
  }

  async updateStatus(input: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    status: 'active' | 'completed' | 'archived' | 'deleted';
  }): Promise<ApplicationResponseOf> {
    const ownership = await this.verifySessionRuntimeAddress(input.sessionKey, input.runtimeAddress);
    if (ownership) {
      return ownership;
    }
    const updated = await this.deps.sessionStorage.updateSessionStatus(input.sessionKey, input.status);
    if (!updated) {
      return notFound(`Unknown sessionKey: ${input.sessionKey}`);
    }
    if (input.status === 'deleted') {
      const context = this.rememberRuntimeAddressContext(input.sessionKey, input.runtimeAddress);
      this.deps.stateStore.deleteSessionState(input.sessionKey, context);
    }
    await this.refreshCatalogQuietly();
    return ok({ success: true, sessionKey: input.sessionKey, status: input.status });
  }

  async rename(input: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    label: string;
  }): Promise<ApplicationResponseOf> {
    const ownership = await this.verifySessionRuntimeAddress(input.sessionKey, input.runtimeAddress);
    if (ownership) {
      return ownership;
    }
    const updated = await this.deps.sessionStorage.renameSession(input.sessionKey, input.label);
    if (!updated) {
      return notFound(`Unknown sessionKey: ${input.sessionKey}`);
    }
    await this.refreshCatalogQuietly();
    return ok({ success: true, sessionKey: input.sessionKey, label: input.label });
  }

  async list(input: { runtimeAddress: RuntimeAddress }): Promise<ApplicationResponseOf<SessionListResult>> {
    const metaBeforeList = this.deps.sessionCatalog.getSnapshotMeta();
    if (!metaBeforeList.ready) {
      await this.deps.sessionCatalog.refreshCache();
    }
    const result: SessionListResult = await this.deps.sessionCatalog.listSessions({
      runtimeAddress: input.runtimeAddress,
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

  private async verifySessionRuntimeAddress(sessionKey: string, runtimeAddress: RuntimeAddress): Promise<ApplicationResponseOf | null> {
    const state = this.deps.stateStore.findSessionStateByAddress(sessionKey, runtimeAddress);
    if (state) {
      return this.isSameSessionRuntimeAddress(state.canonical.context.address, runtimeAddress)
        ? null
        : conflict(`RuntimeAddress does not match session: ${sessionKey}`);
    }

    const descriptor = await this.deps.timelineRuntime.findStorageDescriptor(sessionKey);
    if (!descriptor) {
      return notFound(`Unknown sessionKey: ${sessionKey}`);
    }
    const storedAddress = this.readStoredRuntimeAddress(descriptor.sessionStoreEntry);
    if (!storedAddress) {
      return conflict(`Session runtime address is missing: ${sessionKey}`);
    }
    return this.isSameSessionRuntimeAddress(storedAddress, runtimeAddress)
      ? null
      : conflict(`RuntimeAddress does not match session: ${sessionKey}`);
  }

  private readStoredRuntimeAddress(entry: Record<string, unknown> | null): RuntimeAddress | null {
    const candidate = entry?.runtimeAddress;
    return validateRuntimeAddress(candidate) ? null : candidate as RuntimeAddress;
  }

  private isSameSessionRuntimeAddress(stored: RuntimeAddress, requested: RuntimeAddress): boolean {
    return buildRuntimeAddressKey(stored) === buildRuntimeAddressKey(requested);
  }

  private rememberRuntimeAddressContext(sessionKey: string, address: RuntimeAddress): RuntimeSessionContext {
    return this.deps.agentRuntimeRegistry.rememberSessionAddress(sessionKey, address);
  }

  private buildSessionKey(endpoint: RuntimeEndpointProfile, address: RuntimeAddress): string | null {
    const namespace = endpoint.keying?.namespace.trim();
    if (!namespace) {
      return null;
    }
    return `${namespace}:${address.agentId}:session-${this.deps.clock.nowMs()}-${this.deps.idGenerator.randomId()}`;
  }

  private async refreshCatalogQuietly(): Promise<void> {
    await this.deps.sessionCatalog.refreshCache().catch(() => undefined);
  }
}
