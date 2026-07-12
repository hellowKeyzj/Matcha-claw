import type {
  SessionExecutionGraphItem,
  SessionRenderItem,
  SessionRuntimeStateSnapshot,
  TaskSnapshotEvent,
  SessionTimelineEntry,
  SessionWindowStateSnapshot,
} from '../../shared/session-adapter-types';
import type { RuntimeEndpointRef, SessionIdentity } from '../agent-runtime/contracts/runtime-address';
import type { CanonicalProjectionRenderItemKeyIndex } from './canonical/canonical-projection';
import type { CanonicalSessionState } from './canonical/canonical-state';

export interface SessionNewPayload {
  sessionKey?: unknown;
  endpoint?: unknown;
  agentId?: unknown;
  endpointSessionId?: unknown;
}

export interface SessionIdentityRequest {
  sessionIdentity: SessionIdentity | null;
  sessionIdentityError: string | null;
}

export interface SessionCreateTargetRequest {
  endpoint: RuntimeEndpointRef | null;
  endpointError: string | null;
  agentId: string;
}

export interface SessionLoadPayload {
  sessionKey?: unknown;
  endpointSessionId?: unknown;
  limit?: unknown;
  sessionIdentity?: unknown;
}

export interface SessionWindowPayload {
  sessionKey?: unknown;
  endpointSessionId?: unknown;
  mode?: unknown;
  limit?: unknown;
  offset?: unknown;
  includeCanonical?: unknown;
  sessionIdentity?: unknown;
}

export interface SessionPromptPayload {
  sessionKey?: unknown;
  endpointSessionId?: unknown;
  message?: unknown;
  displayMessage?: unknown;
  deliver?: unknown;
  runId?: unknown;
  idempotencyKey?: unknown;
  media?: unknown;
  sessionIdentity?: unknown;
}

export interface SessionAbortRuntimePayload {
  sessionKey?: unknown;
  endpointSessionId?: unknown;
  approvalIds?: unknown;
  sessionIdentity?: unknown;
}

export interface SessionResolveApprovalPayload {
  id?: unknown;
  decision?: unknown;
  sessionKey?: unknown;
  endpointSessionId?: unknown;
  sessionIdentity?: unknown;
}

export interface SessionPatchPayload {
  sessionKey?: unknown;
  endpointSessionId?: unknown;
  sessionIdentity?: unknown;
  runtimeModelRef?: unknown;
}

export interface SessionRenamePayload {
  sessionKey?: unknown;
  sessionIdentity?: unknown;
  label?: unknown;
}

export interface SessionStatusPayload {
  sessionKey?: unknown;
  sessionIdentity?: unknown;
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
  committedEventCount: number;
}
