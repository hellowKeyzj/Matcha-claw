import type {
  SessionExecutionGraphItem,
  SessionRenderItem,
  SessionRuntimeStateSnapshot,
  TaskSnapshotEvent,
  SessionTimelineEntry,
  SessionWindowStateSnapshot,
} from '../../shared/session-adapter-types';

export interface SessionNewPayload {
  sessionKey?: unknown;
  agentId?: unknown;
  canonicalPrefix?: unknown;
}

export interface SessionLoadPayload {
  sessionKey?: unknown;
}

export interface SessionWindowPayload {
  sessionKey?: unknown;
  mode?: unknown;
  limit?: unknown;
  offset?: unknown;
  includeCanonical?: unknown;
}

export interface SessionPromptPayload {
  sessionKey?: unknown;
  message?: unknown;
  deliver?: unknown;
  runId?: unknown;
  idempotencyKey?: unknown;
  media?: unknown;
}

export interface SessionAbortRuntimePayload {
  sessionKey?: unknown;
}

export interface SessionPatchPayload {
  sessionKey?: unknown;
  model?: unknown;
}

export interface SessionRenamePayload {
  sessionKey?: unknown;
  label?: unknown;
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
  timelineEntries: SessionTimelineEntry[];
  executionGraphItems: SessionExecutionGraphItem[];
  renderItems: SessionRenderItem[];
  taskSnapshot: TaskSnapshotEvent | null;
  hydrated: boolean;
  runtime: SessionRuntimeStateSnapshot;
  window: SessionWindowStateSnapshot;
  activeTransportEpoch: number | null;
}

export interface PendingRunClosureSignal {
  hasActiveAssistantStream: boolean;
  hasBlockingToolActivity: boolean;
  hasFinalAssistantTurn: boolean;
  hasMatchingRunEvidence: boolean;
}

export interface CommittedSessionTransition {
  state: SessionRuntimeTimelineState;
  runtime: SessionRuntimeStateSnapshot;
  mergedEntries: SessionTimelineEntry[];
}
