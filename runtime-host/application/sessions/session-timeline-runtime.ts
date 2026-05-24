import type {
  SessionRunPhase,
  SessionRuntimeStateSnapshot,
  SessionTimelineAssistantTurnEntry,
  SessionTimelineEntry,
  SessionRunClosureRequest,
  SessionRunClosureResult,
  SessionTurnToolResultsRequest,
  SessionTurnToolResultsResult,
  TaskSnapshotEvent,
} from '../../shared/session-adapter-types';
import { isRunActive } from '../../shared/session-adapter-types';
import type { GatewayTransportIssue } from '../../shared/gateway-error';
import {
  buildTimelineEntriesFromTranscriptMessage,
} from './transcript-timeline-materializer';
import type { SessionTranscriptMessage } from './transcript-types';
import {
  assembleAuthoritativeAssistantTurns,
  resolveAssistantTurnItemKeyFromTimelineEntry,
} from './assistant-turn-assembler';
import {
  applyToolStatusUpdate,
  applyTranscriptToolResultUpdates,
  findTimelineEntryIndex,
  mergeTimelineEntries,
  upsertTimelineEntry,
} from './timeline-state';
import {
  type SessionStoragePort,
  type SessionStorageDescriptor,
} from './session-storage-repository';
import { SessionRuntimeStateStore } from './session-runtime-state';
import {
  collectPendingRunClosureSignal,
  cloneRenderItems,
} from './session-render-model';
import {
  cloneSessionRuntimeState,
} from './session-state-model';
import {
  clampWindowState,
  cloneSessionWindowState,
  createLatestWindowState,
} from './session-window-model';
import type {
  CommittedSessionTransition,
  SessionPromptMediaPayload,
  SessionRuntimeTimelineState,
} from './session-runtime-types';
import {
  normalizeString,
} from './session-value-normalization';
import { SessionTranscriptTimelineLoader } from './session-transcript-timeline-loader';
import { SessionExecutionGraphRuntime } from './session-execution-graph-runtime';
import {
  closeMissingToolResultsForRun,
} from './tool/tool-card-terminal';
import type { SessionToolStatusUpdateIngressEvent } from './gateway-ingress-types';
import type { RuntimeClockPort } from '../common/runtime-ports';

export interface SessionTimelineRuntimeDeps {
  stateStore: SessionRuntimeStateStore;
  sessionStorage: SessionStoragePort;
  transcriptLoader: SessionTranscriptTimelineLoader;
  executionGraphRuntime: SessionExecutionGraphRuntime;
  clock: RuntimeClockPort;
}

export class SessionTimelineRuntime {
  constructor(private readonly deps: SessionTimelineRuntimeDeps) {}

  async findStorageDescriptor(sessionKey: string): Promise<SessionStorageDescriptor | null> {
    return await this.deps.sessionStorage.findStorageDescriptor(sessionKey);
  }

  private getSessionState(sessionKey: string): SessionRuntimeTimelineState {
    return this.deps.stateStore.getSessionState(sessionKey);
  }

  private touchSessionStateMeta(
    state: SessionRuntimeTimelineState,
    options: {
      advanceRunEpoch?: boolean;
    } = {},
  ): void {
    if (options.advanceRunEpoch) {
      state.runEpoch += 1;
    }
    state.runtime = {
      ...state.runtime,
      updatedAt: this.deps.clock.nowMs(),
    };
  }

  private readRuntimePatch(
    patch: Partial<SessionRuntimeStateSnapshot>,
  ): Partial<SessionRuntimeStateSnapshot> {
    const {
      updatedAt: _updatedAt,
      ...runtimePatch
    } = patch;
    void _updatedAt;
    return runtimePatch;
  }

  private cloneCommittedSessionState(state: SessionRuntimeTimelineState): SessionRuntimeTimelineState {
    return {
      sessionKey: state.sessionKey,
      runEpoch: state.runEpoch,
      timelineEntries: structuredClone(state.timelineEntries),
      executionGraphItems: structuredClone(state.executionGraphItems),
      renderItems: cloneRenderItems(state.renderItems),
      taskSnapshot: state.taskSnapshot ? structuredClone(state.taskSnapshot) : null,
      hydrated: state.hydrated,
      runtime: cloneSessionRuntimeState(state.runtime),
      window: cloneSessionWindowState(state.window),
      activeTransportEpoch: state.activeTransportEpoch,
    };
  }

