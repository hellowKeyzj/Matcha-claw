/**
 * Chat Page
 * Native React implementation using runtime-host session APIs.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type ApprovalItem, type ChatSessionRuntimeState, type ChatStoreState } from '@/stores/chat';
import { selectCurrentChatSendGate } from '@/stores/chat/selectors';
import {
  ABORT_STOPPING_TIMEOUT_ERROR,
  ABORT_UNKNOWN_ERROR,
  ABORT_REJECTED_ERROR,
  ABORT_REQUEST_FAILED_ERROR,
} from '@/stores/chat/abort-handlers';
import { isRunActive } from '@/stores/chat/types';
import { buildCurrentConversationFromSessionRecord, resolveCurrentConversationRuntimeState } from '@/stores/chat/session-runtime-graph';
import { supportsSessionGoal, useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useSettingsStore } from '@/stores/settings';
import { useTeamsStore } from '@/stores/teams';
import { TeamDesignDialog } from '@/pages/Teams/TeamDesignDialog';
import { useComposerDraftStore, clampComposerDraftSelection, type ComposerDraftSelection } from '@/stores/composer-drafts';
import type { GatewayTransportIssue } from '../../types/session/runtime-state';
import {
  buildSessionIdentityKey,
  runtimeEndpointsEqual,
  type SessionIdentity,
} from '../../types/desktop/runtime-address';
import { getCronSessionBaseKey, parseCronSessionKey } from '@/stores/chat/cron-session-utils';
import type {
  SessionRenderItem,
} from '../../types/session/render-item';
import type {
  SessionWindowStateSnapshot,
  SessionWireIdentity,
} from '../../types/session/snapshot';
import { isGatewayOperational } from '@/lib/gateway-status';
import {
  createEmptySessionRecord,
  getPendingApprovals,
  getSessionApprovalStatus,
  patchSessionMeta,
} from '@/stores/chat/store-state-helpers';
import { hasVisibleRuntimeError } from '@/stores/chat/runtime-error-view';
import { resolveSessionOperationTarget } from '@/stores/chat/session-identity';
import {
  TRANSIENT_RUNTIME_ERROR_BANNER_DELAY_MS,
  shouldShowRuntimeErrorBannerImmediately,
} from './runtime-error-banner';
import { ChatShell } from './components/ChatShell';
import { ChatSidePanel } from './components/ChatSidePanel';
import { ChatOffline } from './components/ChatOffline';
import { ChatInput, type ChatInputHandle } from './ChatInput';
import { Button } from '@/components/ui/button';
import { AssistantPendingLabelProvider } from './components/AssistantPendingIndicator';
import { ChatList, type ChatListHandle } from './components/ChatList';
import { ChatHeaderBar } from './components/ChatHeaderBar';
import { ChatApprovalDock, ChatErrorBanner, ChatRuntimeStatusDock } from './components/ChatRuntimeDock';
import { SessionTodoPanel } from './components/SessionTodoPanel';
import { WelcomeScreen } from './components/ChatStates';
import { useChatInit } from './useChatInit';
import { openChatRuntimeSurface, useChatSidePanelController, type ChatRuntimeSurfaceDescriptor } from './useChatSidePanelController';
import { useChatWindowDockController } from './useChatWindowDockController';
import { useAgentSkillConfig } from './useAgentSkillConfig';
import { useChatView } from './useChatView';
import { useChatQuestions } from './useChatQuestions';
import { useChatGoals } from './useChatGoals';
import { ChatGoalDock } from './ChatGoalDock';
import { ChatQuestionDock } from './components/ChatQuestionDock';
import { useWorkspaceAvailability } from '@/hooks/use-workspace-availability';
import {
  applyAssistantPresentationToItems,
  type ChatAssistantCatalogAgent,
  type ChatRenderItem,
} from './chat-render-item-model';
import {
  hostApiFetch,
  hostSessionPatch,
  hostSessionPermissionGet,
  hostSessionPermissionSet,
  hostSessionWindowFetch,
  type HostSessionPermissionResult,
  type SessionPermissionMode,
  type SessionPermissionSelection,
} from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { pickLocalDirectory } from '@/services/local-path-picker';
import { toast } from 'sonner';
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeError,
  summarizeIdentifier,
  summarizeSessionIdentity,
  isSessionTraceEnabled,
  summarizeRenderItems,
} from '@/lib/session-trace';
import { collectChatArtifactGroups } from './artifacts';
import { buildChatSessionMarkdownExport, downloadMarkdownFile } from './session-markdown-export';
import {
  decodeHistorySessionView,
  resolveSessionViewError,
  sessionViewWindow,
} from '@/stores/chat/history-fetch-helpers';
import { projectSessionViewItems } from '@/stores/chat/store-state-helpers';
import { buildChatContextUsageViewModel } from './context-usage';
import { resolveArtifactWorkspaceRoot } from './artifact-workspace';
import {
  resolveArtifactGroupKeyForFile,
  resolvePreviewableArtifactGroupTarget,
  resolveArtifactWorkbenchSelection,
} from './artifact-workbench';
import { supportsInlineDiff, type GeneratedFile } from '@/lib/generated-files';
import { resolveModelCatalogEntry } from '@/lib/provider-models';
import type { ArtifactPreviewTarget } from '@/components/file-preview/types';
import {
  buildArtifactPreviewTargetFromAttachedFile,
  buildArtifactPreviewTargetFromGeneratedFile,
} from '@/components/file-preview/types';
import { DIRECTORY_MIME_TYPE } from '@/components/file-preview/types';
type ChatSkillPreviewState = {
  skillId: string;
  skillName: string;
  markdown: string | null;
  loading: boolean;
  error: string | null;
  filePath?: string;
};

type ChatArtifactSection = 'changes' | 'preview' | 'workspace';
type OpenGeneratedArtifactOptions = {
  preserveSection?: boolean | 'current';
};
type FocusArtifactTargetOptions = {
  preserveSection?: 'workspace';
};

interface ChatProps {
  isActive?: boolean;
}

const EMPTY_AGENTS: never[] = [];
const EMPTY_CHAT_PAGE_SESSION = createEmptySessionRecord();
const EMPTY_APPROVAL_ITEMS: ApprovalItem[] = [];
const CHAT_MARKDOWN_EXPORT_WINDOW_LIMIT = 200;
const ACTIVE_RUN_DISCONNECTED_ERROR = 'The active run disconnected before a terminal event was received.';
const GATEWAY_CONNECT_FAILED_PREFIX = 'Gateway connect failed: ';
const GATEWAY_RPC_TIMEOUT_PREFIX = 'Gateway RPC timeout: ';
const STARTUP_TRACE_PREFIX = '[startup-trace]';

type ChatRuntimeBranch = 'starting' | 'unavailable' | 'ready';

type ChatSessionPermissionOption = Readonly<{
  mode: SessionPermissionSelection;
  labelKey: string;
  descriptionKey: string;
  disabled?: boolean;
}>;

type ChatSessionPermissionProjection = Readonly<{
  loading: boolean;
  switching: boolean;
  supported: boolean;
  pending: boolean;
  defaultMode: SessionPermissionMode | null;
  canSelectFull: boolean;
  options: ChatSessionPermissionOption[];
  mode: SessionPermissionSelection;
}>;

const SESSION_PERMISSION_OPTIONS: ChatSessionPermissionOption[] = [
  { mode: null, labelKey: 'input.permissionDefaultWithMode', descriptionKey: 'input.permissionDefaultDescription' },
  { mode: 'read-only', labelKey: 'input.permissionReadOnly', descriptionKey: 'input.permissionReadOnlyDescription' },
  { mode: 'guarded', labelKey: 'input.permissionGuarded', descriptionKey: 'input.permissionGuardedDescription' },
  { mode: 'workspace', labelKey: 'input.permissionWorkspace', descriptionKey: 'input.permissionWorkspaceDescription' },
  { mode: 'full', labelKey: 'input.permissionFull', descriptionKey: 'input.permissionFullDescription' },
];

function createSessionPermissionProjection(
  overrides?: Partial<Omit<ChatSessionPermissionProjection, 'options'>> & { options?: ChatSessionPermissionOption[] },
): ChatSessionPermissionProjection {
  const canSelectFull = overrides?.canSelectFull ?? false;
  return {
    loading: overrides?.loading ?? false,
    switching: overrides?.switching ?? false,
    supported: overrides?.supported ?? false,
    pending: overrides?.pending ?? false,
    defaultMode: overrides?.defaultMode ?? null,
    canSelectFull,
    options: overrides?.options ?? SESSION_PERMISSION_OPTIONS.map((option) => ({
      ...option,
      ...(option.mode === 'full' && !canSelectFull ? { disabled: true } : {}),
    })),
    mode: overrides?.mode ?? null,
  };
}

function sessionPermissionProjectionFromResult(result: HostSessionPermissionResult): ChatSessionPermissionProjection {
  const modes = new Set(result.options);
  return createSessionPermissionProjection({
    loading: false,
    switching: false,
    supported: result.supported,
    pending: result.pending,
    defaultMode: result.defaultMode ?? null,
    canSelectFull: result.canSelectFull,
    options: result.supported
      ? SESSION_PERMISSION_OPTIONS
        .filter((option) => option.mode === null || modes.has(option.mode))
        .map((option) => ({
          ...option,
          ...(option.mode === 'full' && !result.canSelectFull ? { disabled: true } : {}),
        }))
      : [],
    mode: result.mode,
  });
}

function sessionIdentityToWire(identity: SessionIdentity | null | undefined): SessionWireIdentity | null {
  if (!identity || identity.endpoint.kind !== 'native-runtime') {
    return null;
  }
  if (identity.endpoint.runtimeAdapterId !== 'openclaw' && identity.endpoint.runtimeAdapterId !== 'matcha-agent') {
    return null;
  }
  return {
    sessionKey: identity.sessionKey,
    endpoint: {
      kind: identity.endpoint.kind,
      runtimeAdapterId: identity.endpoint.runtimeAdapterId,
      runtimeInstanceId: identity.endpoint.runtimeInstanceId,
    },
    agentId: identity.agentId,
  };
}

function isImageGenerationActive(runtime: ChatSessionRuntimeState): boolean {
  return runtime.imageGeneration?.active === true;
}

function workspaceAvailabilityKey(identity: SessionIdentity | null | undefined): string {
  if (!identity || identity.endpoint.kind !== 'native-runtime') {
    return '';
  }
  if (identity.endpoint.runtimeAdapterId !== 'openclaw' || identity.endpoint.runtimeInstanceId !== 'local') {
    return '';
  }
  return JSON.stringify({
    runtimeAdapterId: identity.endpoint.runtimeAdapterId,
    runtimeInstanceId: identity.endpoint.runtimeInstanceId,
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
  });
}

function chatStartupTraceSummary(source: string, phase: ChatRuntimeBranch) {
  return {
    source,
    phase,
  };
}

function parseRpcFailedMessage(message: string): { method: string; reason: string } | null {
  const matched = /^Gateway RPC failed \((.+?)\):\s*(.+)$/.exec(message.trim());
  if (!matched) {
    return null;
  }
  return {
    method: matched[1],
    reason: matched[2],
  };
}

function resolveSocketCloseReason(issue: GatewayTransportIssue): string {
  const details = issue.details;
  if (details && typeof details === 'object' && typeof (details as { reason?: unknown }).reason === 'string') {
    return (details as { reason: string }).reason;
  }
  return 'unknown';
}

function localizeGatewayIssueByCode(
  issue: GatewayTransportIssue,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  switch (issue.code) {
    case 'MODEL_UNAVAILABLE':
      return t('errors.modelUnavailable');
    case 'AUTH_REQUIRED':
    case 'AUTH_TOKEN_NOT_CONFIGURED':
    case 'AUTH_PASSWORD_MISSING':
    case 'AUTH_PASSWORD_NOT_CONFIGURED':
      return t('errors.gatewayAuthRequired');
    case 'AUTH_TOKEN_MISSING':
      return t('errors.gatewayTokenMissing');
    case 'AUTH_TOKEN_MISMATCH':
      return t('errors.gatewayTokenMismatch');
    case 'AUTH_UNAUTHORIZED':
    case 'AUTH_PASSWORD_MISMATCH':
    case 'AUTH_BOOTSTRAP_TOKEN_INVALID':
    case 'AUTH_DEVICE_TOKEN_MISMATCH':
    case 'DEVICE_AUTH_INVALID':
    case 'DEVICE_AUTH_DEVICE_ID_MISMATCH':
    case 'DEVICE_AUTH_SIGNATURE_EXPIRED':
    case 'DEVICE_AUTH_NONCE_REQUIRED':
    case 'DEVICE_AUTH_NONCE_MISMATCH':
    case 'DEVICE_AUTH_SIGNATURE_INVALID':
    case 'DEVICE_AUTH_PUBLIC_KEY_INVALID':
    case 'AUTH_TAILSCALE_IDENTITY_MISSING':
    case 'AUTH_TAILSCALE_PROXY_MISSING':
    case 'AUTH_TAILSCALE_WHOIS_FAILED':
    case 'AUTH_TAILSCALE_IDENTITY_MISMATCH':
      return t('errors.gatewayAuthFailed');
    case 'AUTH_RATE_LIMITED':
      return t('errors.gatewayAuthRateLimited');
    case 'PAIRING_REQUIRED':
      return t('errors.gatewayPairingRequired');
    case 'CONTROL_UI_ORIGIN_NOT_ALLOWED':
      return t('errors.gatewayOriginNotAllowed');
    case 'CONTROL_UI_DEVICE_IDENTITY_REQUIRED':
    case 'DEVICE_IDENTITY_REQUIRED':
      return t('errors.gatewayDeviceIdentityRequired');
    default:
      return null;
  }
}

function localizeGatewayIssue(
  issue: GatewayTransportIssue | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!issue) {
    return null;
  }

  const codeLocalized = localizeGatewayIssueByCode(issue, t);
  if (codeLocalized) {
    return codeLocalized;
  }

  if (!issue.message) {
    return null;
  }

  if (issue.source === 'socket-close') {
    return t('errors.gatewaySocketClosed', {
      code: issue.code || 'unknown',
      reason: resolveSocketCloseReason(issue),
    });
  }

  if (issue.source === 'heartbeat-timeout') {
    return t('errors.gatewayHeartbeatTimeout');
  }

  if (issue.source === 'connect') {
    if (issue.message === 'Gateway connect timeout') {
      return t('errors.gatewayConnectTimeout');
    }
    if (issue.message.startsWith(GATEWAY_CONNECT_FAILED_PREFIX)) {
      return t('errors.gatewayConnectFailed', {
        reason: issue.message.slice(GATEWAY_CONNECT_FAILED_PREFIX.length).trim(),
      });
    }
  }

  if (issue.source === 'rpc') {
    if (issue.message.startsWith(GATEWAY_RPC_TIMEOUT_PREFIX)) {
      return t('errors.gatewayRpcTimeout', {
        method: issue.message.slice(GATEWAY_RPC_TIMEOUT_PREFIX.length).trim(),
      });
    }
    const rpcFailure = parseRpcFailedMessage(issue.message);
    if (rpcFailure) {
      return t('errors.gatewayRpcFailed', rpcFailure);
    }
  }

  return issue.message;
}

function selectChatPageState(state: ChatStoreState) {
  const currentConversation = state.currentConversation;
  const currentSessionRecordKey = state.currentSessionKey
    || (currentConversation?.kind === 'session' ? currentConversation.sessionRecordKey : '');
  const currentSession = currentSessionRecordKey
    ? state.loadedSessions[currentSessionRecordKey] ?? EMPTY_CHAT_PAGE_SESSION
    : EMPTY_CHAT_PAGE_SESSION;
  return {
    currentConversation,
    currentSessionRecordKey,
    currentSession,
    currentSendGate: selectCurrentChatSendGate(state),
    dismissedRuntimeError: currentSessionRecordKey ? state.dismissedRuntimeErrorBySession[currentSessionRecordKey] : undefined,
    approvalStatus: currentSessionRecordKey ? getSessionApprovalStatus(state, currentSessionRecordKey) : 'idle',
    currentPendingApprovals: currentSessionRecordKey ? getPendingApprovals(state, currentSessionRecordKey) ?? EMPTY_APPROVAL_ITEMS : EMPTY_APPROVAL_ITEMS,
    showThinking: state.showThinking,
    toggleThinking: state.toggleThinking,
    loadOlderViewportItems: state.loadOlderViewportItems,
    jumpViewportToLatest: state.jumpViewportToLatest,
    sendMessage: state.sendMessage,
    abortRun: state.abortRun,
    clearError: state.clearError,
    resolveApproval: state.resolveApproval,
    switchSession: state.switchSession,
    openAgentConversation: state.openAgentConversation,
    bootstrapSessionRuntime: state.bootstrapSessionRuntime,
    loadHistory: state.loadHistory,
    loadSessions: state.loadSessions,
    newSession: state.newSession,
    cleanupEmptySession: state.cleanupEmptySession,
    sessionRuntimeGraph: state.sessionRuntimeGraph,
    sessionRuntimeCatalog: state.sessionRuntimeCatalog,
  };
}

function resolveModelTriggerLabel(modelId: string): string {
  const separatorIndex = modelId.indexOf('/');
  if (separatorIndex < 0 || separatorIndex === modelId.length - 1) {
    return modelId;
  }
  return modelId.slice(separatorIndex + 1);
}

function buildRunProgressPendingLabel(
  runProgress: ChatSessionRuntimeState['runProgress'],
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!runProgress) {
    return null;
  }
  if (runProgress.kind === 'retrying') {
    return t('pending.retrying', {
      attempt: runProgress.attempt,
      maxAttempts: runProgress.maxAttempts,
    });
  }
  return t(`pending.startup.${runProgress.phase}`);
}

function buildRuntimeAssistantPlaceholder(input: {
  sessionKey: string;
  runtime: ChatSessionRuntimeState;
  items: ReadonlyArray<SessionRenderItem>;
  imageGenerationActive: boolean;
  imageGenerationLabel: string;
  pendingLabel: string | null;
}): SessionRenderItem | null {
  const activeRunId = input.runtime.activeRunId;
  const placeholderRunId = activeRunId || (input.imageGenerationActive ? 'image-generation' : '');
  if (!placeholderRunId || (!isRunActive(input.runtime) && !input.imageGenerationActive)) {
    return null;
  }
  if (input.items.some((item) => item.kind === 'assistant-turn' && item.runId === placeholderRunId)) {
    return null;
  }

  const isWaitingForTool = input.runtime.runPhase === 'waiting_tool';
  const isCompacting = input.runtime.runtimeActivity === 'compacting';
  const pendingState = isCompacting ? 'compacting' : (isWaitingForTool ? 'activity' : 'typing');
  return {
    key: `runtime-pending:${input.sessionKey}:${placeholderRunId}`,
    kind: 'assistant-turn',
    role: 'assistant',
    sessionKey: input.sessionKey,
    runId: placeholderRunId,
    identitySource: 'run',
    identityMode: 'run',
    identityConfidence: 'strong',
    status: isWaitingForTool ? 'waiting_tool' : 'streaming',
    segments: input.imageGenerationActive ? [{
      kind: 'message',
      key: `runtime-pending:${input.sessionKey}:${placeholderRunId}:image-generation`,
      text: input.imageGenerationLabel,
    }] : [],
    thinking: null,
    tools: [],
    pendingLabel: input.pendingLabel,
    text: input.imageGenerationActive ? input.imageGenerationLabel : '',
    images: [],
    attachedFiles: [],
    pendingState,
    ...(input.runtime.lastUserMessageAt != null ? { createdAt: input.runtime.lastUserMessageAt } : {}),
    ...(input.runtime.updatedAt != null ? { updatedAt: input.runtime.updatedAt } : {}),
  } as SessionRenderItem;
}

async function fetchChatMarkdownExportWindow(input: {
  endpointSessionId?: string;
  sessionIdentity: SessionIdentity;
  mode: 'latest' | 'older';
  offset?: number;
}): Promise<{ view: ReturnType<typeof decodeHistorySessionView>; items: SessionRenderItem[] }> {
  try {
    const view = decodeHistorySessionView(await hostSessionWindowFetch({
      ...(input.endpointSessionId ? { endpointSessionId: input.endpointSessionId } : {}),
      sessionIdentity: input.sessionIdentity,
      mode: input.mode,
      limit: CHAT_MARKDOWN_EXPORT_WINDOW_LIMIT,
      ...(input.mode === 'older' ? { offset: input.offset } : {}),
      includeCanonical: true,
    }));
    return { view, items: projectSessionViewItems(view) };
  } catch (error) {
    throw resolveSessionViewError(error);
  }
}

function collectSessionWindowItems(input: {
  itemsByOffset: Map<number, SessionRenderItem>;
  window: SessionWindowStateSnapshot;
  items: ReadonlyArray<SessionRenderItem>;
}): void {
  input.items.forEach((item, index) => {
    input.itemsByOffset.set(input.window.windowStartOffset + index, item);
  });
}

async function fetchChatMarkdownExportItems(input: {
  endpointSessionId?: string;
  sessionIdentity: SessionIdentity;
  currentItems: ReadonlyArray<SessionRenderItem>;
  currentWindow: SessionWindowStateSnapshot;
}): Promise<SessionRenderItem[]> {
  if (
    input.currentWindow.totalItemCount === 0
    || (
      input.currentWindow.windowStartOffset === 0
      && input.currentWindow.windowEndOffset >= input.currentWindow.totalItemCount
    )
  ) {
    return [...input.currentItems];
  }

  const itemsByOffset = new Map<number, SessionRenderItem>();
  const latestWindow = await fetchChatMarkdownExportWindow({
    ...(input.endpointSessionId ? { endpointSessionId: input.endpointSessionId } : {}),
    sessionIdentity: input.sessionIdentity,
    mode: 'latest',
  });

  const latestWindowState = sessionViewWindow(latestWindow.view);
  collectSessionWindowItems({
    itemsByOffset,
    window: latestWindowState,
    items: latestWindow.items,
  });

  let nextOffset = latestWindowState.windowStartOffset;
  while (nextOffset > 0) {
    const previousOffset = nextOffset;
    const olderWindow = await fetchChatMarkdownExportWindow({
      ...(input.endpointSessionId ? { endpointSessionId: input.endpointSessionId } : {}),
      sessionIdentity: input.sessionIdentity,
      mode: 'older',
      offset: nextOffset,
    });
    const olderWindowState = sessionViewWindow(olderWindow.view);
    collectSessionWindowItems({
      itemsByOffset,
      window: olderWindowState,
      items: olderWindow.items,
    });
    nextOffset = olderWindowState.windowStartOffset;
    if (nextOffset >= previousOffset) {
      break;
    }
  }

  if (itemsByOffset.size === 0) {
    return [...input.currentItems];
  }
  return [...itemsByOffset.entries()]
    .sort(([leftOffset], [rightOffset]) => leftOffset - rightOffset)
    .map(([, item]) => item);
}

export function Chat({ isActive = true }: ChatProps) {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const navigate = useNavigate();
  const gatewayStatus = useGatewayStore((state) => state.status);
  const questionRecoveryKey = useGatewayStore((state) => `${state.status.connectedAt ?? ''}:${state.runtimeHost.restartCount}`);
  const isGatewayRunning = isGatewayOperational(gatewayStatus);
  const localizedGatewayIssue = useMemo(() => {
    return localizeGatewayIssue(gatewayStatus.lastIssue, t)
      ?? gatewayStatus.lastError
      ?? null;
  }, [gatewayStatus.lastError, gatewayStatus.lastIssue, t]);
  const {
    currentConversation,
    currentSessionRecordKey: selectedSessionRecordKey,
    currentSession,
    currentSendGate,
    dismissedRuntimeError,
    approvalStatus,
    currentPendingApprovals,
    showThinking,
    toggleThinking,
    loadOlderViewportItems,
    jumpViewportToLatest,
    sendMessage,
    abortRun,
    clearError,
    resolveApproval,
    switchSession,
    openAgentConversation,
    bootstrapSessionRuntime,
    loadHistory,
    loadSessions,
    newSession,
    cleanupEmptySession,
    sessionRuntimeGraph,
    sessionRuntimeCatalog,
  } = useChatStore(useShallow(selectChatPageState));
  const currentSessionConversation = currentConversation?.kind === 'session' ? currentConversation : null;
  const currentSessionRecordKey = selectedSessionRecordKey;
  const currentComposerDraftKey = currentConversation?.kind === 'session'
    ? currentSessionRecordKey
    : (currentConversation?.kind === 'draft' ? `${currentConversation.runtimeScopeKey}:agent:${currentConversation.agentId}:draft` : '');
  const currentAgentId = currentConversation?.agentId ?? currentSession.meta.agentId ?? '';
  const connectorSessionIdentity = currentSession.meta.sessionIdentity;
  const connectorEndpointSessionId = currentSession.meta.endpointSessionId;
  const agents = useSubagentsStore((state) => (
    Array.isArray(state.agentsResource.data) ? state.agentsResource.data : EMPTY_AGENTS
  ));
  const availableModels = useSubagentsStore((state) => state.availableModels);
  const modelsLoading = useSubagentsStore((state) => state.modelsLoading);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const updateAgent = useSubagentsStore((state) => state.updateAgent);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const currentAgent = currentAgentId ? agents.find((agent) => agent.id === currentAgentId) : undefined;
  const loadedSessionsForDraftCleanup = useChatStore((state) => state.loadedSessions);
  const loadedSessionKeys = useMemo(() => Object.keys(loadedSessionsForDraftCleanup), [loadedSessionsForDraftCleanup]);
  const composerDraft = useComposerDraftStore((state) => currentComposerDraftKey ? state.drafts[currentComposerDraftKey] ?? '' : '');
  const rawComposerSelection = useComposerDraftStore((state) => currentComposerDraftKey ? state.selections[currentComposerDraftKey] ?? null : null);
  const composerSelection = useMemo(() => clampComposerDraftSelection(rawComposerSelection, composerDraft), [composerDraft, rawComposerSelection]);
  const setComposerDraft = useComposerDraftStore((state) => state.setDraft);
  const clearComposerDraft = useComposerDraftStore((state) => state.clearDraft);
  const setComposerSelection = useComposerDraftStore((state) => state.setSelection);
  const userAvatarDataUrl = useSettingsStore((state) => state.userAvatarDataUrl);
  const [skillPreview, setSkillPreview] = useState<ChatSkillPreviewState | null>(null);
  const [artifactActiveSection, setArtifactActiveSection] = useState<ChatArtifactSection>('changes');
  const [artifactFocusedGroupKey, setArtifactFocusedGroupKey] = useState<string | null>(null);
  const [artifactFocusedFilePath, setArtifactFocusedFilePath] = useState<string | null>(null);
  const [artifactFocusedFileOverride, setArtifactFocusedFileOverride] = useState<ArtifactPreviewTarget | null>(null);
  const [artifactViewMode, setArtifactViewMode] = useState<'preview' | 'diff'>('diff');
  const [visibleRuntimeError, setVisibleRuntimeError] = useState<string | null>(null);
  const [exportingMarkdown, setExportingMarkdown] = useState(false);
  const [sessionPermission, setSessionPermission] = useState<ChatSessionPermissionProjection>(() => createSessionPermissionProjection({ loading: true }));
  const skillPreviewRequestSeqRef = useRef(0);
  const previousRenderedItemsRef = useRef<ChatRenderItem[] | null>(null);
  const chatLayoutRef = useRef<HTMLDivElement>(null);
  const viewportPaneRef = useRef<ChatListHandle>(null);
  const composerRef = useRef<ChatInputHandle>(null);
  const workspaceActive = isActive;
  const runtimeEndpointDirectory = useRuntimeEndpointsStore(useShallow((state) => ({
    status: state.status,
    error: state.error,
    endpoints: state.endpoints,
  })));
  const currentRuntimeConversation = currentConversation
    ?? buildCurrentConversationFromSessionRecord(currentSession);
  const currentConversationRuntime = useMemo(() => resolveCurrentConversationRuntimeState({
    currentConversation: currentRuntimeConversation,
    graph: sessionRuntimeGraph,
    directoryStatus: runtimeEndpointDirectory.status,
    directoryError: runtimeEndpointDirectory.error,
    directoryEndpoints: runtimeEndpointDirectory.endpoints,
  }), [currentRuntimeConversation, runtimeEndpointDirectory.endpoints, runtimeEndpointDirectory.error, runtimeEndpointDirectory.status, sessionRuntimeGraph]);
  const currentConversationEndpoint = currentConversation?.endpoint ?? null;
  const currentChatRuntimeAvailable = currentConversationRuntime.state === 'ready';
  const sessionRuntimeInitializing = (currentConversationRuntime.state === 'resolving' && (sessionRuntimeCatalog.status === 'idle' || sessionRuntimeCatalog.status === 'loading'))
    || (currentConversationRuntime.state === 'starting' && currentSession.items.length === 0);
  const currentRuntimeReconnecting = currentConversationRuntime.state === 'starting';
  const currentWorkspaceIdentity = currentSessionConversation?.sessionIdentity ?? currentSession.meta.sessionIdentity;
  const teamOwnership = currentSession.meta.ownership;
  const designTeamId = teamOwnership?.kind === 'team' && teamOwnership.roleId === 'leader' ? teamOwnership.teamId : null;
  const designRunId = teamOwnership?.kind === 'team' && teamOwnership.roleId === 'leader' ? teamOwnership.teamRunId : null;
  const designTeamKnown = useTeamsStore((state) => Boolean(designTeamId && state.teams.some((team) => team.id === designTeamId)));
  const designRecord = useTeamsStore((state) => designRunId ? state.designByRunId[designRunId] : undefined);
  const observeTeamDesign = useTeamsStore((state) => state.observeTeamDesign);
  const startDesign = useTeamsStore((state) => state.startDesign);
  const continueDesign = useTeamsStore((state) => state.continueDesign);
  const confirmDesign = useTeamsStore((state) => state.confirmDesign);
  const continueDesignDiscussion = useTeamsStore((state) => state.continueDesignDiscussion);
  const designActionPending = Boolean(designRecord?.mutationPending);
  const designSnapshot = designRecord?.snapshot && designRecord.snapshot.teamId === designTeamId && designRecord.snapshot.runId === designRunId ? designRecord.snapshot : null;
  const designActive = designSnapshot?.startGate.status === 'designing' || designSnapshot?.startGate.status === 'design_proposal_pending';
  const designProposal = designSnapshot?.startGate.status === 'design_proposal_pending' ? designSnapshot.startGate.proposal : null;
  const designContextKey = JSON.stringify([designTeamId, designRunId, currentWorkspaceIdentity ? buildSessionIdentityKey(currentWorkspaceIdentity) : null]);
  const currentDesignContextRef = useRef(designContextKey);
  currentDesignContextRef.current = designContextKey;
  const currentWorkspaceAvailabilityKey = workspaceAvailabilityKey(currentWorkspaceIdentity);
  const currentWorkspacePath = currentAgent?.workspace?.trim() ?? '';
  const workspaceAvailabilityTargets = useMemo(() => (
    workspaceActive && isGatewayRunning && currentChatRuntimeAvailable && currentWorkspaceAvailabilityKey
      ? [{
          key: currentWorkspaceAvailabilityKey,
          path: currentWorkspacePath,
          sessionIdentity: currentWorkspaceIdentity,
        }]
      : []
  ), [currentChatRuntimeAvailable, currentWorkspaceAvailabilityKey, currentWorkspaceIdentity, currentWorkspacePath, isGatewayRunning, workspaceActive]);
  const workspaceAvailability = useWorkspaceAvailability(workspaceAvailabilityTargets);
  const currentWorkspaceUnavailable = workspaceAvailability[currentWorkspaceAvailabilityKey] === 'unavailable';
  const handleComposerDraftChange = useCallback((update: SetStateAction<string>) => {
    setComposerDraft(currentComposerDraftKey, update);
  }, [currentComposerDraftKey, setComposerDraft]);
  const handleComposerSelectionChange = useCallback((selection: ComposerDraftSelection) => {
    setComposerSelection(currentComposerDraftKey, selection);
  }, [currentComposerDraftKey, setComposerSelection]);
  const canChooseWorkspaceForCurrentAgent = !!currentAgent
    && (currentAgent.kind !== 'system' || Boolean(currentAgent.isDefault))
    && !!currentAgentId;
  const chatRuntimeBranch: ChatRuntimeBranch = currentConversationRuntime.state === 'ready'
    ? 'ready'
    : (currentConversationRuntime.state === 'unavailable' ? 'unavailable' : 'starting');
  const chatSideEffectsActive = workspaceActive && currentChatRuntimeAvailable;
  const goalSupported = supportsSessionGoal(runtimeEndpointDirectory.endpoints, currentConversationEndpoint, currentAgentId ?? '');
  const chatGoals = useChatGoals(currentWorkspaceIdentity, currentSessionRecordKey, currentSession.meta.endpointSessionId, currentComposerDraftKey, goalSupported && chatSideEffectsActive);
  const beginTypedGoal = (goalId?: string, objective?: string) => {
    if (chatGoals.begin(goalId, objective)) composerRef.current?.focus();
  };
  const submitTypedGoal = (text: string, attachments?: Parameters<typeof sendMessage>[1]) => {
    if (!chatGoals.mode?.goalId) viewportPaneRef.current?.prepareCurrentLatestBottomAlign();
    return chatGoals.submit(text, attachments);
  };
  const chatQuestions = useChatQuestions(
    currentWorkspaceIdentity,
    workspaceActive,
    currentChatRuntimeAvailable && isGatewayRunning,
    questionRecoveryKey,
  );
  const observedIdentitiesKey = useMemo(() => {
    if (!connectorSessionIdentity) return '[]';
    const identities = new Map([[buildSessionIdentityKey(connectorSessionIdentity), connectorSessionIdentity]]);
    const cron = parseCronSessionKey(connectorSessionIdentity.sessionKey);
    if (cron && !cron.runSessionId) {
      for (const record of Object.values(loadedSessionsForDraftCleanup)) {
        const identity = record.meta.sessionIdentity;
        if (identity && identity.agentId === connectorSessionIdentity.agentId
          && getCronSessionBaseKey(identity.sessionKey) === getCronSessionBaseKey(connectorSessionIdentity.sessionKey)
          && runtimeEndpointsEqual(identity.endpoint, connectorSessionIdentity.endpoint)) {
          identities.set(buildSessionIdentityKey(identity), identity);
        }
      }
    }
    return JSON.stringify([...identities].sort(([left], [right]) => left.localeCompare(right)).map(([, identity]) => identity));
  }, [connectorSessionIdentity, loadedSessionsForDraftCleanup]);
  useEffect(() => {
    if (!chatSideEffectsActive) return;
    const observations = (JSON.parse(observedIdentitiesKey) as SessionIdentity[])
      .filter((identity) => identity.endpoint.kind !== 'native-runtime' || identity.endpoint.runtimeAdapterId !== 'openclaw')
      .map((identity) => ({ identity, leaseId: crypto.randomUUID() }));
    for (const { identity, leaseId } of observations) {
      void useChatStore.getState().observeSession(identity, leaseId).ready.catch((error) => {
        console.warn('[session.observe]', summarizeError(error));
        if (isSessionTraceEnabled()) logSessionTrace('session.observe.failed', 'session-observation-boundary', summarizeError(error));
      });
    }
    return () => {
      for (const { identity, leaseId } of observations) {
        void useChatStore.getState().releaseSession(identity, leaseId).catch((error) => {
          console.warn('[session.release]', summarizeError(error));
          if (isSessionTraceEnabled()) logSessionTrace('session.release.failed', 'session-observation-boundary', summarizeError(error));
        });
      }
    };
  }, [chatSideEffectsActive, observedIdentitiesKey]);
  const openClawObservationsRef = useRef(new Map<string, { identity: SessionIdentity; leaseId: string }>());
  useEffect(() => {
    const desired = new Map((chatSideEffectsActive ? JSON.parse(observedIdentitiesKey) as SessionIdentity[] : [])
      .filter((identity) => identity.endpoint.kind === 'native-runtime' && identity.endpoint.runtimeAdapterId === 'openclaw')
      .map((identity) => [buildSessionIdentityKey(identity), identity]));
    const observations = openClawObservationsRef.current;
    const release = (identity: SessionIdentity, leaseId: string) => {
      void useChatStore.getState().releaseSession(identity, leaseId).catch((error) => {
        console.warn('[session.release]', summarizeError(error));
        if (isSessionTraceEnabled()) logSessionTrace('session.release.failed', 'session-observation-boundary', summarizeError(error));
      });
    };
    for (const [key, observation] of observations) {
      if (desired.has(key)) continue;
      observations.delete(key);
      release(observation.identity, observation.leaseId);
    }
    for (const [key, identity] of desired) {
      if (observations.has(key)) continue;
      const { leaseId, ready } = useChatStore.getState().observeSession(identity);
      observations.set(key, { identity, leaseId });
      void ready.catch((error) => {
        console.warn('[session.observe]', summarizeError(error));
        if (isSessionTraceEnabled()) logSessionTrace('session.observe.failed', 'session-observation-boundary', summarizeError(error));
      });
    }
  }, [chatSideEffectsActive, observedIdentitiesKey]);
  useEffect(() => () => {
    for (const { identity, leaseId } of openClawObservationsRef.current.values()) {
      void useChatStore.getState().releaseSession(identity, leaseId).catch((error) => {
        console.warn('[session.release]', summarizeError(error));
        if (isSessionTraceEnabled()) logSessionTrace('session.release.failed', 'session-observation-boundary', summarizeError(error));
      });
    }
    openClawObservationsRef.current.clear();
  }, []);
  useEffect(() => {
    console.info(JSON.stringify({
      prefix: STARTUP_TRACE_PREFIX,
      traceScope: 'renderer-boundary',
      ...chatStartupTraceSummary('chat-page', chatRuntimeBranch),
    }));
  }, [chatRuntimeBranch]);
  useChatInit({
    isActive: workspaceActive,
    locationSearch: location.search,
    navigate,
    switchSession,
    openAgentConversation,
    bootstrapSessionRuntime,
    loadAgents,
    loadSessions,
    loadHistory,
    cleanupEmptySession,
  });

  const loadedSessionKeysRef = useRef(new Set<string>(loadedSessionKeys));
  useEffect(() => {
    const nextKeys = new Set(loadedSessionKeys);
    for (const key of loadedSessionKeysRef.current) {
      if (!nextKeys.has(key)) {
        clearComposerDraft(key);
      }
    }
    loadedSessionKeysRef.current = nextKeys;
  }, [clearComposerDraft, loadedSessionKeys]);



  const {
    sidePanelOpen: sidePanelIntentOpen,
    sidePanelWidth: sidePanelRenderWidth,
    sidePanelPreferredWidth,
    sidePanelWidthPolicy,
    activeSidePanelTab,
    artifactWorkbenchFullscreen,
    openSidePanel: openSidePanelDomain,
    setActiveSidePanelTab,
    closeSidePanel: closeSidePanelDomain,
    setSidePanelWidth,
    toggleArtifactWorkbenchFullscreen,
    teamGraphSurface,
  } = useChatSidePanelController(chatSideEffectsActive, chatLayoutRef, currentWorkspaceIdentity ?? undefined);
  useEffect(() => {
    if (!chatSideEffectsActive || !isGatewayRunning || !designTeamKnown || !designTeamId || !designRunId) return;
    return observeTeamDesign({ teamId: designTeamId, runId: designRunId });
  }, [chatSideEffectsActive, isGatewayRunning, designTeamKnown, designTeamId, designRunId, observeTeamDesign]);
  const openedDesignNavigationRef = useRef<string | null>(null);
  useEffect(() => {
    const surface = (location.state as { teamDesignSurface?: Extract<ChatRuntimeSurfaceDescriptor, { kind: 'team-graph' }> } | null)?.teamDesignSurface;
    if (!surface || openedDesignNavigationRef.current === location.key || !chatSideEffectsActive || !currentWorkspaceIdentity
      || surface.teamId !== designTeamId || surface.runId !== designRunId
      || buildSessionIdentityKey(surface.sourceSessionIdentity) !== buildSessionIdentityKey(currentWorkspaceIdentity)) return;
    openedDesignNavigationRef.current = location.key;
    openChatRuntimeSurface(surface);
  }, [location.key, location.state, chatSideEffectsActive, currentWorkspaceIdentity, designTeamId, designRunId]);
  const runDesignAction = async (action: (target: { teamId: string; runId: string }) => Promise<void>, focusComposer = false): Promise<void> => {
    if (!designTeamId || !designRunId || designActionPending) return;
    const contextKey = designContextKey;
    try {
      await action({ teamId: designTeamId, runId: designRunId });
      if (focusComposer && currentDesignContextRef.current === contextKey) composerRef.current?.focus();
    } catch (error) {
      toast.error(t('teams:design.actionFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };
  const chatWindowDock = useChatWindowDockController({
    enabled: workspaceActive && currentChatRuntimeAvailable,
    panelOpen: sidePanelIntentOpen,
    preferredWidth: sidePanelPreferredWidth,
    renderWidth: sidePanelRenderWidth,
    widthPolicy: sidePanelWidthPolicy,
    artifactWorkbenchFullscreen,
    chatLayoutRef,
    openPanel: openSidePanelDomain,
    closePanel: closeSidePanelDomain,
    setPanelWidth: setSidePanelWidth,
  });
  const sidePanelMode = chatWindowDock.sidePanelMode;
  const sidePanelWidth = chatWindowDock.sidePanelWidth;

  const {
    selectedSkillIds,
    allowedSkillIdsForChat,
    availableSkillOptions,
    skillsLoading: skillConfigSkillsLoading,
    savingSkillId,
    prepare: prepareSkillConfig,
    resetSession: resetSkillConfigSession,
    toggleSkill: toggleSkillConfigSelection,
  } = useAgentSkillConfig({
    currentAgentId,
  });

  useEffect(() => {
    resetSkillConfigSession();
    skillPreviewRequestSeqRef.current += 1;
    setSkillPreview(null);
  }, [currentAgentId, resetSkillConfigSession]);

  useEffect(() => {
    if (!currentChatRuntimeAvailable) {
      return;
    }
    void loadAvailableModels();
  }, [currentChatRuntimeAvailable, loadAvailableModels]);

  const currentSessionPermissionIdentity = useMemo(() => sessionIdentityToWire(
    currentSessionConversation?.sessionIdentity ?? currentSession.meta.sessionIdentity,
  ), [currentSession.meta.sessionIdentity, currentSessionConversation?.sessionIdentity]);
  const currentSessionPermissionIdentityKey = currentSessionPermissionIdentity
    ? JSON.stringify(currentSessionPermissionIdentity)
    : '';

  useEffect(() => {
    if (!isGatewayRunning || !currentSessionPermissionIdentity) {
      setSessionPermission(createSessionPermissionProjection());
      return;
    }
    let cancelled = false;
    setSessionPermission((current) => createSessionPermissionProjection({
      ...current,
      loading: true,
      switching: false,
      pending: false,
    }));
    void hostSessionPermissionGet({ identity: currentSessionPermissionIdentity })
      .then((result) => {
        if (!cancelled) {
          setSessionPermission(sessionPermissionProjectionFromResult(result));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSessionPermission(createSessionPermissionProjection());
          toast.error(t('input.permissionLoadFailed', { error: error instanceof Error ? error.message : String(error) }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentSessionPermissionIdentity, currentSessionPermissionIdentityKey, isGatewayRunning, t]);

  useEffect(() => {
    if (!chatSideEffectsActive) {
      return;
    }
    prepareSkillConfig();
  }, [prepareSkillConfig, chatSideEffectsActive]);
  const viewportItems = currentSession.items;
  const liveView = useChatView({
    currentSessionKey: currentSessionRecordKey,
    currentSessionStatus: currentSession.meta.historyStatus,
    itemCount: viewportItems.length,
    runActive: isRunActive(currentSession.runtime),
  });
  const assistantCatalogAgents = useMemo<ChatAssistantCatalogAgent[]>(
    () => agents.map((agent) => ({
      id: agent.id,
      agentName: agent.name,
      avatarSeed: agent.avatarSeed,
      avatarStyle: agent.avatarStyle,
    })),
    [agents],
  );
  const imageGenerationActive = isImageGenerationActive(currentSession.runtime);
  const imageGenerationLabel = t('input.imageGenerationActive');
  const pendingRunProgressLabel = buildRunProgressPendingLabel(currentSession.runtime.runProgress, t);
  const renderItems = useMemo(() => {
    const runtimePlaceholder = buildRuntimeAssistantPlaceholder({
      sessionKey: currentSessionRecordKey,
      runtime: currentSession.runtime,
      items: viewportItems,
      imageGenerationActive,
      imageGenerationLabel,
      pendingLabel: pendingRunProgressLabel,
    });
    const protocolItems = runtimePlaceholder ? [...viewportItems, runtimePlaceholder] : viewportItems;
    const nextItems = applyAssistantPresentationToItems({
      items: [...protocolItems],
      agents: assistantCatalogAgents,
      defaultAssistant: {
        agentId: currentAgentId,
        agentName: currentAgent?.name || currentAgentId,
        avatarSeed: currentAgent?.avatarSeed,
        avatarStyle: currentAgent?.avatarStyle,
      },
      previousItems: previousRenderedItemsRef.current ?? undefined,
    });
    previousRenderedItemsRef.current = nextItems;
    return nextItems;
  }, [assistantCatalogAgents, currentAgent?.avatarSeed, currentAgent?.avatarStyle, currentAgent?.name, currentAgentId, currentSession.runtime, currentSessionRecordKey, imageGenerationActive, imageGenerationLabel, pendingRunProgressLabel, viewportItems]);
  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    logSessionTrace('session.presentation.committed', 'session-presentation-boundary', {
      identity: summarizeSessionIdentity(connectorSessionIdentity), recordKey: summarizeIdentifier(currentSessionRecordKey),
      runtimePhase: currentSession.runtime.runPhase, activeRunHash: summarizeIdentifier(currentSession.runtime.activeRunId).hash,
      pendingTurnHash: summarizeIdentifier(currentSession.runtime.pendingTurnKey).hash,
      viewport: summarizeRenderItems(viewportItems), presentation: summarizeRenderItems(renderItems),
      placeholderHashes: renderItems.slice(0, 200).filter((item) => !viewportItems.some((original) => original.key === item.key))
        .map((item) => summarizeIdentifier(item.key).hash),
      placeholderCount: renderItems.length - viewportItems.length,
    });
  }, [connectorSessionIdentity, currentSession.runtime, currentSessionRecordKey, renderItems, viewportItems]);
  const artifactGroups = useMemo(() => collectChatArtifactGroups(renderItems), [renderItems]);
  const artifactFiles = useMemo(
    () => artifactGroups.flatMap((group) => group.files),
    [artifactGroups],
  );
  const artifactWorkbenchSelection = useMemo(() => resolveArtifactWorkbenchSelection({
    artifactGroups,
    focusedGroupKey: artifactFocusedGroupKey,
    focusedFilePath: artifactFocusedFilePath,
    focusedFileOverride: artifactFocusedFileOverride,
  }), [artifactFocusedFileOverride, artifactFocusedFilePath, artifactFocusedGroupKey, artifactGroups]);
  const artifactFocusedGroupFiles = artifactWorkbenchSelection.focusedGroupFiles;
  const artifactFocusedFile = artifactWorkbenchSelection.focusedFile;
  const defaultArtifactWorkspaceRoot = useMemo(() => {
    const endpoint = currentConversationEndpoint;
    const currentWorkspace = endpoint?.kind === 'native-runtime' && endpoint.runtimeAdapterId === 'openclaw'
      ? currentAgent?.workspace
      : undefined;
    return resolveArtifactWorkspaceRoot({
      currentWorkspace,
      artifactFiles,
      artifactFocusedFile,
    });
  }, [artifactFiles, artifactFocusedFile, currentAgent?.workspace, currentConversationEndpoint]);
  const artifactWorkspaceRoot = defaultArtifactWorkspaceRoot;
  const artifactWorkspaceContext = useMemo(() => ({
    workspaceRoot: artifactWorkspaceRoot || undefined,
  }), [artifactWorkspaceRoot]);
  const openGeneratedArtifact = useCallback((file: GeneratedFile, options?: OpenGeneratedArtifactOptions) => {
    const canShowChanges = supportsInlineDiff(file);
    const nextTarget = buildArtifactPreviewTargetFromGeneratedFile(file);
    setArtifactFocusedGroupKey(resolveArtifactGroupKeyForFile(artifactGroups, file.filePath));
    setActiveSidePanelTab('artifacts');
    setArtifactFocusedFilePath(file.filePath);
    setArtifactFocusedFileOverride(nextTarget);

    if (options?.preserveSection) {
      if (artifactActiveSection === 'changes' && canShowChanges) {
        setArtifactActiveSection('changes');
        setArtifactViewMode('diff');
        return;
      }
      setArtifactActiveSection('preview');
      setArtifactViewMode('preview');
      return;
    }

    if (file.sourceTool === 'edit' && canShowChanges) {
      setArtifactActiveSection('changes');
      setArtifactViewMode('diff');
      return;
    }
    setArtifactActiveSection('preview');
    setArtifactViewMode('preview');
  }, [artifactActiveSection, artifactGroups, setActiveSidePanelTab]);
  const handleOpenArtifactFile = useCallback((file: GeneratedFile) => {
    openGeneratedArtifact(file);
  }, [openGeneratedArtifact]);
  const handleOpenArtifactGroup = useCallback((groupKey: string, options?: OpenGeneratedArtifactOptions) => {
    const group = artifactGroups.find((entry) => entry.graphItemKey === groupKey) ?? null;
    if (!group) {
      return;
    }
    const focusTarget = resolvePreviewableArtifactGroupTarget(group, artifactFocusedFilePath);
    if (!focusTarget) {
      return;
    }
    setArtifactFocusedGroupKey(group.graphItemKey);
    setActiveSidePanelTab('artifacts');
    setArtifactFocusedFilePath(focusTarget.filePath);
    setArtifactFocusedFileOverride(focusTarget);

    const matchedGeneratedFile = group.files.find((file) => file.filePath === focusTarget.filePath) ?? null;
    if (matchedGeneratedFile) {
      const canShowChanges = supportsInlineDiff(matchedGeneratedFile);
      if (options?.preserveSection) {
        if (artifactActiveSection === 'changes' && canShowChanges) {
          setArtifactActiveSection('changes');
          setArtifactViewMode('diff');
          return;
        }
        if (artifactActiveSection === 'workspace') {
          setArtifactActiveSection('workspace');
          if (artifactViewMode === 'diff' && !canShowChanges) {
            setArtifactViewMode('preview');
          }
          return;
        }
        setArtifactActiveSection('preview');
        setArtifactViewMode('preview');
        return;
      }
      if (matchedGeneratedFile.sourceTool === 'edit' && canShowChanges) {
        setArtifactActiveSection('changes');
        setArtifactViewMode('diff');
        return;
      }
      setArtifactActiveSection('preview');
      setArtifactViewMode('preview');
      return;
    }

    if (focusTarget.isDirectory || focusTarget.mimeType === DIRECTORY_MIME_TYPE) {
      setArtifactActiveSection('workspace');
      return;
    }
    setArtifactActiveSection('preview');
    setArtifactViewMode('preview');
  }, [artifactActiveSection, artifactFocusedFilePath, artifactGroups, artifactViewMode, setActiveSidePanelTab]);
  const handleArtifactFocusTarget = useCallback((file: ArtifactPreviewTarget, options?: FocusArtifactTargetOptions) => {
    const matchedGeneratedFile = artifactFiles.find((entry) => entry.filePath === file.filePath);
    setArtifactFocusedGroupKey(resolveArtifactGroupKeyForFile(artifactGroups, file.filePath));
    setArtifactFocusedFilePath(file.filePath);
    setArtifactFocusedFileOverride(matchedGeneratedFile
      ? buildArtifactPreviewTargetFromGeneratedFile(matchedGeneratedFile)
      : file);
    if (file.isDirectory || file.mimeType === DIRECTORY_MIME_TYPE) {
      setArtifactActiveSection('workspace');
      return;
    }
    if (options?.preserveSection === 'workspace') {
      setArtifactActiveSection('workspace');
      if (artifactViewMode === 'diff' && !supportsInlineDiff(file)) {
        setArtifactViewMode('preview');
      }
      return;
    }
    setArtifactActiveSection('preview');
    if (artifactViewMode === 'diff' && !supportsInlineDiff(file)) {
      setArtifactViewMode('preview');
      return;
    }
    setArtifactViewMode('preview');
  }, [artifactFiles, artifactGroups, artifactViewMode]);
  useEffect(() => {
    if (artifactGroups.length > 0 || artifactFocusedGroupKey === null) {
      return;
    }
    setArtifactFocusedGroupKey(null);
  }, [artifactFocusedGroupKey, artifactGroups.length]);
  useEffect(() => {
    if (!artifactFocusedFile && artifactActiveSection !== 'workspace') {
      setArtifactActiveSection('workspace');
      return;
    }
    if (artifactFocusedFile && artifactActiveSection === 'workspace' && artifactFiles.length > 0) {
      return;
    }
  }, [artifactActiveSection, artifactFiles.length, artifactFocusedFile]);
  useEffect(() => {
    if (artifactActiveSection !== 'changes') {
      return;
    }
    if (!artifactFocusedFile || supportsInlineDiff(artifactFocusedFile)) {
      return;
    }
    setArtifactActiveSection('preview');
    setArtifactViewMode('preview');
  }, [artifactActiveSection, artifactFocusedFile]);
  const localizedRuntimeError = useMemo(() => {
    const hasRuntimeError = hasVisibleRuntimeError({
      runtime: currentSession.runtime,
      dismissedMarker: dismissedRuntimeError,
    });
    const localizedRuntimeIssue = hasRuntimeError
      ? localizeGatewayIssue(currentSession.runtime.lastIssue ?? undefined, t)
      : null;
    const runtimeMessage = hasRuntimeError
      ? (localizedRuntimeIssue ?? currentSession.runtime.lastError)
      : null;
    const currentRuntimeAdapterId = currentSession.meta.sessionIdentity?.endpoint.kind === 'native-runtime'
      ? currentSession.meta.sessionIdentity.endpoint.runtimeAdapterId
      : null;
    const fallbackGatewayRuntimeError = (
      localizedGatewayIssue
      && currentRuntimeAdapterId === 'openclaw'
      && (
        isRunActive(currentSession.runtime)
        || currentSession.runtime.runPhase === 'error'
      )
        ? localizedGatewayIssue
        : null
    );
    const effectiveRuntimeError = runtimeMessage ?? fallbackGatewayRuntimeError;
    if (!effectiveRuntimeError) {
      return null;
    }
    if (effectiveRuntimeError === ACTIVE_RUN_DISCONNECTED_ERROR) {
      return t('errors.activeRunDisconnected');
    }
    if (effectiveRuntimeError === ABORT_STOPPING_TIMEOUT_ERROR) {
      return t('errors.abortStoppingTimeout');
    }
    if (effectiveRuntimeError === ABORT_UNKNOWN_ERROR) {
      return t('errors.abortUnknown');
    }
    if (effectiveRuntimeError === ABORT_REJECTED_ERROR) {
      return t('errors.abortRejected');
    }
    if (effectiveRuntimeError === ABORT_REQUEST_FAILED_ERROR) {
      return t('errors.abortRequestFailed');
    }
    return effectiveRuntimeError;
  }, [currentSession.meta.sessionIdentity, currentSession.runtime, dismissedRuntimeError, localizedGatewayIssue, t]);
  useEffect(() => {
    if (!localizedRuntimeError) {
      setVisibleRuntimeError(null);
      return;
    }

    if (shouldShowRuntimeErrorBannerImmediately({
      runtime: currentSession.runtime,
      gatewayIssue: gatewayStatus.lastIssue,
      message: localizedRuntimeError,
    })) {
      setVisibleRuntimeError(localizedRuntimeError);
      return;
    }

    const timeout = window.setTimeout(() => {
      setVisibleRuntimeError(localizedRuntimeError);
    }, TRANSIENT_RUNTIME_ERROR_BANNER_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [currentSession.runtime, gatewayStatus.lastIssue, localizedRuntimeError]);
  const currentSessionModelReference = currentSession.meta.modelState?.selectionId
    ?? currentSession.meta.modelState?.selected?.ref
    ?? '';
  const currentSessionModelEntry = useMemo(() => {
    return resolveModelCatalogEntry(availableModels, currentSessionModelReference);
  }, [availableModels, currentSessionModelReference]);
  const currentSessionModelId = currentSessionModelEntry?.id ?? currentSessionModelReference;
  const contextUsage = useMemo(() => buildChatContextUsageViewModel({
    snapshot: currentSession.contextTokens,
    currentModelId: currentSessionModelId,
    availableModels,
  }), [availableModels, currentSession.contextTokens, currentSessionModelId]);
  const [workspaceRecoveryPending, setWorkspaceRecoveryPending] = useState(false);
  const handleChooseWorkspaceForCurrentAgent = useCallback(async () => {
    if (!canChooseWorkspaceForCurrentAgent || !currentAgent || workspaceRecoveryPending) {
      return;
    }
    setWorkspaceRecoveryPending(true);
    try {
      const selectedPath = await pickLocalDirectory({
        title: t('workspaceUnavailable.pickTitle'),
        defaultPath: currentWorkspacePath || undefined,
        buttonLabel: t('workspaceUnavailable.pickButton'),
      });
      if (!selectedPath) {
        return;
      }
      await updateAgent({
        agentId: currentAgentId,
        name: currentAgent.name ?? currentAgentId,
        workspace: selectedPath,
        model: currentAgent.model,
      });
      await newSession(currentAgentId);
      toast.success(t('workspaceUnavailable.updateSuccess'));
    } catch (error) {
      toast.error(t('workspaceUnavailable.updateFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setWorkspaceRecoveryPending(false);
    }
  }, [canChooseWorkspaceForCurrentAgent, currentAgent, currentAgentId, currentWorkspacePath, newSession, t, updateAgent, workspaceRecoveryPending]);
  const runtimeStatusDock = currentSession.runtime.runtimeActivity === 'compacting' || currentSession.runtime.errorDetail || currentSession.runtime.runtimeNotice ? (
    <ChatRuntimeStatusDock
      compacting={currentSession.runtime.runtimeActivity === 'compacting'}
      errorDetail={currentSession.runtime.errorDetail}
      runtimeNotice={currentSession.runtime.runtimeNotice}
    />
  ) : null;
  const workspaceUnavailableBanner = currentWorkspaceUnavailable ? (
    <div className="mx-auto w-full max-w-[56rem] rounded-[22px] border border-yellow-500/24 bg-card px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3 text-left">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t('workspaceUnavailable.title')}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('workspaceUnavailable.description', { path: currentWorkspacePath || t('workspaceUnavailable.unknownPath') })}
          </p>
          {canChooseWorkspaceForCurrentAgent ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 h-8 rounded-full border-yellow-500/28 bg-background/95 px-3 text-xs text-foreground hover:bg-background"
              disabled={workspaceRecoveryPending}
              onClick={() => {
                void handleChooseWorkspaceForCurrentAgent();
              }}
            >
              {workspaceRecoveryPending
                ? t('workspaceUnavailable.updating')
                : t('workspaceUnavailable.chooseWorkspaceAndNewSession')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  ) : null;
  const activeRun = isRunActive(currentSession.runtime)
    || currentSession.runtime.activeRunId != null;
  const modelPicker = useMemo(() => {
    const currentModelId = currentSessionModelId;
    if (!currentModelId && availableModels.length === 0 && !modelsLoading) {
      return null;
    }
    const triggerLabels = new Map<string, string>();
    for (const model of availableModels) {
      triggerLabels.set(model.id, model.modelLabel);
    }
    const options = availableModels.map((model) => ({
      id: model.id,
      label: model.displayLabel,
    }));
    return {
      currentModelId,
      currentLabel: currentModelId
        ? triggerLabels.get(currentModelId) ?? resolveModelTriggerLabel(currentModelId)
        : t('input.pickModel'),
      options,
      loading: modelsLoading,
      switching: false,
      disabled: activeRun || !currentSessionRecordKey,
    };
  }, [activeRun, availableModels, currentSessionModelId, currentSessionRecordKey, modelsLoading, t]);
  const handleSendMessage = useCallback(async (
    text: string,
    attachments?: Parameters<typeof sendMessage>[1],
  ) => {
    viewportPaneRef.current?.prepareCurrentLatestBottomAlign();
    return sendMessage(text, attachments);
  }, [sendMessage]);
  const handleExportMarkdown = useCallback(() => {
    if (exportingMarkdown || !currentSessionRecordKey || !currentSessionConversation) {
      return;
    }
    setExportingMarkdown(true);
    void (async () => {
      try {
        const target = resolveSessionOperationTarget(useChatStore.getState(), currentSessionRecordKey);
        const protocolItems = await fetchChatMarkdownExportItems({
          ...(target.endpointSessionId ? { endpointSessionId: target.endpointSessionId } : {}),
          sessionIdentity: target.sessionIdentity,
          currentItems: viewportItems,
          currentWindow: currentSession.window,
        });
        const items = applyAssistantPresentationToItems({
          items: [...protocolItems],
          agents: assistantCatalogAgents,
          defaultAssistant: {
            agentId: currentAgentId,
            agentName: currentAgent?.name || currentAgentId,
            avatarSeed: currentAgent?.avatarSeed,
            avatarStyle: currentAgent?.avatarStyle,
          },
        });
        const exportedSession = buildChatSessionMarkdownExport({
          title: currentSession.meta.displayName || currentSession.meta.label || currentAgent?.name || currentSessionRecordKey,
          sessionKey: currentSessionConversation.sessionIdentity.sessionKey || currentSessionRecordKey,
          agentName: currentAgent?.name || currentAgentId,
          items,
          exportedAt: new Date(),
        });
        downloadMarkdownFile(exportedSession.fileName, exportedSession.markdown);
      } catch (error) {
        toast.error(t('errors.exportMarkdownFailed', { error: error instanceof Error ? error.message : String(error) }));
      } finally {
        setExportingMarkdown(false);
      }
    })();
  }, [assistantCatalogAgents, currentAgent?.avatarSeed, currentAgent?.avatarStyle, currentAgent?.name, currentAgentId, currentSession.meta.displayName, currentSession.meta.label, currentSession.window, currentSessionConversation, currentSessionRecordKey, exportingMarkdown, t, viewportItems]);
  const handleReuseMessage = useCallback((text: string) => {
    composerRef.current?.replaceText(text);
  }, []);
  const handleComposerWheel = useCallback((deltaY: number) => {
    viewportPaneRef.current?.scrollByWheelDelta(deltaY);
  }, []);
  const handleComposerGeometryChange = useCallback(() => {
    viewportPaneRef.current?.notifyComposerGeometryChanged();
  }, []);
  const handleSelectModel = useCallback(async (modelSelectionId: string) => {
    const traceId = createSessionTraceId('model-selection');
    const normalizedModelSelectionId = modelSelectionId.trim();
    const currentModelSelectionId = currentSessionModelId;
    logSessionTrace('model-selection.enter', traceId, {
      currentSessionKey: summarizeIdentifier(currentSessionRecordKey),
      requestedModelSelectionId: summarizeIdentifier(normalizedModelSelectionId),
      currentModelSelectionId: summarizeIdentifier(currentModelSelectionId),
      activeRun: Boolean(activeRun),
    });
    if (!currentSessionRecordKey || !currentSessionConversation) {
      logSessionTrace('model-selection.skipped', traceId, { reason: 'missing-current-session' });
      return;
    }
    if (!normalizedModelSelectionId || normalizedModelSelectionId === currentModelSelectionId) {
      logSessionTrace('model-selection.skipped', traceId, {
        reason: !normalizedModelSelectionId ? 'missing-model-selection' : 'unchanged-model-selection',
      });
      return;
    }
    if (activeRun) {
      logSessionTrace('model-selection.skipped', traceId, { reason: 'active-run' });
      return;
    }
    try {
      const target = resolveSessionOperationTarget(useChatStore.getState(), currentSessionRecordKey);
      logSessionTrace('model-selection.target', traceId, {
        recordKey: summarizeIdentifier(currentSessionRecordKey),
        endpointSessionId: summarizeIdentifier(target.endpointSessionId),
        sessionIdentity: summarizeSessionIdentity(target.sessionIdentity),
        modelSelectionId: summarizeIdentifier(normalizedModelSelectionId),
      });
      const result = await hostSessionPatch({
        ...(target.endpointSessionId ? { endpointSessionId: target.endpointSessionId } : {}),
        sessionIdentity: target.sessionIdentity,
        modelSelectionId: normalizedModelSelectionId,
      }, { traceId });
      logSessionTrace('model-selection.result', traceId, { outcome: result.outcome });
      if (result.outcome !== 'succeeded') {
        throw new Error(result.outcome);
      }
      useChatStore.setState((state) => ({
        loadedSessions: patchSessionMeta(state, currentSessionRecordKey, {
          modelState: result.modelState,
        }),
      }));
      void loadSessions();
    } catch (error) {
      logSessionTrace('model-selection.error', traceId, summarizeError(error));
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('input.modelSwitchFailed', { error: message }));
    }
  }, [activeRun, currentSessionConversation, currentSessionModelId, currentSessionRecordKey, loadSessions, t]);

  const handleSelectSessionPermission = useCallback(async (selection: SessionPermissionSelection) => {
    if (!currentSessionPermissionIdentity
      || selection === sessionPermission.mode
      || sessionPermission.loading
      || sessionPermission.switching
      || sessionPermission.pending
      || !sessionPermission.supported
      || activeRun
      || (selection === 'full' && !sessionPermission.canSelectFull)) {
      return;
    }
    const previousPermission = sessionPermission;
    setSessionPermission(createSessionPermissionProjection({
      ...sessionPermission,
      switching: true,
      pending: true,
      mode: selection,
    }));
    try {
      const result = await hostSessionPermissionSet({
        identity: currentSessionPermissionIdentity,
        selection,
      });
      setSessionPermission(sessionPermissionProjectionFromResult(result));
    } catch (error) {
      setSessionPermission(createSessionPermissionProjection({
        ...previousPermission,
        switching: false,
        pending: false,
      }));
      toast.error(t('input.permissionSwitchFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [activeRun, currentSessionPermissionIdentity, sessionPermission, t]);

  const handlePreviewSkill = useCallback(async (skill: {
    id: string;
    name: string;
    slug?: string;
    filePath?: string;
    baseDir?: string;
  }) => {
    const requestSeq = skillPreviewRequestSeqRef.current + 1;
    skillPreviewRequestSeqRef.current = requestSeq;
    setSkillPreview({
      skillId: skill.id,
      skillName: skill.name,
      markdown: null,
      loading: true,
      error: null,
      filePath: skill.filePath,
    });
    try {
      const result = await hostApiFetch<{
        success: boolean;
        content?: string;
        error?: string;
        filePath?: string;
      }>('/api/skills/readme', {
        method: 'POST',
        body: JSON.stringify({
          skillKey: skill.id,
          slug: skill.slug,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
        }),
      });
      if (skillPreviewRequestSeqRef.current !== requestSeq) {
        return;
      }
      if (!result.success || typeof result.content !== 'string') {
        throw new Error(result.error || t('skillPreviewNotFound'));
      }
      setSkillPreview({
        skillId: skill.id,
        skillName: skill.name,
        markdown: result.content,
        loading: false,
        error: null,
        filePath: result.filePath || skill.filePath,
      });
    } catch (error) {
      if (skillPreviewRequestSeqRef.current !== requestSeq) {
        return;
      }
      setSkillPreview({
        skillId: skill.id,
        skillName: skill.name,
        markdown: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        filePath: skill.filePath,
      });
    }
  }, [t]);
  const inputNode = (
    <ChatInput
      ref={composerRef}
      draft={composerDraft}
      draftKey={currentComposerDraftKey}
      onDraftChange={handleComposerDraftChange}
      onDraftSelectionChange={handleComposerSelectionChange}
      draftSelection={composerSelection}
      onSend={handleSendMessage}
      goal={{
        supported: goalSupported,
        mode: chatGoals.mode,
        busy: chatGoals.busy,
        unknown: chatGoals.unknown,
        canDiscard: chatGoals.canDiscard ?? false,
        error: chatGoals.error,
        onRefresh: () => { void chatGoals.refresh(); },
        onStart: () => beginTypedGoal(),
        onCancel: chatGoals.cancel,
        onSubmit: submitTypedGoal,
      }}
      goalDock={goalSupported ? <ChatGoalDock
        key={currentComposerDraftKey}
        view={currentSession.meta.goal}
        busy={chatGoals.busy}
        runActive={activeRun}
        disabled={!chatSideEffectsActive || chatGoals.unknown || Boolean(chatGoals.mode)}
        error={chatGoals.error}
        onEdit={() => { const goal = currentSession.meta.goal; if (goal.kind === 'known' && goal.goal) beginTypedGoal(goal.goal.id, goal.goal.objective); }}
        onAction={(update) => { const goal = currentSession.meta.goal; if (goal.kind === 'known' && goal.goal) void chatGoals.act(goal.goal.id, update); }}
        onRefresh={() => { void chatGoals.refresh(); }}
      /> : null}
      onStop={abortRun}
      skillManager={{
        label: t('toolbar.skillConfig'),
        title: t('skillConfigDialog.titleWithAgent', { agent: currentAgent?.name || currentAgentId }),
        options: availableSkillOptions,
        loading: skillConfigSkillsLoading,
        savingSkillId,
        selectedSkillIds,
        skillPreview,
        onToggleSkill: toggleSkillConfigSelection,
        onPreviewSkill: handlePreviewSkill,
        onClearSkillPreview: () => setSkillPreview(null),
      }}
      modelPicker={modelPicker ? {
        ...modelPicker,
        onSelect: (modelSelectionId) => {
          void handleSelectModel(modelSelectionId);
        },
      } : null}
      permissionPicker={{
        ...sessionPermission,
        disabled: !isGatewayRunning || activeRun || !currentSessionPermissionIdentity,
        onSelect: (mode) => {
          void handleSelectSessionPermission(mode);
        },
      }}
      contextUsage={contextUsage}
      teamDesign={designTeamId && designRunId && currentWorkspaceIdentity && designSnapshot?.startGate.status !== 'started' ? {
        active: designActive,
        disabled: !designTeamKnown || !designSnapshot || Boolean(designRecord?.loading) || designActionPending || !isGatewayRunning,
        onStart: () => {
          openChatRuntimeSurface({ kind: 'team-graph', sourceSessionIdentity: currentWorkspaceIdentity, teamId: designTeamId, runId: designRunId });
          void runDesignAction(startDesign, true);
        },
        onExit: () => { void runDesignAction(continueDesignDiscussion, true); },
      } : null}
      disabled={!currentChatRuntimeAvailable || currentWorkspaceUnavailable}
      reconnecting={currentRuntimeReconnecting}
      sending={isRunActive(currentSession.runtime)}
      imageGenerationActive={imageGenerationActive}
      sendGate={currentSendGate}
      stopping={currentSession.runtime.runPhase === 'stopping'}
      approvalWaiting={approvalStatus === 'awaiting_approval'}
      allowedSkillIds={allowedSkillIdsForChat}
      sessionIdentity={connectorSessionIdentity}
      endpointSessionId={connectorEndpointSessionId}
      activeRunId={currentSession.runtime.activeRunId}
      runPhase={currentSession.runtime.runPhase}
    />
  );
  const welcomeInputNode = workspaceUnavailableBanner ? (
    <div className="space-y-2">
      {workspaceUnavailableBanner}
      {inputNode}
    </div>
  ) : inputNode;

  if (sessionRuntimeInitializing) {
    return (
      <ChatOffline
        title={t('runtimePreparing.title')}
        description={t('runtimePreparing.description')}
        tone="loading"
      />
    );
  }

  if (!currentChatRuntimeAvailable && currentSession.items.length === 0) {
    return (
      <ChatOffline
        title={t('runtimeUnavailable.title')}
        description={(currentConversationRuntime.state === 'unavailable' ? currentConversationRuntime.error : sessionRuntimeCatalog.error) || t('runtimeUnavailable.description')}
      />
    );
  }

  return (
    <AssistantPendingLabelProvider label={pendingRunProgressLabel}>
      {workspaceActive && designTeamId && !designTeamKnown ? (
        <div role="alert" className="flex items-center gap-2 p-3 text-sm text-destructive">
          {t('teams:chat.teamNotFound')}
          <Button variant="outline" size="sm" onClick={() => navigate('/teams')}>{t('teams:chat.backToList')}</Button>
        </div>
      ) : null}
      {workspaceActive && designTeamKnown && designProposal ? (
        <TeamDesignDialog
          summary={designProposal.taskSummary}
          busy={designActionPending || Boolean(designRecord?.loading)}
          error={designRecord?.error ?? undefined}
          onConfirm={() => { void runDesignAction(confirmDesign); }}
          onReturnDiscussion={() => { void runDesignAction(continueDesignDiscussion, true); }}
          onContinueDesign={() => { void runDesignAction(continueDesign, true); }}
        />
      ) : null}
      <ChatShell
        chatLayoutRef={chatLayoutRef}
        sidePanelPhase={chatWindowDock.phase}
        sidePanelMode={sidePanelMode}
        sidePanelWidth={sidePanelWidth}
        sidePanelMainWidth={chatWindowDock.sidePanelMainWidth}
        sidePanelVisible={chatWindowDock.sidePanelVisible}
        artifactWorkbenchFullscreen={artifactWorkbenchFullscreen}
        onSidePanelResize={chatWindowDock.resizeSidePanelWidth}
        onSidePanelResizeCommit={chatWindowDock.commitSidePanelWidth}
        onComposerWheel={handleComposerWheel}
        onComposerGeometryChange={handleComposerGeometryChange}
        isEmptyState={liveView.isEmptyState && chatQuestions.questions.length === 0 && !chatQuestions.error}
        emptyState={<WelcomeScreen input={welcomeInputNode} />}
        sidePanel={(
          <ChatSidePanel
            mode={sidePanelMode}
            width={sidePanelWidth}
            activeTab={activeSidePanelTab}
            teamGraphSurface={teamGraphSurface}
            artifactWorkbenchFullscreen={artifactWorkbenchFullscreen}
            onTabChange={setActiveSidePanelTab}
            onClose={chatWindowDock.closeSidePanel}
            onToggleArtifactWorkbenchFullscreen={toggleArtifactWorkbenchFullscreen}
            artifactGroups={artifactGroups}
            artifactFocusedGroupKey={artifactWorkbenchSelection.focusedGroupKey}
            artifactFocusedGroupFiles={artifactFocusedGroupFiles}
            artifactFocusedFile={artifactFocusedFile}
            artifactActiveSection={artifactActiveSection}
            artifactViewMode={artifactViewMode}
            artifactWorkspaceRoot={artifactWorkspaceRoot}
            artifactWorkspaceContext={artifactWorkspaceContext}
            onArtifactFocusFile={handleArtifactFocusTarget}
            onOpenGeneratedArtifactFile={openGeneratedArtifact}
            onOpenArtifactGroup={handleOpenArtifactGroup}
            onArtifactSectionChange={setArtifactActiveSection}
            onArtifactViewModeChange={setArtifactViewMode}
            sessionIdentity={currentSession.meta.sessionIdentity ?? undefined}
            onArtifactRevealInFileManager={(filePath) => {
              void invokeIpc('shell:showItemInFolder', filePath).then((result) => {
                if (result && typeof result === 'object' && 'success' in result && (result as { success?: boolean }).success === false) {
                  toast.error(t('artifacts.revealFailed'));
                }
              }).catch(() => {
                toast.error(t('artifacts.revealFailed'));
              });
            }}
          />
        )}
        header={(
          <ChatHeaderBar
            showThinking={showThinking}
            onToggleThinking={toggleThinking}
            exportDisabled={exportingMarkdown || !currentSessionRecordKey}
            onExportMarkdown={handleExportMarkdown}
            sidePanelOpen={chatWindowDock.sidePanelExpanded}
            onToggleSidePanel={chatWindowDock.toggleSidePanel}
            todoPanel={<SessionTodoPanel sessionKey={currentSessionRecordKey} />}
          />
        )}
        viewportPane={(
          <ChatList
            ref={viewportPaneRef}
            isActive={workspaceActive}
            currentSessionKey={currentSessionRecordKey}
            runtime={currentSession.runtime}
            viewport={currentSession.window}
            items={renderItems}
            onReuseMessage={handleReuseMessage}
            liveView={liveView}
            errorMessage={localizedRuntimeError}
            showThinking={showThinking}
            userAvatarDataUrl={userAvatarDataUrl}
            sessionIdentity={currentSession.meta.sessionIdentity ?? undefined}
            endpointSessionId={currentSession.meta.endpointSessionId}
            workspaceContext={artifactWorkspaceContext}
            artifactGroups={artifactGroups}
            onOpenArtifactFile={handleOpenArtifactFile}
            onOpenAttachedArtifact={(file) => {
              if (file.source === 'user-upload') {
                return;
              }
              const target = buildArtifactPreviewTargetFromAttachedFile(file);
              if (!target) {
                return;
              }
              setActiveSidePanelTab('artifacts');
              handleArtifactFocusTarget(target);
            }}
            onLoadOlder={() => {
              if (!currentSessionRecordKey) return;
              void loadOlderViewportItems(currentSessionRecordKey);
            }}
            loadOlderLabel={t('liveThread.loadOlder')}
            onJumpToLatest={() => {
              if (!currentSessionRecordKey) return;
              void jumpViewportToLatest(currentSessionRecordKey);
            }}
            jumpToBottomLabel={t('liveThread.jumpToBottom')}
          />
        )}
        errorBanner={workspaceUnavailableBanner ?? (visibleRuntimeError ? (
          <ChatErrorBanner
            error={visibleRuntimeError}
            dismissLabel={t('common:actions.dismiss')}
            onDismiss={clearError}
          />
        ) : runtimeStatusDock)}
        approvalDock={approvalStatus === 'awaiting_approval' || chatQuestions.questions.length > 0 || chatQuestions.error ? (
          <>
            {approvalStatus === 'awaiting_approval' ? (
              <ChatApprovalDock
                waitingLabel={t('approval.waitingLabel')}
                approvals={currentPendingApprovals}
                onResolve={(approval, decision) => {
                  void resolveApproval(approval, decision);
                }}
              />
            ) : null}
            <ChatQuestionDock
              key={chatQuestions.scopeKey}
              questions={chatQuestions.questions}
              confirmed={chatQuestions.confirmed}
              error={chatQuestions.error}
              submittingId={chatQuestions.submittingId}
              onRefresh={chatQuestions.refresh}
              onResolve={chatQuestions.resolve}
            />
          </>
        ) : null}
        input={inputNode}
      />
    </AssistantPendingLabelProvider>
  );
}

export default Chat;
