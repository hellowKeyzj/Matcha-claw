import type { ResourceStatusState } from '@/lib/resource-state';
import type { RuntimeAddress } from '../../../runtime-host/shared/runtime-address';
import type { SessionUpdateEvent } from '../../../runtime-host/shared/session-adapter-types';
import type { SessionRenderAttachedFile, SessionRenderItem } from '../../../runtime-host/shared/session-adapter-types';
import type { SessionCatalogKind, SessionCatalogTitleSource } from '../../../runtime-host/shared/session-adapter-types';
import type { GatewayTransportIssue } from '../../../runtime-host/shared/gateway-error';

/** Metadata for chat attachments backed by a local file or Gateway media record. */
export interface AttachedFileMeta {
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  filePath?: string;
  gatewayUrl?: string;
  source?: 'user-upload' | 'tool-result' | 'message-ref';
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
  url?: string;
  alt?: string;
  id?: string;
  name?: string;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
}

/** Session from session catalog */
export interface ChatSession {
  key: string;
  backendSessionKey: string;
  agentId: string;
  protocolId?: string;
  runtimeEndpointId?: string;
  runtimeAddress: RuntimeAddress;
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
  status: 'running' | 'completed' | 'error' | 'missing_result';
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

const ACTIVE_RUN_PHASES = new Set<ChatRunPhase>([
  'submitted',
  'streaming',
  'waiting_tool',
  'finalizing',
]);

/** 单一事实源派生：当前回合是否处于运行状态。 */
export function isRunActive(runtime: { runPhase: ChatRunPhase }): boolean {
  return ACTIVE_RUN_PHASES.has(runtime.runPhase);
}

/** 单一事实源派生：当前回合是否在等待工具结果。 */
export function isWaitingTool(runtime: { runPhase: ChatRunPhase }): boolean {
  return runtime.runPhase === 'waiting_tool';
}

export type ApprovalStatus = 'idle' | 'awaiting_approval';
export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export interface ApprovalItem {
  id: string;
  sessionKey: string;
  backendSessionKey: string;
  runtimeAddress: RuntimeAddress;
  runId?: string;
  title: string;
  command?: string;
  allowedDecisions: ApprovalDecision[];
  request?: Record<string, unknown>;
  createdAtMs: number;
  expiresAtMs?: number;
  decision?: ApprovalDecision;
}

export interface TaskChatBridgeState {
  sessionKey: string;
  owner: string;
  canSendRecoveryPrompt: boolean;
}

export interface ChatSessionRuntimeState {
  activeRunId: string | null;
  runPhase: ChatRunPhase;
  activeTurnItemKey: string | null;
  pendingTurnKey: string | null;
  pendingTurnLaneKey: string | null;
  runtimeActivity: 'compacting' | null;
  lastUserMessageAt: number | null;
  lastError: string | null;
  lastIssue: GatewayTransportIssue | null;
  updatedAt: number | null;
}

export interface ChatRuntimeErrorDismissMarker {
  updatedAt: number | null;
  fingerprint: string | null;
}

export interface ChatSessionMetaState {
  backendSessionKey: string;
  runtimeScopeKey: string | null;
  agentId: string | null;
  protocolId: string | null;
  runtimeEndpointId: string | null;
  runtimeAddress: RuntimeAddress | null;
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

export interface ChatSessionRuntimeEndpointTarget {
  endpointId: string;
  protocolId: string;
  runtimeAdapterId?: string;
  runtimeInstanceId?: string;
  connectorId?: string;
  displayName: string;
  agentIds: string[];
  acceptsDynamicAgents: boolean;
  sessionPromptAddresses: RuntimeAddress[];
  defaultSessionPromptAddress: RuntimeAddress;
}

export interface ChatSessionRuntimeCatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  endpoints: ChatSessionRuntimeEndpointTarget[];
  defaultRuntimeAddress: RuntimeAddress | null;
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
  sessionRuntimeCatalog: ChatSessionRuntimeCatalogState;
  loadedSessions: Record<string, ChatSessionRecord>;
  pendingApprovalsBySession: Record<string, ApprovalItem[]>;
  dismissedRuntimeErrorBySession: Record<string, ChatRuntimeErrorDismissMarker | undefined>;
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
  bootstrapSessionRuntime: () => Promise<void>;
  loadSessions: () => Promise<void>;
  openAgentConversation: (agentId: string) => void;
  switchSession: (key: string) => void;
  newSession: (agentId?: string) => Promise<void>;
  deleteSession: (key: string) => Promise<void>;
  renameSession: (key: string, label: string) => Promise<void>;
  cleanupEmptySession: () => void;
  loadHistory: (request: ChatHistoryLoadRequest) => Promise<void>;
  loadOlderViewportItems: (sessionKey?: string) => Promise<void>;
  jumpViewportToLatest: (sessionKey?: string) => Promise<void>;
  setViewportAnchorItemKey: (itemKey: string | null, sessionKey?: string) => void;
  sendMessage: (text: string, attachments?: ChatSendAttachment[]) => Promise<void>;
  abortRun: () => Promise<void>;
  resolveApproval: (id: string, decision: ApprovalDecision) => Promise<void>;
  syncPendingApprovals: (sessionKeyHint?: string) => Promise<void>;
  setSessionRuntimeAddress: (sessionKey: string, runtimeAddress: RuntimeAddress) => void;
  getTaskBridgeState: () => TaskChatBridgeState;
  openTaskSession: (sessionKey: string) => string;
  sendTaskRecoveryPrompt: (sessionKey: string, prompt: string) => Promise<boolean>;
  handleSessionUpdateEvent: (event: SessionUpdateEvent) => void;
  toggleThinking: () => void;
  refresh: () => Promise<void>;
  clearError: () => void;
}

export type ChatStoreState = ChatStoreBaseState & ChatStoreActions;

export const CHAT_BASE_STATE_KEYS = [
  'currentSessionKey',
  'sessionRuntimeCatalog',
  'loadedSessions',
  'pendingApprovalsBySession',
  'dismissedRuntimeErrorBySession',
  'foregroundHistorySessionKey',
  'sessionCatalogStatus',
  'mutating',
  'error',
  'showThinking',
] as const satisfies readonly (keyof ChatStoreBaseState)[];

export const DEFAULT_CANONICAL_PREFIX = 'agent:main';
export const DEFAULT_SESSION_KEY = `${DEFAULT_CANONICAL_PREFIX}:main`;
