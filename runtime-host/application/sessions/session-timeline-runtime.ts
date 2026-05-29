import {
  type SessionStoragePort,
  type SessionStorageDescriptor,
} from './session-storage-repository';
import { SessionRuntimeStateStore } from './session-runtime-state';
import type { CanonicalSessionEvent } from './canonical/canonical-events';
import { reduceCanonicalSessionEvents } from './canonical/canonical-reducer';
import { buildProjectedCanonicalSessionState, buildRenderItemIndexByKey } from './canonical/canonical-projection';
import { cloneCanonicalSessionState } from './canonical/canonical-state';
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
  SessionRuntimeTimelineState,
} from './session-runtime-types';
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

  private cloneCommittedSessionState(state: SessionRuntimeTimelineState): SessionRuntimeTimelineState {
    return {
      sessionKey: state.sessionKey,
      runEpoch: state.runEpoch,
      canonical: cloneCanonicalSessionState(state.canonical),
      timelineEntries: state.timelineEntries,
      executionGraphItems: state.executionGraphItems,
      renderItems: state.renderItems,
      renderItemIndexByKey: new Map(state.renderItemIndexByKey),
      renderItemKeyIndex: {
        messageItemKeyByCanonicalKey: new Map(state.renderItemKeyIndex.messageItemKeyByCanonicalKey),
        toolItemKeyByCanonicalKey: new Map(state.renderItemKeyIndex.toolItemKeyByCanonicalKey),
      },
      taskSnapshot: state.taskSnapshot,
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

    if (state.renderItems.length === 0 && state.canonical.messages.length === 0) {
      const replayEvents = await this.deps.transcriptLoader.readCanonicalReplayEvents(sessionKey);
      const committedEvents = reduceCanonicalSessionEvents(state.canonical, replayEvents);
      if (committedEvents.length > 0) {
        this.projectCanonicalState(sessionKey, state);
      }
    }

    state.hydrated = true;
    state.canonical.hydrated = true;
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

  private projectCanonicalState(sessionKey: string, state: SessionRuntimeTimelineState): void {
    const projection = buildProjectedCanonicalSessionState(state.canonical);
    state.timelineEntries = projection.timelineEntries;
    state.executionGraphItems = projection.executionGraphItems;
    state.renderItems = projection.renderItems;
    state.renderItemIndexByKey = projection.renderItemIndexByKey;
    state.renderItemKeyIndex = projection.renderItemKeyIndex;
    state.taskSnapshot = state.canonical.taskSnapshot;
    state.runtime = cloneSessionRuntimeState(state.canonical.runtime);
    state.window = createLatestWindowState(state.renderItems.length);
    this.deps.stateStore.updateExecutionGraphDependencyIndex(sessionKey, state.executionGraphItems);
    this.deps.executionGraphRuntime.refreshParents(sessionKey);
  }

  private projectCanonicalRuntimeState(state: SessionRuntimeTimelineState): void {
    state.runtime = cloneSessionRuntimeState(state.canonical.runtime);
    state.taskSnapshot = state.canonical.taskSnapshot;
    state.renderItemIndexByKey = buildRenderItemIndexByKey(state.renderItems);
  }

  private shouldProjectRenderState(events: readonly CanonicalSessionEvent[]): boolean {
    return events.some((event) => event.type !== 'control' && event.type !== 'runtime_activity');
  }

  appendCanonicalEvents(
    sessionKey: string,
    events: readonly CanonicalSessionEvent[],
  ): CommittedSessionTransition {
    const state = this.getSessionState(sessionKey);
    const committedEvents = reduceCanonicalSessionEvents(state.canonical, events);
    if (committedEvents.length === 0) {
      return {
        state: this.cloneCommittedSessionState(state),
        runtime: cloneSessionRuntimeState(state.runtime),
        mergedEntries: state.timelineEntries,
      };
    }
    if (this.shouldProjectRenderState(committedEvents)) {
      this.projectCanonicalState(sessionKey, state);
    } else {
      this.projectCanonicalRuntimeState(state);
    }
    this.touchSessionStateMeta(state, { advanceRunEpoch: committedEvents.some((event) => event.type === 'lifecycle') });
    this.deps.stateStore.persistStore();
    return {
      state: this.cloneCommittedSessionState(state),
      runtime: cloneSessionRuntimeState(state.runtime),
      mergedEntries: state.timelineEntries,
    };
  }

}
