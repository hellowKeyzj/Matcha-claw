import type { ResourceStatusState } from '@/lib/resource-state';
import type { SessionOwnership } from '../../types/desktop/session-ownership';
import type {
  AgentScope,
  RuntimeEndpointRef,
  SessionIdentity,
} from '../../types/desktop/runtime-address';
import type {
  SessionContextTokenSnapshot,
  SessionModelState,
} from '../../types/session/snapshot';
import type {
  SessionRenderAttachedFile,
} from '../../types/session/tool-card';
import type {
  SessionRenderItem,
} from '../../types/session/render-item';
import type {
  SessionCatalogKind,
  SessionCatalogTitleSource,
} from '../../types/session/snapshot';
import type { GatewayTransportIssue } from '../../types/session/runtime-state';

/** Metadata for chat attachments backed by a local file or Gateway media record. */
export interface AttachedFileMeta {
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  previewStatus?: 'unavailable';
  attachmentStatus?: SessionRenderAttachedFile['attachmentStatus'];
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
  endpointSessionId?: string;
  agentId: string;
  protocolId?: string;
  runtimeEndpointId?: string;
  sessionIdentity: SessionIdentity;
  ownership: SessionOwnership | null;
  kind?: SessionCatalogKind;
  preferred?: boolean;
  label?: string;
  titleSource?: SessionCatalogTitleSource;
  displayName?: string;
  thinkingLevel?: string;
  modelState?: SessionModelState;
  contextTokens?: SessionContextTokenSnapshot;
  updatedAt?: number;
}

