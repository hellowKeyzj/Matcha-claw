export type SessionTimelineEntryRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'toolresult'
  | 'tool_result';

export type SessionTimelineEntryStatus =
  | 'pending'
  | 'streaming'
  | 'final'
  | 'error'
  | 'aborted';

export interface SessionTimelineEntryMessage {
  role: SessionTimelineEntryRole;
  content: unknown;
  timestamp?: number;
  id?: string;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
  uniqueId?: string;
  requestId?: string;
  status?: 'sending' | 'sent' | 'timeout' | 'error';
  streaming?: boolean;
  agentId?: string;
  toolCallId?: string;
  tool_calls?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
  toolName?: string;
  metadata?: Record<string, unknown>;
  name?: string;
  details?: unknown;
  toolStatuses?: Array<Record<string, unknown>>;
  isError?: boolean;
  _attachedFiles?: Array<Record<string, unknown>>;
}

export interface SessionTimelineEntry {
  entryId: string;
  sessionKey: string;
  laneKey: string;
  turnKey: string;
  role: SessionTimelineEntryRole;
  status: SessionTimelineEntryStatus;
  timestamp?: number;
  runId?: string;
  agentId?: string;
  sequenceId?: number;
  text: string;
  message: SessionTimelineEntryMessage;
}

export interface SessionRuntimeStateSnapshot {
  sending: boolean;
  activeRunId: string | null;
  runPhase: 'idle' | 'submitted' | 'streaming' | 'waiting_tool' | 'finalizing' | 'done' | 'error' | 'aborted';
  streamingMessageId: string | null;
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
  updatedAt: number | null;
}

export interface SessionWindowStateSnapshot {
  totalEntryCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}

export interface SessionStateSnapshot {
  sessionKey: string;
  entries: SessionTimelineEntry[];
  replayComplete: boolean;
  runtime: SessionRuntimeStateSnapshot;
  window: SessionWindowStateSnapshot;
}

export interface SessionLoadResult {
  snapshot: SessionStateSnapshot;
}

export interface SessionCatalogItem {
  key: string;
  label?: string;
  displayName?: string;
  updatedAt?: number;
}

export interface SessionListResult {
  sessions: SessionCatalogItem[];
}

export interface SessionWindowResult {
  snapshot: SessionStateSnapshot;
}

export interface SessionInfoUpdateEvent {
  sessionUpdate: 'session_info_update';
  sessionKey: string | null;
  runId: string | null;
  phase: 'started' | 'final' | 'error' | 'aborted' | 'unknown';
  laneKey: string;
  runtime: SessionRuntimeStateSnapshot;
  window: SessionWindowStateSnapshot;
  _meta?: Record<string, unknown>;
}

export interface SessionMessageChunkUpdateEvent {
  sessionUpdate: 'agent_message_chunk';
  sessionKey: string | null;
  runId: string | null;
  laneKey: string;
  entry: SessionTimelineEntry;
  runtime: SessionRuntimeStateSnapshot;
  window: SessionWindowStateSnapshot;
  _meta?: Record<string, unknown>;
}

export interface SessionMessageUpdateEvent {
  sessionUpdate: 'agent_message';
  sessionKey: string | null;
  runId: string | null;
  laneKey: string;
  entry: SessionTimelineEntry;
  runtime: SessionRuntimeStateSnapshot;
  window: SessionWindowStateSnapshot;
  _meta?: Record<string, unknown>;
}

export type SessionUpdateEvent =
  | SessionInfoUpdateEvent
  | SessionMessageChunkUpdateEvent
  | SessionMessageUpdateEvent;

export interface SessionPromptResult {
  success: boolean;
  sessionKey: string;
  runId: string | null;
  promptId: string;
  entry: SessionTimelineEntry;
  snapshot: SessionStateSnapshot;
}

export interface SessionNewResult {
  success: boolean;
  sessionKey: string;
  snapshot: SessionStateSnapshot;
}
