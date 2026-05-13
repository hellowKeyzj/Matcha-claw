import type {
  SessionRenderItem,
  SessionStateSnapshot,
  SessionTimelineEntry,
  SessionWindowStateSnapshot,
} from '../../shared/session-adapter-types';
import type { SessionMetadataPort } from './session-metadata-repository';
import type { SessionStoragePort } from './session-storage-repository';
import { SessionRuntimeStateStore } from './session-runtime-state';
import {
  buildWindowRange,
  cloneSessionWindowState,
  createLatestWindowState,
  createWindowStateSnapshot,
  type SessionWindowMode,
} from './session-window-model';
import {
  cloneSessionRuntimeState,
  createEmptySessionRuntimeState,
} from './session-state-model';
import {
  filterStateOnlyRenderItem,
  filterStateOnlyRenderItems,
} from './session-state-only-render-filter';
import {
  createSessionCatalogItem,
} from './session-catalog-model';
import {
  cloneRenderItems,
  isAssistantTimelineEntry,
} from './session-render-model';
import type {
  SessionRuntimeTimelineState,
} from './session-runtime-types';

export interface SessionSnapshotServiceDeps {
  stateStore: SessionRuntimeStateStore;
  sessionMetadata: SessionMetadataPort;
  sessionStorage: SessionStoragePort;
}

export class SessionSnapshotService {
  constructor(private readonly deps: SessionSnapshotServiceDeps) {}

  buildEmptySnapshot(sessionKey = ''): SessionStateSnapshot {
    return {
      sessionKey,
      catalog: createSessionCatalogItem({
        sessionKey,
        timelineEntries: [],
        runtime: createEmptySessionRuntimeState(),
        runtimeModel: null,
        resolvedModel: null,
      }),
      items: [],
      replayComplete: true,
      runtime: createEmptySessionRuntimeState(),
      window: createLatestWindowState(0),
    };
  }

  buildSnapshot(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    options: {
      items?: SessionRenderItem[];
      window?: SessionWindowStateSnapshot;
      replayComplete?: boolean;
      resolvedModel?: string | null;
    } = {},
  ): SessionStateSnapshot {
    const allItems = filterStateOnlyRenderItems(options.items ?? state.renderItems);
    const baseWindow = cloneSessionWindowState(
      options.window
      ?? (
        state.window.isAtLatest && state.window.windowStartOffset === 0
          ? createLatestWindowState(allItems.length)
          : state.window
      ),
    );
    const start = Math.max(0, Math.min(baseWindow.windowStartOffset, allItems.length));
    const end = Math.max(start, Math.min(baseWindow.windowEndOffset, allItems.length));
    const window = createWindowStateSnapshot({
      totalItemCount: allItems.length,
      windowStartOffset: start,
      windowEndOffset: end,
      hasMore: start > 0,
      hasNewer: end < allItems.length,
      isAtLatest: end >= allItems.length,
    });
    return {
      sessionKey,
      catalog: createSessionCatalogItem({
        sessionKey,
        timelineEntries: state.timelineEntries,
        runtime: state.runtime,
        runtimeModel: this.deps.stateStore.getResolvedSessionModel(sessionKey),
        resolvedModel: options.resolvedModel
          ?? this.deps.stateStore.getResolvedSessionModel(sessionKey),
      }),
      items: cloneRenderItems(allItems.slice(start, end)),
      ...(state.taskSnapshot ? { taskSnapshot: structuredClone(state.taskSnapshot) } : {}),
      replayComplete: options.replayComplete ?? true,
      runtime: cloneSessionRuntimeState(state.runtime),
      window,
    };
  }

  async buildSnapshotAsync(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    options: {
      items?: SessionRenderItem[];
      window?: SessionWindowStateSnapshot;
      replayComplete?: boolean;
    } = {},
  ): Promise<SessionStateSnapshot> {
    const storageDescriptor = await this.deps.sessionStorage.findStorageDescriptor(sessionKey);
    const resolvedModel = await this.deps.sessionMetadata.resolveSessionModel({
      sessionKey,
      storageDescriptor,
      runtimeModel: this.deps.stateStore.getResolvedSessionModel(sessionKey),
    });
    return this.buildSnapshot(sessionKey, state, {
      ...options,
      resolvedModel,
    });
  }

  async buildLatestSnapshotAsync(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    options: {
      replayComplete?: boolean;
    } = {},
  ): Promise<SessionStateSnapshot> {
    return await this.buildSnapshotAsync(sessionKey, state, {
      items: state.renderItems,
      window: createLatestWindowState(state.renderItems.length),
      replayComplete: options.replayComplete ?? true,
    });
  }

  async buildWindowSnapshotAsync(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    input: {
      mode: SessionWindowMode;
      limit: number;
      offset: number | null;
    },
  ): Promise<SessionStateSnapshot> {
    const allItems = state.renderItems;
    const totalItemCount = allItems.length;
    const { start, end } = buildWindowRange({
      totalItemCount,
      mode: input.mode,
      limit: input.limit,
      offset: input.offset,
    });
    const window = createWindowStateSnapshot({
      totalItemCount,
      windowStartOffset: start,
      windowEndOffset: end,
      hasMore: start > 0,
      hasNewer: end < totalItemCount,
      isAtLatest: end >= totalItemCount,
    });
    state.window = window;
    this.deps.stateStore.persistStore();
    return await this.buildSnapshotAsync(sessionKey, state, {
      items: allItems,
      window,
      replayComplete: true,
    });
  }

  resolvePrimaryItemFromSnapshot(
    snapshot: SessionStateSnapshot,
    candidate: SessionTimelineEntry | null,
    fallbackEntries: SessionTimelineEntry[],
  ): SessionRenderItem | null {
    const source = candidate ?? fallbackEntries[fallbackEntries.length - 1] ?? null;
    if (!source) {
      return null;
    }
    if (isAssistantTimelineEntry(source)) {
      const item = snapshot.items.find((candidate) => (
        candidate.kind === 'assistant-turn'
        && candidate.turnKey === source.turnKey
        && candidate.laneKey === source.laneKey
      )) ?? null;
      return filterStateOnlyRenderItem(item);
    }
    const item = snapshot.items.find((candidate) => candidate.key === source.key) ?? null;
    return filterStateOnlyRenderItem(item);
  }
}