  private async ensureSessionHydrated(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): Promise<void> {
    if (state.hydrated) {
      return;
    }

    const replay = await this.deps.transcriptLoader.readTimelineReplay(sessionKey);
    state.timelineEntries = mergeTimelineEntries(
      state.timelineEntries,
      replay.timelineEntries,
    );
    if (replay.taskSnapshot) {
      state.taskSnapshot = replay.taskSnapshot;
    }
    state.hydrated = true;
    this.deps.executionGraphRuntime.rebuildFromTimeline(sessionKey, state);
    state.window = state.window.isAtLatest && state.window.windowStartOffset === 0
      ? createLatestWindowState(state.renderItems.length)
      : clampWindowState(state.window, state.renderItems.length);
    this.deps.executionGraphRuntime.refreshParents(sessionKey);
  }

  async hydrateSession(
    sessionKey: string,
  ): Promise<SessionRuntimeTimelineState> {
    await this.deps.stateStore.ready();
    const state = this.getSessionState(sessionKey);
    await this.ensureSessionHydrated(sessionKey, state);
    this.deps.executionGraphRuntime.refreshRenderItems(state);
    state.window = state.window.isAtLatest && state.window.windowStartOffset === 0
      ? createLatestWindowState(state.renderItems.length)
      : clampWindowState(state.window, state.renderItems.length);
    this.deps.stateStore.persistStore();
    return state;
  }

  async reconcileSessionTranscript(
    sessionKey: string,
  ): Promise<void> {
    const state = this.getSessionState(sessionKey);
    if (!state.hydrated) {
      await this.ensureSessionHydrated(sessionKey, state);
      return;
    }
    const closureSignal = collectPendingRunClosureSignal(state.renderItems, state.runtime);
    if (
      isRunActive(state.runtime)
      && !closureSignal.hasActiveAssistantStream
      && !closureSignal.hasBlockingToolActivity
      && closureSignal.hasFinalAssistantTurn
    ) {
      this.commitSessionTransition(sessionKey, {
        runtimePatch: this.buildTerminalRuntimePatch('done', null, null),
        activeTransportEpoch: null,
        advanceRunEpoch: true,
      });
    }
    state.window = state.window.isAtLatest
      ? createLatestWindowState(state.renderItems.length)
      : clampWindowState(state.window, state.renderItems.length);
    this.deps.executionGraphRuntime.refreshParents(sessionKey);
    this.deps.stateStore.persistStore();
  }

  async reconcileSessionTranscriptContent(
    sessionKey: string,
  ): Promise<CommittedSessionTransition> {
    await this.deps.stateStore.ready();
    const state = this.getSessionState(sessionKey);
    const replay = await this.deps.transcriptLoader.readTimelineReplay(sessionKey);
    state.hydrated = true;
    const committed = this.commitSessionTransition(sessionKey, {
      timelineEntries: replay.timelineEntries,
      ...(replay.taskSnapshot ? { taskSnapshot: replay.taskSnapshot } : {}),
      resetWindowToLatest: state.window.isAtLatest,
    });
    const closureSignal = collectPendingRunClosureSignal(committed.state.renderItems, committed.state.runtime);
    if (
      isRunActive(committed.runtime)
      && !closureSignal.hasActiveAssistantStream
      && !closureSignal.hasBlockingToolActivity
      && closureSignal.hasFinalAssistantTurn
    ) {
      const closed = this.commitSessionTransition(sessionKey, {
        runtimePatch: this.buildTerminalRuntimePatch('done', null, null),
        activeTransportEpoch: null,
        advanceRunEpoch: true,
      });
      return {
        ...closed,
        mergedEntries: committed.mergedEntries,
      };
    }
    return committed;
  }

