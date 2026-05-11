import type {
  SessionRuntimeStateSnapshot,
  SessionTimelineEntry,
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
  SessionPromptMediaPayload,
  SessionRuntimeTimelineState,
} from './session-runtime-types';
import {
  normalizeString,
} from './session-value-normalization';
import { SessionTranscriptTimelineLoader } from './session-transcript-timeline-loader';
import { SessionExecutionGraphRuntime } from './session-execution-graph-runtime';
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

  private async ensureSessionHydrated(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): Promise<void> {
    if (state.hydrated) {
      return;
    }

    state.timelineEntries = mergeTimelineEntries(
      state.timelineEntries,
      await this.deps.transcriptLoader.readTimelineEntries(sessionKey),
    );
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
      this.resetPendingRunState(sessionKey, {
        runPhase: 'done',
        lastError: null,
        lastIssue: null,
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

  upsertTimelineEntries(sessionKey: string, entries: SessionTimelineEntry[]): SessionTimelineEntry[] {
    const state = this.getSessionState(sessionKey);
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
    state.window = createLatestWindowState(state.renderItems.length);
    this.deps.executionGraphRuntime.refreshParents(sessionKey);
    this.deps.stateStore.persistStore();
    return mergedEntries;
  }

  setSessionRuntime(
    sessionKey: string,
    patch: Partial<SessionRuntimeStateSnapshot>,
  ): SessionRuntimeStateSnapshot {
    const state = this.getSessionState(sessionKey);
    state.runtime = {
      ...state.runtime,
      ...patch,
      updatedAt: this.deps.clock.nowMs(),
    };
    this.deps.executionGraphRuntime.refreshExistingGraphs(state);
    this.deps.stateStore.persistStore();
    return cloneSessionRuntimeState(state.runtime);
  }

  resetPendingRunState(
    sessionKey: string,
    patch: Pick<SessionRuntimeStateSnapshot, 'runPhase' | 'lastError' | 'lastIssue'>,
  ): SessionRuntimeStateSnapshot {
    const state = this.getSessionState(sessionKey);
    state.activeTransportEpoch = null;
    return this.setSessionRuntime(sessionKey, {
      sending: false,
      activeRunId: null,
      runPhase: patch.runPhase,
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      pendingFinal: false,
      lastError: patch.lastError,
      lastIssue: patch.lastIssue,
    });
  }

  clearSessionRuntimeErrorState(sessionKey: string): SessionRuntimeStateSnapshot {
    const state = this.getSessionState(sessionKey);
    return this.setSessionRuntime(sessionKey, {
      runPhase: state.runtime.runPhase === 'error' ? 'idle' : state.runtime.runPhase,
      lastError: null,
      lastIssue: null,
    });
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
        this.getSessionState(sessionKey).activeTransportEpoch = this.deps.stateStore.getLatestConnectedTransportEpoch() || 1;
        return this.setSessionRuntime(sessionKey, {
          sending: true,
          activeRunId: input.runId,
          runPhase: 'submitted',
          pendingTurnKey: input.runId ? `main:${input.runId}` : this.getSessionState(sessionKey).runtime.pendingTurnKey,
          pendingTurnLaneKey: 'main',
          lastError: null,
          lastIssue: null,
        });
      case 'final':
        return this.resetPendingRunState(sessionKey, {
          runPhase: 'done',
          lastError: null,
          lastIssue: null,
        });
      case 'error':
        return this.resetPendingRunState(sessionKey, {
          runPhase: 'error',
          lastError: input.error ?? null,
          lastIssue: input.transportIssue ?? null,
        });
      case 'aborted':
        return this.resetPendingRunState(sessionKey, {
          runPhase: 'aborted',
          lastError: input.error ?? null,
          lastIssue: input.transportIssue ?? null,
        });
      default:
        return cloneSessionRuntimeState(this.getSessionState(sessionKey).runtime);
    }
  }

  resolveMessageRuntime(
    sessionKey: string,
    input: {
      runId: string | null;
      entry: SessionTimelineEntry;
      sessionUpdate: 'agent_message_chunk' | 'agent_message';
    },
  ): SessionRuntimeStateSnapshot {
    const currentState = this.getSessionState(sessionKey);
    const messageTimestamp = input.entry.createdAt != null ? input.entry.createdAt : null;
    if (input.sessionUpdate === 'agent_message_chunk') {
      const anchorItemKey = resolveAssistantTurnItemKeyFromTimelineEntry(input.entry);
      return this.setSessionRuntime(sessionKey, {
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
      });
    }

    if (input.entry.role === 'user') {
      return this.setSessionRuntime(sessionKey, {
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
      });
    }

    if (input.entry.kind === 'tool-activity' && input.entry.status !== 'streaming') {
      return this.setSessionRuntime(sessionKey, {
        sending: true,
        activeRunId: input.runId,
        runPhase: 'waiting_tool',
        activeTurnItemKey: null,
        pendingTurnKey: normalizeString(input.entry.turnKey) || currentState.runtime.pendingTurnKey,
        pendingTurnLaneKey: normalizeString(input.entry.laneKey) || currentState.runtime.pendingTurnLaneKey,
        pendingFinal: true,
        lastError: null,
        lastIssue: null,
      });
    }

    return this.resetPendingRunState(sessionKey, {
      runPhase: input.entry.status === 'error'
        ? 'error'
        : (input.entry.status === 'aborted' ? 'aborted' : 'done'),
      lastError: input.entry.status === 'error'
        ? (input.entry.text.trim() || currentState.runtime.lastError)
        : null,
      lastIssue: null,
    });
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
