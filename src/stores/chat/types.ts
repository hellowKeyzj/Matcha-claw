import type { ResourceStateMeta } from '@/lib/resource-state';

/** Metadata for locally-attached files (not from Gateway) */
export interface AttachedFileMeta {
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  filePath?: string;
}

/** Raw message from OpenClaw chat.history */
export interface RawMessage {
  role: 'user' | 'assistant' | 'system' | 'toolresult' | 'tool_result';
  content: unknown; // string | ContentBlock[]
  timestamp?: number;
  id?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  /** Local-only: file metadata for user-uploaded attachments (not sent to/from Gateway) */
  _attachedFiles?: AttachedFileMeta[];
}

/** Content block inside a message */
export interface ContentBlock {
  type: 'text' | 'image' | 'thinking' | 'tool_use' | 'tool_result' | 'toolCall' | 'toolResult';
  text?: string;
  thinking?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  /** Flat image format from Gateway tool results (no source wrapper) */
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
}

/** Session from sessions.list */
export interface ChatSession {
  key: string;
  label?: string;
  displayName?: string;
  thinkingLevel?: string;
  model?: string;
  updatedAt?: number;
}

export interface ToolStatus {
  id?: string;
  toolCallId?: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  durationMs?: number;
  summary?: string;
  updatedAt: number;
}

export type ChatRunPhase =
  | 'idle'
  | 'submitted'
  | 'streaming'
  | 'waiting_tool'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'aborted';

export type ApprovalStatus = 'idle' | 'awaiting_approval';
export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';
export type StreamRuntimeStatus = 'streaming' | 'draining' | 'finalizing';

export interface ActiveStreamRuntime {
  sessionKey: string;
  runId: string;
  chunks: string[];
  rawChars: number;
  displayedChars: number;
  status: StreamRuntimeStatus;
  rafId: number | null;
}

export interface ApprovalItem {
  id: string;
  sessionKey: string;
  runId?: string;
  toolName?: string;
  createdAtMs: number;
  expiresAtMs?: number;
  decision?: ApprovalDecision;
}

export interface TaskInboxChatBridgeState {
  sessionKey: string;
  owner: string;
  canSendRecoveryPrompt: boolean;
}

/**
 * Runtime snapshot stored per session key.
 * Used for instant switch without blanking the transcript while quiet refresh is running.
 */
export interface SessionRuntimeSnapshot {
  messages: RawMessage[];
  sending: boolean;
  activeRunId: string | null;
  runPhase: ChatRunPhase;
  streamingMessage: unknown | null;
  streamRuntime: ActiveStreamRuntime | null;
  streamingTools: ToolStatus[];
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
  pendingToolImages: AttachedFileMeta[];
  approvalStatus: ApprovalStatus;
}

/**
 * Layer 1: Session snapshot (persistent + cacheable state).
 * This layer owns historical messages and session metadata.
 */
export interface ChatSessionSnapshotLayerState {
  messages: RawMessage[];
  sessions: ChatSession[];
  currentSessionKey: string;
  sessionLabels: Record<string, string>;
  sessionLastActivity: Record<string, number>;
  sessionReadyByKey: Record<string, boolean>;
}

/**
 * Layer 2: Runtime overlay (transient execution state).
 * This layer owns sending/streaming/approval progression only.
 */
export interface ChatRuntimeOverlayLayerState {
  sending: boolean;
  activeRunId: string | null;
  runPhase: ChatRunPhase;
  streamingMessage: unknown | null;
  streamRuntime: ActiveStreamRuntime | null;
  streamingTools: ToolStatus[];
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
  pendingToolImages: AttachedFileMeta[];
  approvalStatus: ApprovalStatus;
  pendingApprovalsBySession: Record<string, ApprovalItem[]>;
  sessionRuntimeByKey: Record<string, SessionRuntimeSnapshot>;
}

/**
 * Layer 3: View-derived/meta state.
 * This layer contains UI control and load/meta flags.
 */
export interface ChatViewDerivedLayerState {
  snapshotReady: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  sessionsResource: ResourceStateMeta<ChatSession[]>;
  mutating: boolean;
  error: string | null;
  showThinking: boolean;
  thinkingLevel: string | null;
}

export interface ChatLayeredState {
  snapshot: ChatSessionSnapshotLayerState;
  runtime: ChatRuntimeOverlayLayerState;
  view: ChatViewDerivedLayerState;
}

export type ChatLayeredFlatState =
  & ChatSessionSnapshotLayerState
  & ChatRuntimeOverlayLayerState
  & ChatViewDerivedLayerState;

export interface ChatSendAttachment {
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;
  preview: string | null;
}

export type ChatHistoryLoadMode = 'active' | 'quiet';
export type ChatHistoryLoadScope = 'foreground' | 'background';

export interface ChatHistoryLoadRequest {
  sessionKey: string;
  mode: ChatHistoryLoadMode;
  scope: ChatHistoryLoadScope;
  reason?: string;
}

export interface ChatStoreActions {
  loadSessions: () => Promise<void>;
  openAgentConversation: (agentId: string) => void;
  switchSession: (key: string) => void;
  newSession: (agentId?: string) => void;
  deleteSession: (key: string) => Promise<void>;
  cleanupEmptySession: () => void;
  loadHistory: (request: ChatHistoryLoadRequest) => Promise<void>;
  sendMessage: (text: string, attachments?: ChatSendAttachment[]) => Promise<void>;
  abortRun: () => Promise<void>;
  handleApprovalRequested: (payload: Record<string, unknown>) => void;
  handleApprovalResolved: (payload: Record<string, unknown>) => void;
  resolveApproval: (id: string, decision: ApprovalDecision) => Promise<void>;
  syncPendingApprovals: (sessionKeyHint?: string) => Promise<void>;
  getTaskInboxBridgeState: () => TaskInboxChatBridgeState;
  openTaskInboxSession: (sessionKey: string) => string;
  sendTaskInboxRecoveryPrompt: (sessionKey: string, prompt: string) => Promise<boolean>;
  handleChatEvent: (event: Record<string, unknown>) => void;
  toggleThinking: () => void;
  refresh: () => Promise<void>;
  clearError: () => void;
}

export type ChatStoreState = ChatLayeredFlatState & ChatStoreActions;

export const CHAT_SNAPSHOT_LAYER_KEYS = [
  'messages',
  'sessions',
  'currentSessionKey',
  'sessionLabels',
  'sessionLastActivity',
  'sessionReadyByKey',
] as const satisfies readonly (keyof ChatSessionSnapshotLayerState)[];

export const CHAT_RUNTIME_LAYER_KEYS = [
  'sending',
  'activeRunId',
  'runPhase',
  'streamingMessage',
  'streamRuntime',
  'streamingTools',
  'pendingFinal',
  'lastUserMessageAt',
  'pendingToolImages',
  'approvalStatus',
  'pendingApprovalsBySession',
  'sessionRuntimeByKey',
] as const satisfies readonly (keyof ChatRuntimeOverlayLayerState)[];

export const CHAT_VIEW_LAYER_KEYS = [
  'snapshotReady',
  'initialLoading',
  'refreshing',
  'sessionsResource',
  'mutating',
  'error',
  'showThinking',
  'thinkingLevel',
] as const satisfies readonly (keyof ChatViewDerivedLayerState)[];

export const DEFAULT_CANONICAL_PREFIX = 'agent:main';
export const DEFAULT_SESSION_KEY = `${DEFAULT_CANONICAL_PREFIX}:main`;