  async reconcileTranscriptToolResults(
    sessionKey: string,
  ): Promise<SessionTimelineAssistantTurnEntry[]> {
    const state = this.getSessionState(sessionKey);
    const replay = await this.deps.transcriptLoader.readTimelineReplay(sessionKey);
    const result = applyTranscriptToolResultUpdates(state.timelineEntries, replay.timelineEntries);
    if (result.updatedEntries.length === 0) {
      return [];
    }
    state.timelineEntries = result.entries;
    this.deps.executionGraphRuntime.rebuildFromTimeline(sessionKey, state);
    this.deps.executionGraphRuntime.refreshRenderItems(state);
    state.window = state.window.isAtLatest
      ? createLatestWindowState(state.renderItems.length)
      : clampWindowState(state.window, state.renderItems.length);
    this.deps.executionGraphRuntime.refreshParents(sessionKey);
    this.touchSessionStateMeta(state);
    this.deps.stateStore.persistStore();
    return result.updatedEntries;
  }

  async reconcileTurnToolResults(
    request: SessionTurnToolResultsRequest,
  ): Promise<SessionTurnToolResultsResult> {
    const sessionKey = normalizeString(request.sessionKey);
    const state = this.getSessionState(sessionKey);
    const replay = await this.deps.transcriptLoader.readTimelineReplay(sessionKey);
    const result = applyTranscriptToolResultUpdates(state.timelineEntries, replay.timelineEntries);
    const updatedEntry = this.resolveTurnToolResultEntry(result.updatedEntries, request);
    const nextEntries = updatedEntry
      ? result.entries
      : mergeTimelineEntries(state.timelineEntries, replay.timelineEntries);
    state.timelineEntries = nextEntries;
    state.hydrated = true;
    this.deps.executionGraphRuntime.rebuildFromTimeline(sessionKey, state);
    this.deps.executionGraphRuntime.refreshRenderItems(state);
    state.window = state.window.isAtLatest
      ? createLatestWindowState(state.renderItems.length)
      : clampWindowState(state.window, state.renderItems.length);
    this.deps.executionGraphRuntime.refreshParents(sessionKey);
    this.touchSessionStateMeta(state);
    this.deps.stateStore.persistStore();
    const closure = this.reconcileRunClosureFromState(state, request);
    const item = updatedEntry
      ? assembleAuthoritativeAssistantTurns({
          sessionKey,
          timelineEntries: [updatedEntry],
          runtime: state.runtime,
        }).itemsByEntryKey.get(updatedEntry.key) ?? null
      : null;
    return {
      sessionKey,
      turnKey: updatedEntry?.turnKey ?? closure.turnKey,
      item,
      runtime: cloneSessionRuntimeState(state.runtime),
    };
  }

  async reconcileRunClosure(
    request: SessionRunClosureRequest,
  ): Promise<SessionRunClosureResult> {
    const sessionKey = normalizeString(request.sessionKey);
    const state = this.getSessionState(sessionKey);
    const replay = await this.deps.transcriptLoader.readTimelineReplay(sessionKey);
    state.timelineEntries = mergeTimelineEntries(state.timelineEntries, replay.timelineEntries);
    state.hydrated = true;
    this.deps.executionGraphRuntime.rebuildFromTimeline(sessionKey, state);
    this.deps.executionGraphRuntime.refreshRenderItems(state);
    state.window = state.window.isAtLatest
      ? createLatestWindowState(state.renderItems.length)
      : clampWindowState(state.window, state.renderItems.length);
    this.deps.executionGraphRuntime.refreshParents(sessionKey);
    return this.reconcileRunClosureFromState(state, request);
  }

