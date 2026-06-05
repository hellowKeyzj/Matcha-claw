import type {
  SessionExecutionGraphItem,
  SessionRenderItem,
  SessionRuntimeStateSnapshot,
  TaskSnapshotEvent,
  SessionTimelineEntry,
  SessionWindowStateSnapshot,
} from '../../shared/session-adapter-types';
import type { RuntimeAddress } from '../agent-runtime/contracts/runtime-address';
import type { CanonicalProjectionRenderItemKeyIndex } from './canonical/canonical-projection';
import type { CanonicalSessionState } from './canonical/canonical-state';

export interface SessionNewPayload {
  sessionKey?: unknown;
  runtimeAddress?: unknown;
}

export interface RuntimeAddressRequest {
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
}

export interface SessionLoadPayload {
  sessionKey?: unknown;
  limit?: unknown;
  runtimeAddress?: unknown;
}

export interface SessionWindowPayload {
  sessionKey?: unknown;
  mode?: unknown;
  limit?: unknown;
  offset?: unknown;
  includeCanonical?: unknown;
  runtimeAddress?: unknown;
}

export interface SessionPromptPayload {
  sessionKey?: unknown;
  message?: unknown;
  deliver?: unknown;
  runId?: unknown;
  idempotencyKey?: unknown;
  media?: unknown;
  runtimeAddress?: unknown;
}

export interface SessionAbortRuntimePayload {
  sessionKey?: unknown;
  approvalIds?: unknown;
  runtimeAddress?: unknown;
}

export interface SessionResolveApprovalPayload {
  id?: unknown;
  decision?: unknown;
  sessionKey?: unknown;
  runtimeAddress?: unknown;
}

export interface SessionPatchPayload {
  sessionKey?: unknown;
  runtimeAddress?: unknown;
  runtimeModelRef?: unknown;
}

export interface SessionRenamePayload {
  sessionKey?: unknown;
  runtimeAddress?: unknown;
  label?: unknown;
}

export interface SessionStatusPayload {
  sessionKey?: unknown;
  runtimeAddress?: unknown;
  status?: unknown;
}

export interface SessionPromptMediaPayload {
  filePath: string;
  mimeType: string;
  fileName: string;
  fileSize?: number;
  preview?: string | null;
}

export interface SessionRuntimeTimelineState {
  sessionKey: string;
  runEpoch: number;
  canonical: CanonicalSessionState;
  timelineEntries: SessionTimelineEntry[];
  executionGraphItems: SessionExecutionGraphItem[];
  renderItems: SessionRenderItem[];
  renderItemIndexByKey: Map<string, number>;
  renderItemKeyIndex: CanonicalProjectionRenderItemKeyIndex;
  taskSnapshot: TaskSnapshotEvent | null;
  hydrated: boolean;
  runtime: SessionRuntimeStateSnapshot;
  window: SessionWindowStateSnapshot;
  activeTransportEpoch: number | null;
}

export interface CommittedSessionTransition {
  state: SessionRuntimeTimelineState;
  runtime: SessionRuntimeStateSnapshot;
  mergedEntries: SessionTimelineEntry[];
}
