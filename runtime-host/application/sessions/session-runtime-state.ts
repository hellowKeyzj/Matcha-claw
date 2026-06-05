import { buildRuntimeAddressKey, type RuntimeAddress } from '../agent-runtime/contracts/runtime-address';
import type {
  SessionApprovalRequestItem,
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
import type { AgentRuntimeRegistry } from '../agent-runtime/contracts/agent-runtime-registry';
import type { RuntimeSessionContext } from '../agent-runtime/contracts/runtime-endpoint-types';

export interface SessionRuntimeOverlay {
  sessionKey: string;
  protocolId: string;
  runtimeEndpointId: string;
  runtimeAddress: RuntimeAddress;
  timelineEntries: SessionTimelineEntry[];
  runtime: SessionRuntimeStateSnapshot;
  runtimeModel: string | null;
}

export interface SessionRuntimeStateStoreDeps {
  runtimeStore: SessionRuntimeStorePort;
  agentRuntimeRegistry: AgentRuntimeRegistry;
  logger?: Pick<RuntimeHostLogger, 'warn'>;
}

export interface SessionApprovalIndexEntry {
  sessionKey: string;
  stateKey: string;
  approval: SessionApprovalRequestItem;
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
  private readonly parentSessionsByChildStateKey = new Map<string, Set<string>>();
  private readonly sessionKeysWithTransportIssue = new Set<string>();
  private readonly approvalsByAddressKey = new Map<string, SessionApprovalIndexEntry[]>();
  private readonly approvalsById = new Map<string, SessionApprovalIndexEntry>();
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

  getSessionState(sessionKey: string, context?: RuntimeSessionContext): SessionRuntimeTimelineState {
    const stateKey = context ? this.buildStateKey(sessionKey, context) : null;
    const existing = stateKey ? this.sessionStates.get(stateKey) : this.findUniqueSessionState(sessionKey);
    if (existing) {
      return existing;
    }
    const resolvedContext = context ?? this.deps.agentRuntimeRegistry.resolveSessionContext(sessionKey);
    const resolvedStateKey = this.buildStateKey(sessionKey, resolvedContext);
    const created = createEmptyTimelineState({ sessionKey }, resolvedContext);
    this.sessionStates.set(resolvedStateKey, created);
    return created;
  }

  findSessionState(sessionKey: string, context?: RuntimeSessionContext): SessionRuntimeTimelineState | null {
    if (context) {
      return this.sessionStates.get(this.buildStateKey(sessionKey, context)) ?? null;
    }
    return this.findUniqueSessionState(sessionKey);
  }

  findSessionStateByAddress(sessionKey: string, runtimeAddress: RuntimeAddress): SessionRuntimeTimelineState | null {
    return this.sessionStates.get(this.buildAddressStateKey(sessionKey, runtimeAddress)) ?? null;
  }

  hasSessionState(sessionKey: string, context?: RuntimeSessionContext): boolean {
    return this.findSessionState(sessionKey, context) !== null;
  }

  deleteSessionState(sessionKey: string, context?: RuntimeSessionContext): void {
    const stateKeys = context
      ? [this.buildStateKey(sessionKey, context)]
      : this.findStateKeys(sessionKey);
    for (const stateKey of stateKeys) {
      this.sessionStates.delete(stateKey);
      this.parentSessionsByChildStateKey.delete(stateKey);
      this.sessionKeysWithTransportIssue.delete(stateKey);
      this.removeSessionFromApprovalIndexes(stateKey);
      for (const parents of this.parentSessionsByChildStateKey.values()) {
        parents.delete(stateKey);
      }
      this.resolvedSessionModels.delete(stateKey);
    }
    this.clearActiveSessionKey(sessionKey);
  }

  listSessionStates(): Array<[string, SessionRuntimeTimelineState]> {
    return Array.from(this.sessionStates.values()).map((state) => [state.sessionKey, state]);
  }

  listRuntimeOverlays(): SessionRuntimeOverlay[] {
    return Array.from(this.sessionStates.values()).map((state) => ({
      sessionKey: state.sessionKey,
      protocolId: state.canonical.protocolId,
      runtimeEndpointId: state.canonical.runtimeEndpointId,
      runtimeAddress: state.canonical.context.address,
      timelineEntries: state.timelineEntries,
      runtime: state.runtime,
      runtimeModel: this.getResolvedSessionModel(state.sessionKey, state.canonical.context),
    }));
  }

  setResolvedSessionModel(sessionKey: string, model: string, context?: RuntimeSessionContext): void {
    const stateKey = context ? this.buildStateKey(sessionKey, context) : this.resolveExistingStateKey(sessionKey);
    this.resolvedSessionModels.set(stateKey, model);
  }

  getResolvedSessionModel(sessionKey: string, context?: RuntimeSessionContext): string | null {
    const stateKey = context ? this.buildStateKey(sessionKey, context) : this.resolveExistingStateKeyOrNull(sessionKey);
    return stateKey ? this.resolvedSessionModels.get(stateKey) ?? null : null;
  }


  updateExecutionGraphDependencyIndex(
    sessionKey: string,
    parentContext: RuntimeSessionContext,
    graphs: SessionExecutionGraphItem[],
  ): void {
    const parentStateKey = this.buildStateKey(sessionKey, parentContext);
    for (const parents of this.parentSessionsByChildStateKey.values()) {
      parents.delete(parentStateKey);
    }
    for (const graph of graphs) {
      const childSessionKey = normalizeString(graph.childSessionKey);
      if (!childSessionKey || !graph.childRuntimeAddress) {
        continue;
      }
      const childStateKey = this.buildAddressStateKey(childSessionKey, graph.childRuntimeAddress);
      let parents = this.parentSessionsByChildStateKey.get(childStateKey);
      if (!parents) {
        parents = new Set<string>();
        this.parentSessionsByChildStateKey.set(childStateKey, parents);
      }
      parents.add(parentStateKey);
    }
  }

  listParentSessionStates(childSessionKey: string, runtimeAddress: RuntimeAddress): SessionRuntimeTimelineState[] {
    const parentStateKeys = this.parentSessionsByChildStateKey.get(this.buildAddressStateKey(childSessionKey, runtimeAddress)) ?? [];
    const states: SessionRuntimeTimelineState[] = [];
    for (const stateKey of parentStateKeys) {
      const state = this.sessionStates.get(stateKey);
      if (state) {
        states.push(state);
      }
    }
    return states;
  }

  syncTransportIssueIndex(sessionKey: string, state: SessionRuntimeTimelineState): void {
    const stateKey = this.buildStateKey(sessionKey, state.canonical.context);
    if (state.canonical.control.issue && state.canonical.control.issueTransportEpoch != null) {
      this.sessionKeysWithTransportIssue.add(stateKey);
      return;
    }
    this.sessionKeysWithTransportIssue.delete(stateKey);
  }

  private removeSessionFromApprovalIndexes(stateKey: string): void {
    for (const [addressKey, entries] of this.approvalsByAddressKey.entries()) {
      const retained = entries.filter((entry) => entry.stateKey !== stateKey);
      if (retained.length === 0) {
        this.approvalsByAddressKey.delete(addressKey);
        continue;
      }
      this.approvalsByAddressKey.set(addressKey, retained);
    }
    for (const [approvalId, entry] of this.approvalsById.entries()) {
      if (entry.stateKey === stateKey) {
        this.approvalsById.delete(approvalId);
      }
    }
  }

  syncApprovalAddressIndex(sessionKey: string, state: SessionRuntimeTimelineState): void {
    const stateKey = this.buildStateKey(sessionKey, state.canonical.context);
    this.removeSessionFromApprovalIndexes(stateKey);
    for (const approval of state.canonical.approvals) {
      const entry = { sessionKey, stateKey, approval };
      const addressKey = buildRuntimeAddressKey(approval.runtimeAddress);
      const entries = this.approvalsByAddressKey.get(addressKey) ?? [];
      entries.push(entry);
      this.approvalsByAddressKey.set(addressKey, entries);
      this.approvalsById.set(approval.id, entry);
    }
  }

  listApprovals(runtimeAddress: RuntimeAddress): SessionApprovalIndexEntry[] {
    return [...this.approvalsByAddressKey.get(buildRuntimeAddressKey(runtimeAddress)) ?? []];
  }

  findApproval(approvalId: string): SessionApprovalIndexEntry | null {
    return this.approvalsById.get(approvalId) ?? null;
  }

  listApprovalSessionStates(runtimeAddress: RuntimeAddress): Array<[string, SessionRuntimeTimelineState]> {
    const states: Array<[string, SessionRuntimeTimelineState]> = [];
    for (const entry of this.listApprovals(runtimeAddress)) {
      const state = this.sessionStates.get(entry.stateKey);
      if (state) {
        states.push([entry.sessionKey, state]);
      }
    }
    return states;
  }

  private findStateKeys(sessionKey: string): string[] {
    return Array.from(this.sessionStates.entries())
      .filter(([, state]) => state.sessionKey === sessionKey)
      .map(([stateKey]) => stateKey);
  }

  private findUniqueSessionState(sessionKey: string): SessionRuntimeTimelineState | null {
    const matches = this.findStateKeys(sessionKey).map((stateKey) => this.sessionStates.get(stateKey)!);
    if (matches.length > 1) {
      throw new Error(`Session state requires explicit runtime address metadata: ${sessionKey}`);
    }
    return matches[0] ?? null;
  }

  private resolveExistingStateKey(sessionKey: string): string {
    const stateKey = this.resolveExistingStateKeyOrNull(sessionKey);
    if (!stateKey) {
      throw new Error(`Unknown session state: ${sessionKey}`);
    }
    return stateKey;
  }

  private resolveExistingStateKeyOrNull(sessionKey: string): string | null {
    const matches = this.findStateKeys(sessionKey);
    if (matches.length > 1) {
      throw new Error(`Session state requires explicit runtime address metadata: ${sessionKey}`);
    }
    return matches[0] ?? null;
  }

  private buildStateKey(sessionKey: string, context: RuntimeSessionContext): string {
    return this.buildAddressStateKey(sessionKey, context.address);
  }

  private buildAddressStateKey(sessionKey: string, runtimeAddress: RuntimeAddress): string {
    return `${buildRuntimeAddressKey(runtimeAddress)}::${sessionKey}`;
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
    for (const stateKey of Array.from(this.sessionKeysWithTransportIssue)) {
      const state = this.sessionStates.get(stateKey);
      if (!state) {
        this.sessionKeysWithTransportIssue.delete(stateKey);
        continue;
      }
      const issueEpoch = state.canonical.control.issueTransportEpoch;
      if (issueEpoch == null || issueEpoch > transportEpoch || !state.canonical.control.issue) {
        this.syncTransportIssueIndex(state.sessionKey, state);
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
      this.sessionKeysWithTransportIssue.delete(stateKey);
      expiredSessionKeys.push(state.sessionKey);
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
