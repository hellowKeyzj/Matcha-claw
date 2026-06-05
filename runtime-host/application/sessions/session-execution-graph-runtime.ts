import {
  buildProjectedCanonicalSessionState,
  buildRenderProjectionFromTimeline,
} from './canonical/canonical-projection';
import {
  clampWindowState,
} from './session-window-model';
import type {
  SessionRuntimeTimelineState,
} from './session-runtime-types';
import { SessionRuntimeStateStore } from './session-runtime-state';
import type { RuntimeAddress } from '../agent-runtime/contracts/runtime-address';

interface SessionExecutionGraphRuntimeDeps {
  stateStore: SessionRuntimeStateStore;
}

export class SessionExecutionGraphRuntime {
  constructor(private readonly deps: SessionExecutionGraphRuntimeDeps) {}

  refreshProjectedState(state: SessionRuntimeTimelineState): void {
    const projection = buildProjectedCanonicalSessionState(state.canonical);
    state.timelineEntries = projection.timelineEntries;
    state.executionGraphItems = projection.executionGraphItems;
    state.renderItems = projection.renderItems;
    state.renderItemIndexByKey = projection.renderItemIndexByKey;
    state.renderItemKeyIndex = projection.renderItemKeyIndex;
    this.deps.stateStore.updateExecutionGraphDependencyIndex(state.sessionKey, state.canonical.context, state.executionGraphItems);
  }

  refreshRenderItems(state: SessionRuntimeTimelineState): void {
    const projection = buildRenderProjectionFromTimeline({
      state: state.canonical,
      timelineEntries: state.timelineEntries,
      executionGraphItems: state.executionGraphItems,
    });
    state.renderItems = projection.renderItems;
    state.renderItemIndexByKey = projection.renderItemIndexByKey;
    state.renderItemKeyIndex = projection.renderItemKeyIndex;
  }

  refreshParents(childSessionKey: string, runtimeAddress: RuntimeAddress): void {
    for (const parentState of this.deps.stateStore.listParentSessionStates(childSessionKey, runtimeAddress)) {
      if (!parentState.hydrated) {
        continue;
      }
      this.refreshRenderItems(parentState);
      parentState.window = clampWindowState(parentState.window, parentState.renderItems.length);
    }
  }
}
