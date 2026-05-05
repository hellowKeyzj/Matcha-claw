import type { ResourceStatusState } from '@/lib/resource-state';
import type { SessionUpdateEvent } from '../../../runtime-host/shared/session-adapter-types';
import type { SessionRenderAttachedFile, SessionRenderItem } from '../../../runtime-host/shared/session-adapter-types';
import type { SessionCatalogKind, SessionCatalogTitleSource } from '../../../runtime-host/shared/session-adapter-types';

/** Metadata for locally-attached files (not from Gateway) */
export interface AttachedFileMeta {
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  filePath?: string;
}

export type ChatAttachedFile = SessionRenderAttachedFile;

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
  agentId?: string;
  kind?: SessionCatalogKind;
  preferred?: boolean;
  label?: string;
  titleSource?: SessionCatalogTitleSource;
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
  activeTurnItemKey: string | null;
  pendingTurnKey: string | null;
  pendingTurnLaneKey: string | null;
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
}

export interface ChatSessionMetaState {
  agentId: string | null;
  kind: SessionCatalogKind | null;
  preferred: boolean;
  label: string | null;
  titleSource: SessionCatalogTitleSource;
  displayName?: string | null;
  model?: string | null;
  lastActivityAt: number | null;
  historyStatus: ChatSessionHistoryStatus;
  thinkingLevel: string | null;
}

export interface ChatSessionRecord {
  meta: ChatSessionMetaState;
  runtime: ChatSessionRuntimeState;
  items: SessionRenderItem[];
  window: ChatSessionViewportState;
}

export interface ChatSessionViewportState {
  totalItemCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isLoadingMore: boolean;
  isLoadingNewer: boolean;
  isAtLatest: boolean;
  anchorItemKey: string | null;
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
export type ChatRuntimeEventPhase = 'started' | 'delta' | 'final' | 'error' | 'aborted' | 'unknown';

export interface ChatRuntimeLifecycleEvent {
  phase: ChatRuntimeEventPhase;
  runId: string | null;
  sessionKey: string | null;
  event: Record<string, unknown>;
}

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
  newSession: (agentId?: string) => Promise<void>;
  deleteSession: (key: string) => Promise<void>;
  cleanupEmptySession: () => void;
  loadHistory: (request: ChatHistoryLoadRequest) => Promise<void>;
  loadOlderViewportItems: (sessionKey?: string) => Promise<void>;
  jumpViewportToLatest: (sessionKey?: string) => Promise<void>;
  setViewportAnchorItemKey: (itemKey: string | null, sessionKey?: string) => void;
  sendMessage: (text: string, attachments?: ChatSendAttachment[]) => Promise<void>;
  abortRun: () => Promise<void>;
  handleApprovalRequested: (payload: Record<string, unknown>) => void;
  handleApprovalResolved: (payload: Record<string, unknown>) => void;
  resolveApproval: (id: string, decision: ApprovalDecision) => Promise<void>;
  syncPendingApprovals: (sessionKeyHint?: string) => Promise<void>;
  getTaskInboxBridgeState: () => TaskInboxChatBridgeState;
  openTaskInboxSession: (sessionKey: string) => string;
  sendTaskInboxRecoveryPrompt: (sessionKey: string, prompt: string) => Promise<boolean>;
  handleSessionUpdateEvent: (event: SessionUpdateEvent) => void;
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
