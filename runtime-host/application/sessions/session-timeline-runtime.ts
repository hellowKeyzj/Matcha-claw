import {
  type SessionStoragePort,
  type SessionStorageDescriptor,
} from './session-storage-repository';
import { SessionRuntimeStateStore } from './session-runtime-state';
import type { CanonicalSessionEvent } from './canonical/canonical-events';
import { reduceCanonicalSessionEvent, reduceCanonicalSessionEvents } from './canonical/canonical-reducer';
import {
  buildIncrementalProjectedCanonicalSessionState,
  buildProjectedCanonicalSessionState,
} from './canonical/canonical-projection';
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
import type { RuntimeSessionContext } from '../agent-runtime/contracts/runtime-endpoint-types';

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

  private getSessionState(sessionKey: string, context?: RuntimeSessionContext): SessionRuntimeTimelineState {
    return this.deps.stateStore.getSessionState(sessionKey, context);
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

  private async reduceCanonicalSessionEventsAsync(
    state: SessionRuntimeTimelineState,
    events: AsyncIterable<CanonicalSessionEvent>,
  ): Promise<CanonicalSessionEvent[]> {
    const committedEvents: CanonicalSessionEvent[] = [];
    for await (const event of events) {
      if (reduceCanonicalSessionEvent(state.canonical, event)) {
        committedEvents.push(event);
      }
    }
    return committedEvents;
  }

  private async ensureSessionHydrated(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): Promise<{ projected: boolean }> {
    if (state.hydrated) {
      return { projected: false };
    }

    let projected = false;
    if (state.renderItems.length === 0 && state.canonical.messages.length === 0) {
      const replayEvents = await this.deps.transcriptLoader.readCanonicalReplayEvents(state.canonical.context);
      const committedEvents = Symbol.asyncIterator in Object(replayEvents)
        ? await this.reduceCanonicalSessionEventsAsync(state, replayEvents as AsyncIterable<CanonicalSessionEvent>)
        : reduceCanonicalSessionEvents(state.canonical, replayEvents as Iterable<CanonicalSessionEvent>);
      if (committedEvents.length > 0) {
        this.deps.stateStore.syncTransportIssueIndex(sessionKey, state);
        this.deps.stateStore.syncApprovalAddressIndex(sessionKey, state);
        this.projectCanonicalState(sessionKey, state);
        projected = true;
      }
    }

    state.hydrated = true;
    state.canonical.hydrated = true;
    state.window = state.window.isAtLatest && state.window.windowStartOffset === 0
      ? createLatestWindowState(state.renderItems.length)
      : clampWindowState(state.window, state.renderItems.length);
    if (!projected) {
      this.deps.executionGraphRuntime.refreshParents(sessionKey, state.canonical.context.address);
    }
    return { projected };
  }

  async hydrateSession(
    sessionKey: string,
    context?: RuntimeSessionContext,
  ): Promise<SessionRuntimeTimelineState> {
    await this.deps.stateStore.ready();
    const state = this.deps.stateStore.getSessionState(sessionKey, context);
    const hydration = await this.ensureSessionHydrated(sessionKey, state);
    if (!hydration.projected) {
      this.deps.executionGraphRuntime.refreshRenderItems(state);
    }
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
      context?: RuntimeSessionContext;
    } = {},
  ): Promise<SessionRuntimeTimelineState> {
    await this.deps.stateStore.ready();
    const state = this.deps.stateStore.getSessionState(sessionKey, options.context);
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
    this.deps.stateStore.updateExecutionGraphDependencyIndex(sessionKey, state.canonical.context, state.executionGraphItems);
    this.deps.executionGraphRuntime.refreshParents(sessionKey, state.canonical.context.address);
  }

  private projectIncrementalCanonicalState(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    committedEvents: readonly CanonicalSessionEvent[],
  ): void {
    const projection = buildIncrementalProjectedCanonicalSessionState({
      state: state.canonical,
      committedEvents,
      timelineEntries: state.timelineEntries,
      executionGraphItems: state.executionGraphItems,
    });
    state.timelineEntries = projection.timelineEntries;
    state.executionGraphItems = projection.executionGraphItems;
    state.renderItems = projection.renderItems;
    state.renderItemIndexByKey = projection.renderItemIndexByKey;
    state.renderItemKeyIndex = projection.renderItemKeyIndex;
    state.taskSnapshot = state.canonical.taskSnapshot;
    state.runtime = cloneSessionRuntimeState(state.canonical.runtime);
    state.window = createLatestWindowState(state.renderItems.length);
    this.deps.stateStore.updateExecutionGraphDependencyIndex(sessionKey, state.canonical.context, state.executionGraphItems);
  }

  appendCanonicalEvents(
    sessionKey: string,
    events: readonly CanonicalSessionEvent[],
    context?: RuntimeSessionContext,
  ): CommittedSessionTransition {
    const state = this.getSessionState(sessionKey, context);
    const committedEvents = reduceCanonicalSessionEvents(state.canonical, events);
    if (committedEvents.length === 0) {
      return {
        state,
        runtime: cloneSessionRuntimeState(state.runtime),
        mergedEntries: state.timelineEntries,
      };
    }
    this.deps.stateStore.syncTransportIssueIndex(sessionKey, state);
    this.deps.stateStore.syncApprovalAddressIndex(sessionKey, state);
    this.projectIncrementalCanonicalState(sessionKey, state, committedEvents);
    this.deps.executionGraphRuntime.refreshParents(sessionKey, state.canonical.context.address);
    this.touchSessionStateMeta(state, { advanceRunEpoch: committedEvents.some((event) => event.type === 'lifecycle') });
    this.deps.stateStore.persistStore();
    return {
      state,
      runtime: cloneSessionRuntimeState(state.runtime),
      mergedEntries: state.timelineEntries,
    };
  }

}
