import type { ResourceStatusState } from '@/lib/resource-state';

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
  streaming?: boolean;
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

/** Session from session catalog */
export interface ChatSession {
  key: string;
  label?: string;
  displayName?: string;
  thinkingLevel?: string;
  model?: string;
  updatedAt?: number;
}

export type ChatSessionHistoryStatus = 'idle' | 'loading' | 'ready' | 'error';

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

export interface PendingUserMessageOverlay {
  clientMessageId: string;
  message: RawMessage;
  createdAtMs: number;
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

export interface ChatSessionRuntimeState {
  sending: boolean;
  activeRunId: string | null;
  runPhase: ChatRunPhase;
  pendingUserMessage?: PendingUserMessageOverlay | null;
  streamingMessageId: string | null;
  streamingTools: ToolStatus[];
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
  pendingToolImages: AttachedFileMeta[];
  approvalStatus: ApprovalStatus;
}

export interface ChatSessionMetaState {
  label: string | null;
  displayName?: string | null;
  model?: string | null;
  lastActivityAt: number | null;
  historyStatus: ChatSessionHistoryStatus;
  thinkingLevel: string | null;
}

export interface ChatSessionRecord {
  meta: ChatSessionMetaState;
  runtime: ChatSessionRuntimeState;
  window: ChatSessionViewportState;
}

export interface ChatSessionViewportState {
  messages: RawMessage[];
  totalMessageCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isLoadingMore: boolean;
  isLoadingNewer: boolean;
  isAtLatest: boolean;
  lastVisibleMessageId: string | null;
}

export interface ChatViewState {
  foregroundHistorySessionKey: string | null;
  sessionCatalogStatus: ResourceStatusState;
  mutating: boolean;
  error: string | null;
  showThinking: boolean;
}

export interface ChatStoreBaseState extends ChatViewState {
  currentSessionKey: string;
  loadedSessions: Record<string, ChatSessionRecord>;
  pendingApprovalsBySession: Record<string, ApprovalItem[]>;
}

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
  loadOlderMessages: (sessionKey?: string) => Promise<void>;
  jumpToLatest: (sessionKey?: string) => Promise<void>;
  trimTopMessages: (sessionKey?: string, keep?: number) => void;
  setViewportLastVisibleMessageId: (messageId: string | null, sessionKey?: string) => void;
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

export type ChatStoreState = ChatStoreBaseState & ChatStoreActions;

export const CHAT_BASE_STATE_KEYS = [
  'currentSessionKey',
  'loadedSessions',
  'pendingApprovalsBySession',
  'foregroundHistorySessionKey',
  'sessionCatalogStatus',
  'mutating',
  'error',
  'showThinking',
] as const satisfies readonly (keyof ChatStoreBaseState)[];

export const DEFAULT_CANONICAL_PREFIX = 'agent:main';
export const DEFAULT_SESSION_KEY = `${DEFAULT_CANONICAL_PREFIX}:main`;


