import type {
  SessionExecutionGraphItem,
  SessionRuntimeStateSnapshot,
  SessionTimelineEntry,
} from '../../shared/session-adapter-types';
import type { RuntimeHostLogger } from '../../shared/logger';
import type { SessionRuntimeStorePort } from './session-runtime-store-repository';
import {
  createEmptyTimelineState,
} from './session-state-model';
import type {
  SessionRuntimeTimelineState,
} from './session-runtime-types';
import {
  normalizeString,
} from './session-value-normalization';

export interface SessionRuntimeOverlay {
  sessionKey: string;
  timelineEntries: SessionTimelineEntry[];
  runtime: SessionRuntimeStateSnapshot;
  runtimeModel: string | null;
}

export interface SessionRuntimeStateStoreDeps {
  runtimeStore: SessionRuntimeStorePort;
  logger?: Pick<RuntimeHostLogger, 'warn'>;
}

function clearRuntimeIssueIfMatches(
  runtime: SessionRuntimeStateSnapshot,
  issue: SessionRuntimeStateSnapshot['lastIssue'],
): SessionRuntimeStateSnapshot {
  if (
    !runtime.lastIssue
    || !issue
    || runtime.lastIssue.source !== issue.source
    || runtime.lastIssue.message !== issue.message
    || runtime.lastIssue.at !== issue.at
  ) {
    return runtime;
  }
  return {
    ...runtime,
    lastError: null,
    lastIssue: null,
  };
}

export class SessionRuntimeStateStore {
  private readonly sessionStates = new Map<string, SessionRuntimeTimelineState>();
  private readonly parentSessionsByChildSessionKey = new Map<string, Set<string>>();
  private readonly resolvedSessionModels = new Map<string, string>();
  private readonly persistedStoreReady: Promise<void>;
  private activeSessionKey: string | null = null;
  private activeSessionKeyInitialized = false;
  private activeSessionKeyChangedBeforeLoad = false;
  private latestConnectedTransportEpoch = 0;

  constructor(private readonly deps: SessionRuntimeStateStoreDeps) {
    this.persistedStoreReady = this.loadPersistedStore();
  }

  private async loadPersistedStore(): Promise<void> {
    const store = await this.deps.runtimeStore.load();
    if (!this.activeSessionKeyChangedBeforeLoad) {
      this.activeSessionKey = store.activeSessionKey;
    }
    this.activeSessionKeyInitialized = true;
  }

  async ready(): Promise<void> {
    await this.persistedStoreReady;
  }

  getActiveSessionKey(): string | null {
    return this.activeSessionKey;
  }

  setActiveSessionKey(sessionKey: string | null): void {
    if (!this.activeSessionKeyInitialized) {
      this.activeSessionKeyChangedBeforeLoad = true;
    }
    this.activeSessionKey = sessionKey;
  }

  clearActiveSessionKey(sessionKey: string): void {
    if (this.activeSessionKey === sessionKey) {
      this.activeSessionKey = null;
    }
  }

  getSessionState(sessionKey: string): SessionRuntimeTimelineState {
    const existing = this.sessionStates.get(sessionKey);
    if (existing) {
      return existing;
    }
    const created = createEmptyTimelineState({ sessionKey });
    this.sessionStates.set(sessionKey, created);
    return created;
  }

  findSessionState(sessionKey: string): SessionRuntimeTimelineState | null {
    return this.sessionStates.get(sessionKey) ?? null;
  }

  hasSessionState(sessionKey: string): boolean {
    return this.sessionStates.has(sessionKey);
  }

  deleteSessionState(sessionKey: string): void {
    this.sessionStates.delete(sessionKey);
    this.parentSessionsByChildSessionKey.delete(sessionKey);
    for (const parents of this.parentSessionsByChildSessionKey.values()) {
      parents.delete(sessionKey);
    }
    this.resolvedSessionModels.delete(sessionKey);
    this.clearActiveSessionKey(sessionKey);
  }

