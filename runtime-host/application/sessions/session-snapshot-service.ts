import type {
  SessionRenderItem,
  SessionStateSnapshot,
  SessionTimelineEntry,
  SessionWindowStateSnapshot,
} from '../../shared/session-adapter-types';
import type { SessionWindowMode } from './session-window-model';
import type { SessionRuntimeTimelineState } from './session-runtime-types';
import type { SessionSnapshotWorkflow } from '../workflows/session-snapshot/session-snapshot-workflow';

export interface SessionSnapshotServiceDeps {
  snapshotWorkflow: Pick<
    SessionSnapshotWorkflow,
    | 'buildEmptySnapshot'
    | 'buildSnapshot'
    | 'buildSnapshotAsync'
    | 'buildLatestSnapshotAsync'
    | 'buildWindowSnapshotAsync'
    | 'resolvePrimaryItemFromSnapshot'
  >;
}

export class SessionSnapshotService {
  constructor(private readonly deps: SessionSnapshotServiceDeps) {}

  buildEmptySnapshot(state: SessionRuntimeTimelineState): SessionStateSnapshot {
    return this.deps.snapshotWorkflow.buildEmptySnapshot(state);
  }

  buildSnapshot(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    options: {
      items?: SessionRenderItem[];
      window?: SessionWindowStateSnapshot;
      replayComplete?: boolean;
      resolvedModel?: string | null;
      label?: string | null;
    } = {},
  ): SessionStateSnapshot {
    return this.deps.snapshotWorkflow.buildSnapshot(sessionKey, state, options);
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
    return await this.deps.snapshotWorkflow.buildSnapshotAsync(sessionKey, state, options);
  }

  async buildLatestSnapshotAsync(
    sessionKey: string,
    state: SessionRuntimeTimelineState,
    options: {
      replayComplete?: boolean;
    } = {},
  ): Promise<SessionStateSnapshot> {
    return await this.deps.snapshotWorkflow.buildLatestSnapshotAsync(sessionKey, state, options);
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
    return await this.deps.snapshotWorkflow.buildWindowSnapshotAsync(sessionKey, state, input);
  }

  resolvePrimaryItemFromSnapshot(
    snapshot: SessionStateSnapshot,
    candidate: SessionTimelineEntry | null,
    fallbackEntries: SessionTimelineEntry[],
  ): SessionRenderItem | null {
    return this.deps.snapshotWorkflow.resolvePrimaryItemFromSnapshot(snapshot, candidate, fallbackEntries);
  }
}