  private reconcileRunClosureFromState(
    state: SessionRuntimeTimelineState,
    request: SessionRunClosureRequest,
  ): SessionRunClosureResult {
    const sessionKey = normalizeString(request.sessionKey);
    const runtime = state.runtime;
    const runId = normalizeString(request.runId) || runtime.activeRunId;
    const turnKey = normalizeString(request.turnKey) || runtime.pendingTurnKey;
    if (!isRunActive(runtime)) {
      return {
        sessionKey,
        runId,
        turnKey,
        closed: false,
        reason: 'not-active',
        runtime: cloneSessionRuntimeState(runtime),
      };
    }
    const signal = collectPendingRunClosureSignal(state.renderItems, {
      ...runtime,
      activeRunId: runId,
      pendingTurnKey: turnKey,
    });
    if (signal.hasActiveAssistantStream) {
      return {
        sessionKey,
        runId,
        turnKey,
        closed: false,
        reason: 'still-streaming',
        runtime: cloneSessionRuntimeState(runtime),
      };
    }
    if (signal.hasBlockingToolActivity) {
      return {
        sessionKey,
        runId,
        turnKey,
        closed: false,
        reason: 'running-tool',
        runtime: cloneSessionRuntimeState(runtime),
      };
    }
    if (!signal.hasMatchingRunEvidence || !signal.hasFinalAssistantTurn) {
      return {
        sessionKey,
        runId,
        turnKey,
        closed: false,
        reason: 'not-found',
        runtime: cloneSessionRuntimeState(runtime),
      };
    }
    const committed = this.commitSessionTransition(sessionKey, {
      runtimePatch: this.buildTerminalRuntimePatch('done', null, null),
      activeTransportEpoch: null,
      advanceRunEpoch: true,
    });
    return {
      sessionKey,
      runId,
      turnKey,
      closed: true,
      reason: 'final-assistant-turn',
      runtime: committed.runtime,
    };
  }

