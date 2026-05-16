import type {
  SessionAssistantTurnItem,
  SessionRenderItem,
  SessionTimelineEntry,
} from '../../shared/session-adapter-types';
import {
  attachExecutionGraphReply,
  createExecutionGraphItem,
  deriveExecutionGraphSteps,
  isTaskCompletionEntry,
  updateExecutionGraphChildSteps,
  updateExecutionGraphMainSteps,
} from './execution-graphs';
import {
  buildRenderItemsFromTimeline,
} from './session-render-model';
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

  private resolveChildTimelineEntries(childSessionKey: string): SessionTimelineEntry[] {
    return this.deps.stateStore.getSessionState(childSessionKey).timelineEntries;
  }

  private findReplyItem(
    renderItems: SessionRenderItem[],
    completionItemKey: string,
  ): SessionAssistantTurnItem | null {
    const completionIndex = renderItems.findIndex((item) => item.key === completionItemKey);
    if (completionIndex < 0) {
      return null;
    }
    for (let index = completionIndex + 1; index < renderItems.length; index += 1) {
      const item = renderItems[index];
      if (item?.kind === 'assistant-turn') {
        return item;
      }
    }
    return null;
  }

  private buildMainTimelineEntries(
    state: SessionRuntimeTimelineState,
    graphIndex: number,
  ): SessionTimelineEntry[] {
    const graph = state.executionGraphItems[graphIndex];
    if (!graph) {
      return [];
    }
    const triggerIndex = state.timelineEntries.findIndex((entry) => entry.key === graph.triggerItemKey);
    if (triggerIndex < 0) {
      return [];
    }
    const replyItemIndex = graph.replyItemKey
      ? state.renderItems.findIndex((item) => item.key === graph.replyItemKey)
      : -1;
    let replyTimelineIndex = -1;
    if (replyItemIndex >= 0) {
      const replyItem = state.renderItems[replyItemIndex];
      if (replyItem?.kind === 'assistant-turn') {
        replyTimelineIndex = state.timelineEntries.findIndex((entry) => entry.key === replyItem.key);
      }
    }
    const endExclusive = replyTimelineIndex >= 0 ? replyTimelineIndex + 1 : state.timelineEntries.length;
    return state.timelineEntries.slice(triggerIndex, Math.max(triggerIndex, endExclusive));
  }

  refreshRenderItems(state: SessionRuntimeTimelineState): void {
    state.renderItems = buildRenderItemsFromTimeline({
      sessionKey: state.sessionKey,
      timelineEntries: state.timelineEntries,
      executionGraphItems: state.executionGraphItems,
      runtime: state.runtime,
    });
  }

  refreshGraphItem(
    state: SessionRuntimeTimelineState,
    graphIndex: number,
    options: {
      refreshChildSteps?: boolean;
    } = {},
  ): void {
    const current = state.executionGraphItems[graphIndex];
    if (!current) {
      return;
    }
    const next = attachExecutionGraphReply(
      current,
      this.findReplyItem(state.renderItems, current.completionItemKey),
    );
    const withMainSteps = updateExecutionGraphMainSteps(
      next,
      deriveExecutionGraphSteps(this.buildMainTimelineEntries(state, graphIndex)),
    );
    state.executionGraphItems[graphIndex] = options.refreshChildSteps
      ? updateExecutionGraphChildSteps(
          withMainSteps,
          deriveExecutionGraphSteps(this.resolveChildTimelineEntries(withMainSteps.childSessionKey)),
        )
      : withMainSteps;
  }

  rebuildFromTimeline(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
  ): void {
    state.executionGraphItems = [];
    for (const entry of state.timelineEntries) {
      if (!isTaskCompletionEntry(entry)) {
        continue;
      }
      const triggerEntry = entry.triggerItemKey
        ? state.timelineEntries.find((candidate) => candidate.key === entry.triggerItemKey) ?? entry
        : entry;
      state.executionGraphItems.push(createExecutionGraphItem(entry, triggerEntry));
    }
    this.refreshRenderItems(state);
    for (let index = 0; index < state.executionGraphItems.length; index += 1) {
      this.refreshGraphItem(state, index, { refreshChildSteps: true });
    }
    this.refreshRenderItems(state);
    this.deps.stateStore.updateExecutionGraphDependencyIndex(sessionKey, state.executionGraphItems);
  }

  refreshParents(childSessionKey: string): void {
    for (const parentSessionKey of this.deps.stateStore.listParentSessionKeys(childSessionKey)) {
      const parentState = this.deps.stateStore.findSessionState(parentSessionKey);
      if (!parentState?.hydrated) {
        continue;
      }
      for (let index = 0; index < parentState.executionGraphItems.length; index += 1) {
        const graph = parentState.executionGraphItems[index];
        if (graph?.childSessionKey === childSessionKey) {
          this.refreshGraphItem(parentState, index, { refreshChildSteps: true });
        }
      }
      this.refreshRenderItems(parentState);
      parentState.window = clampWindowState(parentState.window, parentState.renderItems.length);
    }
  }

  refreshExistingGraphs(state: SessionRuntimeTimelineState): void {
    this.refreshRenderItems(state);
    for (let index = 0; index < state.executionGraphItems.length; index += 1) {
      this.refreshGraphItem(state, index);
    }
    this.refreshRenderItems(state);
  }
}