  listSessionStates(): Array<[string, SessionRuntimeTimelineState]> {
    return Array.from(this.sessionStates.entries());
  }

  listRuntimeOverlays(): SessionRuntimeOverlay[] {
    return this.listSessionStates().map(([sessionKey, state]) => ({
      sessionKey,
      timelineEntries: state.timelineEntries,
      runtime: state.runtime,
      runtimeModel: this.getResolvedSessionModel(sessionKey),
    }));
  }

  setResolvedSessionModel(sessionKey: string, model: string): void {
    this.resolvedSessionModels.set(sessionKey, model);
  }

  getResolvedSessionModel(sessionKey: string): string | null {
    return this.resolvedSessionModels.get(sessionKey) ?? null;
  }


  updateExecutionGraphDependencyIndex(
    sessionKey: string,
    graphs: SessionExecutionGraphItem[],
  ): void {
    for (const parents of this.parentSessionsByChildSessionKey.values()) {
      parents.delete(sessionKey);
    }
    for (const graph of graphs) {
      const childSessionKey = normalizeString(graph.childSessionKey);
      if (!childSessionKey) {
        continue;
      }
      let parents = this.parentSessionsByChildSessionKey.get(childSessionKey);
      if (!parents) {
        parents = new Set<string>();
        this.parentSessionsByChildSessionKey.set(childSessionKey, parents);
      }
      parents.add(sessionKey);
    }
  }

  listParentSessionKeys(childSessionKey: string): string[] {
    return Array.from(this.parentSessionsByChildSessionKey.get(childSessionKey) ?? []);
  }

  getLatestConnectedTransportEpoch(): number {
    return this.latestConnectedTransportEpoch;
  }

  markTransportConnected(transportEpoch: number): boolean {
    if (!Number.isFinite(transportEpoch) || transportEpoch <= 0) {
      return false;
    }
    if (transportEpoch <= this.latestConnectedTransportEpoch) {
      return false;
    }
    this.latestConnectedTransportEpoch = transportEpoch;
    return true;
  }

  expireTransportControlIssues(transportEpoch: number): string[] {
    if (!Number.isFinite(transportEpoch) || transportEpoch <= 0) {
      return [];
    }
    const expiredSessionKeys: string[] = [];
    for (const [sessionKey, state] of this.sessionStates.entries()) {
      const issueEpoch = state.canonical.control.issueTransportEpoch;
      if (issueEpoch == null || issueEpoch > transportEpoch || !state.canonical.control.issue) {
        continue;
      }
      const expiredIssue = state.canonical.control.issue;
      state.canonical.control = {
        ...state.canonical.control,
        issue: null,
        issueTransportEpoch: null,
      };
      state.canonical.runtime = clearRuntimeIssueIfMatches(state.canonical.runtime, expiredIssue);
      state.runtime = clearRuntimeIssueIfMatches(state.runtime, expiredIssue);
      expiredSessionKeys.push(sessionKey);
    }
    if (expiredSessionKeys.length > 0) {
      this.persistStore();
    }
    return expiredSessionKeys;
  }

  private pendingPersist: Promise<void> | null = null;
  private persistQueued = false;

  persistStore(): void {
    this.persistQueued = true;
    if (this.pendingPersist) {
      return;
    }
    this.pendingPersist = (async () => {
      while (this.persistQueued) {
        await this.flushPersistedStore();
      }
    })()
      .catch((error) => {
        this.persistQueued = true;
        this.deps.logger?.warn('[sessions] runtime state persist failed', error);
      })
      .finally(() => {
        this.pendingPersist = null;
      });
  }

  async flushPersistedStore(): Promise<void> {
    await this.persistedStoreReady;
    if (!this.persistQueued) {
      return;
    }
    this.persistQueued = false;
    await this.deps.runtimeStore.save({
      version: 3,
      activeSessionKey: this.activeSessionKey,
    });
  }
}
