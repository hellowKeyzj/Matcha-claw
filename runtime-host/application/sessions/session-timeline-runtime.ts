import type {
  SessionRuntimeStateSnapshot,
  SessionTimelineEntry,
  TaskSnapshotEvent,
} from '../../shared/session-adapter-types';
import type { GatewayTransportIssue } from '../../shared/gateway-error';
import {
  buildTimelineEntriesFromTranscriptMessage,
} from './transcript-timeline-materializer';
import type { SessionTranscriptMessage } from './transcript-types';
import {
  resolveAssistantTurnItemKeyFromTimelineEntry,
} from './assistant-turn-assembler';
import {
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

  private commitStateRevision(
    state: SessionRuntimeTimelineState,
    options: {
      advanceRunEpoch?: boolean;
    } = {},
  ): void {
    state.revision += 1;
    if (options.advanceRunEpoch) {
      state.runEpoch += 1;
    }
    state.runtime = {
      ...state.runtime,
      revision: state.revision,
      runEpoch: state.runEpoch,
      updatedAt: this.deps.clock.nowMs(),
    };
  }

  private readRuntimePatch(
    patch: Partial<SessionRuntimeStateSnapshot>,
  ): Partial<SessionRuntimeStateSnapshot> {
    const {
      revision: _revision,
      runEpoch: _runEpoch,
      updatedAt: _updatedAt,
      ...runtimePatch
    } = patch;
    void _revision;
    void _runEpoch;
    void _updatedAt;
    return runtimePatch;
  }

  private cloneCommittedSessionState(state: SessionRuntimeTimelineState): SessionRuntimeTimelineState {
    return {
      sessionKey: state.sessionKey,
      revision: state.revision,
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
    await this.reconcileSessionTranscript(sessionKey);
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
    state.timelineEntries = await this.deps.transcriptLoader.reconcileToolResultPatchEntries({
      sessionKey,
      existingEntries: state.timelineEntries,
    });
    this.deps.executionGraphRuntime.rebuildFromTimeline(sessionKey, state);
    const closureSignal = collectPendingRunClosureSignal(state.renderItems, state.runtime);
    if (
      state.runtime.sending
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
      this.commitStateRevision(state, {
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

  updateTaskSnapshot(
    sessionKey: string,
    taskSnapshot: TaskSnapshotEvent,
  ): void {
    this.commitSessionTransition(sessionKey, { taskSnapshot });
  }

  buildTerminalRuntimePatch(
    runPhase: SessionRuntimeStateSnapshot['runPhase'],
    lastError: string | null,
    lastIssue: GatewayTransportIssue | null,
  ): Partial<SessionRuntimeStateSnapshot> {
    return {
      sending: false,
      activeRunId: null,
      runPhase,
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      pendingFinal: false,
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

  resolveLifecycleRuntime(
    sessionKey: string,
    input: {
      phase: 'started' | 'final' | 'error' | 'aborted' | 'unknown';
      runId: string | null;
      error?: string | null;
      transportIssue?: GatewayTransportIssue | null;
    },
  ): SessionRuntimeStateSnapshot {
    switch (input.phase) {
      case 'started':
        return this.commitSessionTransition(sessionKey, {
          runtimePatch: {
            sending: true,
            activeRunId: input.runId,
            runPhase: 'submitted',
            pendingTurnKey: input.runId ? `main:${input.runId}` : this.getSessionState(sessionKey).runtime.pendingTurnKey,
            pendingTurnLaneKey: 'main',
            lastError: null,
            lastIssue: null,
          },
          activeTransportEpoch: this.deps.stateStore.getLatestConnectedTransportEpoch() || 1,
          advanceRunEpoch: !this.getSessionState(sessionKey).runtime.sending,
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
          sending: true,
          activeRunId: input.runId,
          runPhase: 'streaming',
          activeTurnItemKey: anchorItemKey
            ?? currentState.runtime.activeTurnItemKey,
          pendingTurnKey: normalizeString(input.entry.turnKey) || currentState.runtime.pendingTurnKey,
          pendingTurnLaneKey: normalizeString(input.entry.laneKey) || currentState.runtime.pendingTurnLaneKey,
          pendingFinal: false,
          lastError: null,
          lastIssue: null,
          lastUserMessageAt: input.entry.role === 'user' && typeof messageTimestamp === 'number'
            ? messageTimestamp
            : currentState.runtime.lastUserMessageAt,
        },
      };
    }

    if (input.entry.role === 'user') {
      return {
        runtimePatch: {
          sending: Boolean(input.runId),
          activeRunId: input.runId,
          runPhase: input.runId ? 'submitted' : currentState.runtime.runPhase,
          pendingTurnKey: input.runId ? `main:${input.runId}` : currentState.runtime.pendingTurnKey,
          pendingTurnLaneKey: input.runId ? 'main' : currentState.runtime.pendingTurnLaneKey,
          lastError: null,
          lastIssue: null,
          lastUserMessageAt: typeof messageTimestamp === 'number'
            ? messageTimestamp
            : currentState.runtime.lastUserMessageAt,
        },
      };
    }

    if (input.entry.kind === 'tool-activity' && input.entry.status !== 'streaming') {
      return {
        runtimePatch: {
          sending: true,
          activeRunId: input.runId,
          runPhase: 'waiting_tool',
          activeTurnItemKey: null,
          pendingTurnKey: normalizeString(input.entry.turnKey) || currentState.runtime.pendingTurnKey,
          pendingTurnLaneKey: normalizeString(input.entry.laneKey) || currentState.runtime.pendingTurnLaneKey,
          pendingFinal: true,
          lastError: null,
          lastIssue: null,
        },
      };
    }

    return {
      runtimePatch: {
        sending: false,
        activeRunId: null,
        runPhase: input.entry.status === 'error'
          ? 'error'
          : (input.entry.status === 'aborted' ? 'aborted' : 'done'),
        activeTurnItemKey: null,
        pendingTurnKey: null,
        pendingTurnLaneKey: null,
        pendingFinal: false,
        lastError: input.entry.status === 'error'
          ? (input.entry.text.trim() || currentState.runtime.lastError)
          : null,
        lastIssue: null,
      },
      advanceRunEpoch: true,
    };
  }

  buildPromptUserEntry(input: {
    sessionKey: string;
    promptId: string;
    message: string;
    media?: SessionPromptMediaPayload[];
  }): SessionTimelineEntry {
    const state = this.getSessionState(input.sessionKey);
    const timestamp = this.deps.clock.nowMs();
    const message: SessionTranscriptMessage = {
      role: 'user',
      content: input.message || (input.media && input.media.length > 0 ? '(file attached)' : ''),
      id: input.promptId,
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
      index: state.timelineEntries.length,
      status: 'pending',
      existingRows: state.timelineEntries,
    })[0]!;
  }
}