  private resolveTurnToolResultEntry(
    entries: SessionTimelineAssistantTurnEntry[],
    request: SessionTurnToolResultsRequest,
  ): SessionTimelineAssistantTurnEntry | null {
    const turnKey = normalizeString(request.turnKey);
    const runId = normalizeString(request.runId);
    const toolCallIds = new Set((request.toolCallIds ?? []).map(normalizeString).filter(Boolean));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (turnKey && entry.turnKey !== turnKey) {
        continue;
      }
      if (runId && entry.runId !== runId) {
        continue;
      }
      if (toolCallIds.size > 0 && !entry.segments.some((segment) => (
        segment.kind === 'tool'
        && (
          toolCallIds.has(segment.tool.toolCallId ?? '')
          || toolCallIds.has(segment.tool.id)
        )
      ))) {
        continue;
      }
      return entry;
    }
    return null;
  }

  async activateSession(
    sessionKey: string,
    options: {
      hydrate?: boolean;
      resetWindowToLatest?: boolean;
    } = {},
  ): Promise<SessionRuntimeTimelineState> {
    await this.deps.stateStore.ready();
    const state = this.getSessionState(sessionKey);
    const previousWindow = cloneSessionWindowState(state.window);
    this.deps.stateStore.setActiveSessionKey(sessionKey);
    this.deps.executionGraphRuntime.refreshRenderItems(state);
    if (options.resetWindowToLatest) {
      state.window = createLatestWindowState(state.renderItems.length);
    } else if (previousWindow.totalItemCount > 0) {
      state.window = clampWindowState(previousWindow, state.renderItems.length);
    }
    this.deps.stateStore.persistStore();
    return state;
  }

  private upsertTimelineEntriesIntoState(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    entries: SessionTimelineEntry[],
  ): SessionTimelineEntry[] {
    const mergedEntries: SessionTimelineEntry[] = [];
    let touchedExecutionGraphs = false;
    for (const entry of entries) {
      state.timelineEntries = upsertTimelineEntry(state.timelineEntries, entry);
      const mergedIndex = findTimelineEntryIndex(state.timelineEntries, entry);
      if (mergedIndex >= 0) {
        const mergedEntry = structuredClone(state.timelineEntries[mergedIndex]!);
        mergedEntries.push(mergedEntry);
        if (mergedEntry.kind === 'task-completion') {
          touchedExecutionGraphs = true;
        }
      }
    }
    if (touchedExecutionGraphs) {
      this.deps.executionGraphRuntime.rebuildFromTimeline(sessionKey, state);
    } else {
      this.deps.executionGraphRuntime.refreshExistingGraphs(state);
    }
    return mergedEntries;
  }

  commitSessionTransition(
    sessionKey: string,
    transition: {
      timelineEntries?: SessionTimelineEntry[];
      taskSnapshot?: TaskSnapshotEvent;
      runtimePatch?: Partial<SessionRuntimeStateSnapshot>;
      activeTransportEpoch?: number | null;
      resetWindowToLatest?: boolean;
      advanceRunEpoch?: boolean;
    },
  ): CommittedSessionTransition {
    const state = this.getSessionState(sessionKey);
    const mergedEntries = transition.timelineEntries
      ? this.upsertTimelineEntriesIntoState(sessionKey, state, transition.timelineEntries)
      : [];
    if (transition.taskSnapshot) {
      state.taskSnapshot = structuredClone(transition.taskSnapshot);
    }
    if (transition.activeTransportEpoch !== undefined) {
      state.activeTransportEpoch = transition.activeTransportEpoch;
    }
    if (transition.runtimePatch) {
      state.runtime = {
        ...state.runtime,
        ...this.readRuntimePatch(transition.runtimePatch),
      };
      if (!transition.timelineEntries || transition.timelineEntries.length === 0) {
        this.deps.executionGraphRuntime.refreshRenderItems(state);
      }
    }
    if (transition.runtimePatch || !transition.timelineEntries || transition.timelineEntries.length === 0) {
      this.deps.executionGraphRuntime.refreshExistingGraphs(state);
    }
    state.window = createLatestWindowState(state.renderItems.length);
    this.deps.executionGraphRuntime.refreshParents(sessionKey);
    if (
      mergedEntries.length > 0
      || transition.taskSnapshot
      || transition.runtimePatch
      || transition.activeTransportEpoch !== undefined
    ) {
      this.touchSessionStateMeta(state, {
        advanceRunEpoch: transition.advanceRunEpoch,
      });
    }
    if (transition.resetWindowToLatest) {
      state.window = createLatestWindowState(state.renderItems.length);
    }
    this.deps.stateStore.persistStore();
    return {
      state: this.cloneCommittedSessionState(state),
      runtime: cloneSessionRuntimeState(state.runtime),
      mergedEntries,
    };
  }

  applyToolStatus(
    sessionKey: string,
    update: SessionToolStatusUpdateIngressEvent,
  ): SessionTimelineEntry | null {
    const state = this.getSessionState(sessionKey);
    const previousEntries = state.timelineEntries;
    const nextEntries = applyToolStatusUpdate(previousEntries, update);
    if (nextEntries === previousEntries) {
      return null;
    }
    state.timelineEntries = nextEntries;

    // tool start：进入 waiting_tool；result 且无任何 running tool：回到 streaming。
    if (update.phase === 'start' && isRunActive(state.runtime)) {
      state.runtime = {
        ...state.runtime,
        runPhase: 'waiting_tool',
      };
    } else if (update.phase === 'result' && state.runtime.runPhase === 'waiting_tool') {
      const hasRunningTools = nextEntries.some((entry) => (
        entry.kind === 'assistant-turn'
        && entry.segments.some((s) => s.kind === 'tool' && s.tool.status === 'running')
      ));
      if (!hasRunningTools) {
        state.runtime = {
          ...state.runtime,
          runPhase: 'streaming',
        };
      }
    }

    this.deps.executionGraphRuntime.refreshExistingGraphs(state);
    state.window = createLatestWindowState(state.renderItems.length);
    this.touchSessionStateMeta(state);
    this.deps.stateStore.persistStore();
    for (let index = nextEntries.length - 1; index >= 0; index -= 1) {
      const entry = nextEntries[index];
      if (entry?.kind !== 'assistant-turn') {
        continue;
      }
      for (const segment of entry.segments) {
        if (segment.kind === 'tool' && (segment.tool.toolCallId === update.toolCallId || segment.tool.id === update.toolCallId)) {
          return structuredClone(entry);
        }
      }
    }
    return null;
  }

  bindSubmittedRunId(
    sessionKey: string,
    input: {
      submittedRunId: string;
      gatewayRunId: string;
    },
  ): void {
    const submittedRunId = normalizeString(input.submittedRunId);
    const gatewayRunId = normalizeString(input.gatewayRunId);
    if (!submittedRunId || !gatewayRunId || submittedRunId === gatewayRunId) {
      return;
    }
    const state = this.getSessionState(sessionKey);
    if (state.runtime.activeRunId !== submittedRunId || state.runtime.pendingTurnKey !== submittedRunId) {
      return;
    }
    this.deps.stateStore.bindRunAlias(sessionKey, submittedRunId, gatewayRunId);
  }

  applyRuntimeActivity(
    sessionKey: string,
    input: {
      activity: 'compacting';
      phase: 'started' | 'completed';
      runId: string | null;
    },
  ): CommittedSessionTransition {
    const state = this.getSessionState(sessionKey);
    const isCurrentRun = !input.runId
      || !state.runtime.activeRunId
      || state.runtime.activeRunId === input.runId;
    if (!isCurrentRun || !isRunActive(state.runtime)) {
      return this.commitSessionTransition(sessionKey, {});
    }
    return this.commitSessionTransition(sessionKey, {
      runtimePatch: {
        runtimeActivity: input.phase === 'started' ? input.activity : null,
      },
    });
  }

  updateTaskSnapshot(
    sessionKey: string,
    taskSnapshot: TaskSnapshotEvent,
  ): void {
    this.commitSessionTransition(sessionKey, { taskSnapshot });
  }

  buildTerminalRuntimePatch(
    runPhase: SessionRunPhase,
    lastError: string | null,
    lastIssue: GatewayTransportIssue | null,
  ): Partial<SessionRuntimeStateSnapshot> {
    return {
      activeRunId: null,
      runPhase,
      activeTurnItemKey: null,
      pendingTurnKey: null,
      runtimeActivity: null,
      lastError,
      lastIssue,
    };
  }

  closeMissingToolResultsForRun(
    sessionKey: string,
    runId: string | null,
  ): void {
    const state = this.getSessionState(sessionKey);
    state.timelineEntries = closeMissingToolResultsForRun(state.timelineEntries, runId);
    this.deps.executionGraphRuntime.rebuildFromTimeline(sessionKey, state);
    this.deps.executionGraphRuntime.refreshRenderItems(state);
  }

  clearSessionRuntimeErrorState(sessionKey: string): SessionRuntimeStateSnapshot {
    const state = this.getSessionState(sessionKey);
    return this.commitSessionTransition(sessionKey, {
      runtimePatch: {
        runPhase: state.runtime.runPhase === 'error' ? 'idle' : state.runtime.runPhase,
        lastError: null,
        lastIssue: null,
      },
    }).runtime;
  }

  async resolveLifecycleRuntime(
    sessionKey: string,
    input: {
      phase: 'started' | 'final' | 'error' | 'aborted' | 'unknown';
      runId: string | null;
      error?: string | null;
      transportIssue?: GatewayTransportIssue | null;
    },
  ): Promise<SessionRuntimeStateSnapshot> {
    switch (input.phase) {
      case 'started':
        return this.commitSessionTransition(sessionKey, {
          runtimePatch: {
            activeRunId: input.runId,
            runPhase: 'submitted',
            pendingTurnKey: input.runId ? input.runId : this.getSessionState(sessionKey).runtime.pendingTurnKey,
            pendingTurnLaneKey: 'main',
            lastError: null,
            lastIssue: null,
            runtimeActivity: null,
          },
          activeTransportEpoch: this.deps.stateStore.getLatestConnectedTransportEpoch() || 1,
          advanceRunEpoch: !isRunActive(this.getSessionState(sessionKey).runtime),
        }).runtime;
      case 'final':
        this.closeMissingToolResultsForRun(sessionKey, input.runId);
        return this.commitSessionTransition(sessionKey, {
          runtimePatch: this.buildTerminalRuntimePatch('done', null, null),
          activeTransportEpoch: null,
          advanceRunEpoch: true,
        }).runtime;
      case 'error':
        this.closeMissingToolResultsForRun(sessionKey, input.runId);
        return this.commitSessionTransition(sessionKey, {
          runtimePatch: this.buildTerminalRuntimePatch('error', input.error ?? null, input.transportIssue ?? null),
          activeTransportEpoch: null,
          advanceRunEpoch: true,
        }).runtime;
      case 'aborted':
        this.deps.stateStore.blockRun(sessionKey, input.runId);
        this.closeMissingToolResultsForRun(sessionKey, input.runId);
        return this.commitSessionTransition(sessionKey, {
          runtimePatch: this.buildTerminalRuntimePatch('aborted', input.error ?? null, input.transportIssue ?? null),
          activeTransportEpoch: null,
          advanceRunEpoch: true,
        }).runtime;
      default:
        return cloneSessionRuntimeState(this.getSessionState(sessionKey).runtime);
    }
  }

  resolveMessageRuntimePatch(
    currentState: SessionRuntimeTimelineState,
    input: {
      runId: string | null;
      entry: SessionTimelineEntry;
      sessionUpdate: 'agent_message_chunk' | 'agent_message';
    },
  ): {
    runtimePatch: Partial<SessionRuntimeStateSnapshot>;
    advanceRunEpoch?: boolean;
  } | null {
    const messageTimestamp = input.entry.createdAt != null ? input.entry.createdAt : null;
    if (input.sessionUpdate === 'agent_message_chunk') {
      const anchorItemKey = resolveAssistantTurnItemKeyFromTimelineEntry(input.entry);
      return {
        runtimePatch: {
          activeRunId: input.runId,
          runPhase: 'streaming',
          activeTurnItemKey: anchorItemKey
            ?? currentState.runtime.activeTurnItemKey,
          pendingTurnKey: normalizeString(input.entry.turnKey) || currentState.runtime.pendingTurnKey,
          pendingTurnLaneKey: normalizeString(input.entry.laneKey) || currentState.runtime.pendingTurnLaneKey,
          lastError: null,
          lastIssue: null,
          runtimeActivity: null,
          lastUserMessageAt: input.entry.role === 'user' && typeof messageTimestamp === 'number'
            ? messageTimestamp
            : currentState.runtime.lastUserMessageAt,
        },
      };
    }

    if (input.entry.role === 'user') {
      return {
        runtimePatch: {
          activeRunId: input.runId,
          runPhase: input.runId ? 'submitted' : currentState.runtime.runPhase,
          pendingTurnKey: input.runId ? input.runId : currentState.runtime.pendingTurnKey,
          pendingTurnLaneKey: input.runId ? 'main' : currentState.runtime.pendingTurnLaneKey,
          lastError: null,
          lastIssue: null,
          runtimeActivity: null,
          lastUserMessageAt: typeof messageTimestamp === 'number'
            ? messageTimestamp
            : currentState.runtime.lastUserMessageAt,
        },
      };
    }

    return {
      runtimePatch: {
        activeRunId: null,
        runPhase: input.entry.status === 'error'
          ? 'error'
          : (input.entry.status === 'aborted' ? 'aborted' : 'done'),
        activeTurnItemKey: null,
        pendingTurnKey: null,
        pendingTurnLaneKey: null,
        lastError: input.entry.status === 'error'
          ? (input.entry.text.trim() || currentState.runtime.lastError)
          : null,
        lastIssue: null,
        runtimeActivity: null,
      },
      advanceRunEpoch: true,
    };
  }

  buildPromptUserEntry(input: {
    sessionKey: string;
    runId: string;
    message: string;
    media?: SessionPromptMediaPayload[];
  }): SessionTimelineEntry {
    const state = this.getSessionState(input.sessionKey);
    const timestamp = this.deps.clock.nowMs();
    const message: SessionTranscriptMessage = {
      role: 'user',
      content: input.message || (input.media && input.media.length > 0 ? '(file attached)' : ''),
      id: input.runId,
      status: 'sending',
      timestamp,
      ...(input.media && input.media.length > 0
        ? {
            _attachedFiles: input.media.map((item) => ({
              fileName: item.fileName,
              mimeType: item.mimeType,
              fileSize: item.fileSize,
              preview: item.preview ?? null,
              filePath: item.filePath,
            })),
          }
        : {}),
    };
    return buildTimelineEntriesFromTranscriptMessage(input.sessionKey, message, {
      runId: input.runId,
      index: state.timelineEntries.length,
      status: 'pending',
      existingRows: state.timelineEntries,
    })[0]!;
  }
}
