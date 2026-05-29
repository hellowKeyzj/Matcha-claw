import { buildProjectedCanonicalSessionState } from './canonical/canonical-projection';
import {
  clampWindowState,
} from './session-window-model';
import type {
  SessionRuntimeTimelineState,
} from './session-runtime-types';
import { SessionRuntimeStateStore } from './session-runtime-state';

interface SessionExecutionGraphRuntimeDeps {
  stateStore: SessionRuntimeStateStore;
}

export class SessionExecutionGraphRuntime {
  constructor(private readonly deps: SessionExecutionGraphRuntimeDeps) {}

  refreshRenderItems(state: SessionRuntimeTimelineState): void {
    const projection = buildProjectedCanonicalSessionState(state.canonical);
    state.timelineEntries = projection.timelineEntries;
    state.executionGraphItems = projection.executionGraphItems;
    state.renderItems = projection.renderItems;
    state.renderItemIndexByKey = projection.renderItemIndexByKey;
    state.renderItemKeyIndex = projection.renderItemKeyIndex;
    this.deps.stateStore.updateExecutionGraphDependencyIndex(state.sessionKey, state.executionGraphItems);
  }

  refreshParents(childSessionKey: string): void {
    for (const parentSessionKey of this.deps.stateStore.listParentSessionKeys(childSessionKey)) {
      const parentState = this.deps.stateStore.findSessionState(parentSessionKey);
      if (!parentState?.hydrated) {
        continue;
      }
      this.refreshRenderItems(parentState);
      parentState.window = clampWindowState(parentState.window, parentState.renderItems.length);
    }
  }
}
