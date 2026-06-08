import { buildSessionIdentityKey, type SessionIdentity } from '../agent-runtime/contracts/runtime-address';
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
  sessionIdentity: SessionIdentity;
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
  private readonly childStateKeysByParentStateKey = new Map<string, Set<string>>();
  private readonly sessionKeysWithTransportIssue = new Set<string>();
  private readonly approvalsByIdentityKey = new Map<string, SessionApprovalIndexEntry[]>();
  private readonly approvalsById = new Map<string, SessionApprovalIndexEntry>();
  private readonly approvalIndexKeysByStateKey = new Map<string, {
    identityKeys: Set<string>;
    approvalKeys: Set<string>;
  }>();
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

  findSessionStateByIdentity(identity: SessionIdentity): SessionRuntimeTimelineState | null {
    return this.sessionStates.get(this.buildIdentityStateKey(identity)) ?? null;
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
      this.removeParentFromExecutionGraphIndex(stateKey);
      this.childStateKeysByParentStateKey.delete(stateKey);
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
      sessionIdentity: state.canonical.context.identity,
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
    this.removeParentFromExecutionGraphIndex(parentStateKey);
    const childStateKeys = new Set<string>();
    for (const graph of graphs) {
      const childSessionKey = normalizeString(graph.childSessionKey);
      if (!childSessionKey || !graph.childSessionIdentity) {
        continue;
      }
      const childStateKey = this.buildIdentityStateKey(graph.childSessionIdentity);
      let parents = this.parentSessionsByChildStateKey.get(childStateKey);
      if (!parents) {
        parents = new Set<string>();
        this.parentSessionsByChildStateKey.set(childStateKey, parents);
      }
      parents.add(parentStateKey);
      childStateKeys.add(childStateKey);
    }
    if (childStateKeys.size > 0) {
      this.childStateKeysByParentStateKey.set(parentStateKey, childStateKeys);
    }
  }

  listParentSessionStates(identity: SessionIdentity): SessionRuntimeTimelineState[] {
    const parentStateKeys = this.parentSessionsByChildStateKey.get(this.buildIdentityStateKey(identity)) ?? [];
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

  private removeParentFromExecutionGraphIndex(parentStateKey: string): void {
    const previousChildStateKeys = this.childStateKeysByParentStateKey.get(parentStateKey);
    if (!previousChildStateKeys) {
      return;
    }
    for (const childStateKey of previousChildStateKeys) {
      const parents = this.parentSessionsByChildStateKey.get(childStateKey);
      if (!parents) {
        continue;
      }
      parents.delete(parentStateKey);
      if (parents.size === 0) {
        this.parentSessionsByChildStateKey.delete(childStateKey);
      }
    }
    this.childStateKeysByParentStateKey.delete(parentStateKey);
  }

  private removeSessionFromApprovalIndexes(stateKey: string): void {
    const previousIndexKeys = this.approvalIndexKeysByStateKey.get(stateKey);
    if (!previousIndexKeys) {
      return;
    }
    for (const identityKey of previousIndexKeys.identityKeys) {
      const entries = this.approvalsByIdentityKey.get(identityKey);
      if (!entries) {
        continue;
      }
      const retained = entries.filter((entry) => entry.stateKey !== stateKey);
      if (retained.length === 0) {
        this.approvalsByIdentityKey.delete(identityKey);
        continue;
      }
      this.approvalsByIdentityKey.set(identityKey, retained);
    }
    for (const approvalKey of previousIndexKeys.approvalKeys) {
      this.approvalsById.delete(approvalKey);
    }
    this.approvalIndexKeysByStateKey.delete(stateKey);
  }

  syncApprovalIdentityIndex(sessionKey: string, state: SessionRuntimeTimelineState): void {
    const stateKey = this.buildStateKey(sessionKey, state.canonical.context);
    this.removeSessionFromApprovalIndexes(stateKey);
    const identityKeys = new Set<string>();
    const approvalKeys = new Set<string>();
    for (const approval of state.canonical.approvals) {
      const entry = { sessionKey, stateKey, approval };
      const identityKey = buildSessionIdentityKey(approval.sessionIdentity);
      const entries = this.approvalsByIdentityKey.get(identityKey) ?? [];
      entries.push(entry);
      this.approvalsByIdentityKey.set(identityKey, entries);
      const approvalKey = this.buildApprovalIndexKey(approval.sessionIdentity, approval.id);
      this.approvalsById.set(approvalKey, entry);
      identityKeys.add(identityKey);
      approvalKeys.add(approvalKey);
    }
    if (identityKeys.size > 0 || approvalKeys.size > 0) {
      this.approvalIndexKeysByStateKey.set(stateKey, { identityKeys, approvalKeys });
    }
  }

  listApprovals(identity: SessionIdentity): SessionApprovalIndexEntry[] {
    return [...this.approvalsByIdentityKey.get(buildSessionIdentityKey(identity)) ?? []];
  }

  findApproval(identity: SessionIdentity, approvalId: string): SessionApprovalIndexEntry | null {
    return this.approvalsById.get(this.buildApprovalIndexKey(identity, approvalId)) ?? null;
  }

  listApprovalSessionStates(identity: SessionIdentity): Array<[string, SessionRuntimeTimelineState]> {
    const states: Array<[string, SessionRuntimeTimelineState]> = [];
    for (const entry of this.listApprovals(identity)) {
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
      throw new Error(`Session state requires explicit session identity metadata: ${sessionKey}`);
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
      throw new Error(`Session state requires explicit session identity metadata: ${sessionKey}`);
    }
    return matches[0] ?? null;
  }

  private buildStateKey(_sessionKey: string, context: RuntimeSessionContext): string {
    return this.buildIdentityStateKey(context.identity);
  }

  private buildIdentityStateKey(identity: SessionIdentity): string {
    return buildSessionIdentityKey(identity);
  }

  private buildApprovalIndexKey(identity: SessionIdentity, approvalId: string): string {
    return `${buildSessionIdentityKey(identity)}:${approvalId}`;
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