export function isOrdinarySessionCandidate(
  session: { ownership: SessionOwnership | null; kind?: SessionCatalogKind | null },
): boolean {
  return session.ownership?.kind === 'ordinary' && session.kind !== 'automation';
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
  | 'stopping'
  | 'done'
  | 'error'
  | 'aborted';

const ACTIVE_RUN_PHASES = new Set<ChatRunPhase>([
  'submitted',
  'streaming',
  'waiting_tool',
  'finalizing',
  'stopping',
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
  endpointSessionId?: string;
  sessionIdentity: SessionIdentity;
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

export interface ChatSessionImageGenerationRuntimeState {
  active: boolean;
  pendingTaskIds: ReadonlyArray<string>;
}

export type ChatSessionRunStartupPhase =
  | 'preparing_workspace'
  | 'naming_worktree'
  | 'creating_worktree'
  | 'running_setup'
  | 'provisioning_environment'
  | 'preparing_context'
  | 'starting_model';

export type ChatSessionRunProgress =
  | { kind: 'startup'; phase: ChatSessionRunStartupPhase }
  | { kind: 'retrying'; attempt: number; maxAttempts: number };

export interface ChatSessionRuntimeErrorDetail {
  kind: 'fallback' | 'error';
  failoverReason: string | null;
  providerRuntimeFailureKind: string | null;
  providerErrorType: string | null;
  providerErrorMessagePreview: string | null;
  httpStatus: number | null;
}

export interface ChatSessionRuntimeNotice {
  runId: string;
  kind: 'guardian_reviewing' | 'guardian_approved' | 'guardian_denied' | 'guardian_warning' | 'guardian_strict_review_required';
  command: string | null;
  riskLevel: string | null;
  rationale: string | null;
  message: string | null;
}

export interface ChatSessionRuntimeState {
  activeRunId: string | null;
  runPhase: ChatRunPhase;
  activeTurnItemKey: string | null;
  pendingTurnKey: string | null;
  pendingTurnLaneKey: string | null;
  runProgress: ChatSessionRunProgress | null;
  runtimeActivity: 'compacting' | null;
  errorDetail: ChatSessionRuntimeErrorDetail | null;
  runtimeNotice: ChatSessionRuntimeNotice | null;
  imageGeneration?: ChatSessionImageGenerationRuntimeState;
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
  endpointSessionId: string | null;
  runtimeScopeKey: string | null;
  agentId: string | null;
  protocolId: string | null;
  runtimeEndpointId: string | null;
  sessionIdentity: SessionIdentity | null;
  ownership: SessionOwnership | null;
  kind: SessionCatalogKind | null;
  preferred: boolean;
  label: string | null;
  titleSource: SessionCatalogTitleSource;
  manualLabel?: boolean;
  displayName?: string | null;
  modelState: SessionModelState | null;
  lastActivityAt: number | null;
  historyStatus: ChatSessionHistoryStatus;
  thinkingLevel: string | null;
}

export interface ChatSessionRuntimeAgentCatalogEntry {
  id: string;
  name?: string;
}

export type ChatSessionRuntimeAgentCatalog =
  | {
    source: 'runtime-endpoint';
    agents: ChatSessionRuntimeAgentCatalogEntry[];
  }
  | {
    source: 'subagent-management';
    seedAgents: ChatSessionRuntimeAgentCatalogEntry[];
  };

export interface ChatSessionRuntimeEndpointTarget {
  endpointId: string;
  protocolId: string;
  endpoint: RuntimeEndpointRef;
  runtimeAdapterId?: string;
  runtimeInstanceId?: string;
  connectorId?: string;
  displayName: string;
  agentIds: string[];
  acceptsDynamicAgents: boolean;
  agentCatalog: ChatSessionRuntimeAgentCatalog;
  sessionPromptScopes: AgentScope[];
  defaultSessionPromptScope: AgentScope;
}

export interface ChatSessionRuntimeCatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  endpoints: ChatSessionRuntimeEndpointTarget[];
  defaultSessionPromptScope: AgentScope | null;
}

export interface ChatSessionRuntimeSessionNode {
  sessionRecordKey: string;
  endpointSessionId: string | null;
  sessionIdentity: SessionIdentity;
  ownership: SessionOwnership | null;
  kind: SessionCatalogKind | null;
  preferred: boolean;
  label: string | null;
  titleSource: SessionCatalogTitleSource;
  displayName: string | null;
  modelState: SessionModelState | null;
  thinkingLevel: string | null;
  contextTokens?: SessionContextTokenSnapshot;
  updatedAt: number | null;
}

export interface ChatSessionRuntimeAgentNode {
  agentId: string;
  catalogEntry: ChatSessionRuntimeAgentCatalogEntry | null;
  sessionPromptScope: AgentScope | null;
  sessions: ChatSessionRuntimeSessionNode[];
  preferredSessionKey: string | null;
}

export interface ChatSessionRuntimeEndpointNode {
  runtimeScopeKey: string;
  endpoint: RuntimeEndpointRef;
  target: ChatSessionRuntimeEndpointTarget | null;
  displayName: string;
  defaultAgentId: string | null;
  agents: ChatSessionRuntimeAgentNode[];
}

export interface ChatSessionRuntimeGraph {
  endpoints: ChatSessionRuntimeEndpointNode[];
}

export type ChatCurrentConversationRuntimeState =
  | { state: 'resolving' }
  | { state: 'ready'; runtimeScopeKey: string }
  | { state: 'starting'; runtimeScopeKey: string }
  | { state: 'unavailable'; runtimeScopeKey: string; error: string | null };

export interface ChatCurrentSessionConversation {
  kind: 'session';
  runtimeScopeKey: string;
  endpoint: RuntimeEndpointRef;
  agentId: string;
  sessionRecordKey: string;
  endpointSessionId: string | null;
  sessionIdentity: SessionIdentity;
}

export interface ChatCurrentDraftConversation {
  kind: 'draft';
  runtimeScopeKey: string;
  endpoint: RuntimeEndpointRef;
  agentId: string;
  sessionPromptScope: AgentScope;
}

export type ChatCurrentConversation = ChatCurrentSessionConversation | ChatCurrentDraftConversation;

export interface ChatSessionRecord {
  meta: ChatSessionMetaState;
  runtime: ChatSessionRuntimeState;
  items: SessionRenderItem[];
  window: ChatSessionViewportState;
  contextTokens?: SessionContextTokenSnapshot;
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
  currentConversation: ChatCurrentConversation | null;
  lastSelectedSessionKeyByRuntimeScopeKey: Record<string, string>;
  sessionRuntimeGraph: ChatSessionRuntimeGraph;
  sessionRuntimeCatalog: ChatSessionRuntimeCatalogState;
  sessionCatalogLoadedAtByRuntimeScopeKey: Record<string, number>;
  sessionCatalogLoadedRevisionByRuntimeScopeKey: Record<string, number>;
  loadedSessions: Record<string, ChatSessionRecord>;
  sessionRecordKeyByIdentityKey: Record<string, string>;
  pendingApprovalsBySession: Record<string, ApprovalItem[]>;
  dismissedRuntimeErrorBySession: Record<string, ChatRuntimeErrorDismissMarker | undefined>;
}

export interface ChatSendAttachment {
  stagedAttachmentId: string;
  entryKind?: 'file' | 'directory';
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  sourcePath?: string;
}

export type ChatSendRejectReason =
  | 'empty'
  | 'loading-history'
  | 'history-error'
  | 'active'
  | 'stopping'
  | 'missing-session'
  | 'missing-session-identity'
  | 'automation-session'
  | 'error';

export type ChatSendGate =
  | {
    canSend: true;
    kind: 'session';
    sessionKey: string;
    endpointSessionId: string | undefined;
    sessionIdentity: SessionIdentity;
  }
  | {
    canSend: true;
    kind: 'draft';
    runtimeScopeKey: string;
    endpoint: RuntimeEndpointRef;
    agentId: string;
  }
  | {
    canSend: false;
    reason: ChatSendRejectReason;
    error?: string;
    sessionKey?: string;
  };

export type ChatSendResult =
  | { accepted: true }
  | { accepted: false; reason: ChatSendRejectReason; error?: string; attachmentReselectionRequired?: boolean };

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
  traceId?: string | null;
}

export interface ChatStoreActions {
  bootstrapSessionRuntime: () => Promise<void>;
  loadSessions: () => Promise<void>;
  openAgentConversation: (agentId: string, endpoint?: RuntimeEndpointRef) => void;
  openSessionIdentity: (target: { sessionIdentity: SessionIdentity; endpointSessionId?: string | null }) => void;
  switchSession: (key: string, traceId?: string | null) => void;
  selectSessionRuntimeEndpoint: (endpoint: RuntimeEndpointRef) => void;
  newSession: (agentId?: string, traceId?: string | null) => Promise<void>;
  newSessionForScope: (scope: AgentScope) => Promise<void>;
  deleteSession: (key: string) => Promise<void>;
  forgetAgentSessions: (agentId: string) => void;
  reconcileAgentSessionTombstones: (agentIds: readonly string[]) => void;
  renameSession: (key: string, label: string) => Promise<void>;
  cleanupEmptySession: () => void;
  loadHistory: (request: ChatHistoryLoadRequest) => Promise<void>;
  loadOlderViewportItems: (sessionKey?: string) => Promise<void>;
  jumpViewportToLatest: (sessionKey?: string) => Promise<void>;
  setViewportAnchorItemKey: (itemKey: string | null, sessionKey?: string) => void;
  sendMessage: (text: string, attachments?: ChatSendAttachment[]) => Promise<ChatSendResult>;
  abortRun: () => Promise<void>;
  resolveApproval: (approval: ApprovalItem, decision: ApprovalDecision) => Promise<void>;
  syncPendingApprovals: (sessionKeyHint?: string) => Promise<void>;
  setSessionIdentity: (sessionKey: string, identity: SessionIdentity) => void;
  getTaskBridgeState: () => TaskChatBridgeState;
  openTaskSession: (sessionKey: string) => string;
  sendTaskRecoveryPrompt: (sessionKey: string, prompt: string) => Promise<boolean>;
  toggleThinking: () => void;
  refresh: () => Promise<void>;
  clearError: () => void;
}

export type ChatStoreState = ChatStoreBaseState & ChatStoreActions;

export const CHAT_BASE_STATE_KEYS = [
  'currentSessionKey',
  'currentConversation',
  'lastSelectedSessionKeyByRuntimeScopeKey',
  'sessionRuntimeGraph',
  'sessionRuntimeCatalog',
  'sessionCatalogLoadedAtByRuntimeScopeKey',
  'sessionCatalogLoadedRevisionByRuntimeScopeKey',
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
