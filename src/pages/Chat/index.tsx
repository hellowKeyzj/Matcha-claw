import { traceLog } from '@/lib/trace-logger';
/**
 * Chat Page
 * Native React implementation using runtime-host session APIs.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type ApprovalItem, type ChatSessionRuntimeState, type ChatStoreState } from '@/stores/chat';
import { selectCurrentChatSendGate, selectRuntimeAgentScope } from '@/stores/chat/selectors';
import {
  ABORT_STOPPING_TIMEOUT_ERROR,
  ABORT_UNKNOWN_ERROR,
  ABORT_REJECTED_ERROR,
  ABORT_REQUEST_FAILED_ERROR,
} from '@/stores/chat/abort-handlers';
import { isRunActive } from '@/stores/chat/types';
import { buildCurrentConversationFromSessionRecord, resolveCurrentConversationRuntimeState } from '@/stores/chat/session-runtime-graph';
import { isRuntimeEndpointReady, supportsSessionGoal, supportsRuntimeEndpointCapabilityFamily, useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useSettingsStore } from '@/stores/settings';
import { resolveTeamRuntimeScope, useTeamsStore } from '@/stores/teams';
import type { TeamDesignTarget } from '@/types/team-design';
import { useComposerDraftStore, clampComposerDraftSelection, type ComposerDraftSelection } from '@/stores/composer-drafts';
import type { GatewayTransportIssue } from '../../types/session/runtime-state';
import {
  agentScope,
  buildCapabilityScopeKey,
  buildSessionIdentityKey,
  runtimeEndpointsEqual,
  runtimeInstanceScope,
  sessionIdentitiesEqual,
  sessionScope,
  type SessionIdentity,
} from '../../types/desktop/runtime-address';
import { getCronSessionBaseKey, parseCronSessionKey } from '@/stores/chat/cron-session-utils';
import type {
  SessionRenderItem,
} from '../../types/session/render-item';
import type {
  SessionWindowStateSnapshot,
} from '../../types/session/snapshot';
import { isGatewayOperational } from '@/lib/gateway-status';
import {
  createEmptySessionRecord,
  getPendingApprovals,
  getSessionApprovalStatus,
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
import { useSessionQuestions } from './useSessionQuestions';
import { SessionQuestionDock } from './components/SessionQuestionDock';
import { useChatGoals } from './useChatGoals';
import { useChatPermissions } from './useChatPermissions';
import { ChatGoalDock } from './ChatGoalDock';
import { ChatQuestionDock } from './components/ChatQuestionDock';
import {
  applyAssistantPresentationToItems,
  type ChatAssistantCatalogAgent,
  type ChatRenderItem,
} from './chat-render-item-model';
import {
  hostApiFetch,
  hostCapabilityDescribe,
  hostSessionWindowFetch,
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

type ChatRuntimeBranch = 'starting' | 'unselected' | 'unavailable' | 'ready';

function isImageGenerationActive(runtime: ChatSessionRuntimeState): boolean {
  return runtime.imageGeneration?.active === true;
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
  const providerModels = useSubagentsStore((state) => state.availableModels);
  const providerModelsLoading = useSubagentsStore((state) => state.modelsLoading);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const updateAgent = useSubagentsStore((state) => state.updateAgent);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const managementScope = useSubagentsStore((state) => state.managementScope);
  const currentAgent = currentAgentId && managementScope && currentConversation
    && runtimeEndpointsEqual(managementScope.endpoint, currentConversation.endpoint)
    ? agents.find((agent) => agent.id === currentAgentId) : undefined;
  const loadedSessionsForDraftCleanup = useChatStore((state) => state.loadedSessions);
  const loadedSessionKeys = useMemo(() => Object.keys(loadedSessionsForDraftCleanup), [loadedSessionsForDraftCleanup]);
  const composerDraft = useComposerDraftStore((state) => currentComposerDraftKey ? state.drafts[currentComposerDraftKey] ?? '' : '');
  const rawComposerSelection = useComposerDraftStore((state) => currentComposerDraftKey ? state.selections[currentComposerDraftKey] ?? null : null);
  const composerSelection = useMemo(() => clampComposerDraftSelection(rawComposerSelection, composerDraft), [composerDraft, rawComposerSelection]);
  const setComposerDraft = useComposerDraftStore((state) => state.setDraft);
  const clearComposerDraft = useComposerDraftStore((state) => state.clearDraft);
  const setComposerSelection = useComposerDraftStore((state) => state.setSelection);
  const composerConfiguration = useComposerDraftStore((state) => currentComposerDraftKey ? state.configurations[currentComposerDraftKey] : undefined);
  const composerInitialization = useComposerDraftStore((state) => currentComposerDraftKey ? state.initializations[currentComposerDraftKey] : undefined);
  const setModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const setPermissionSelection = useComposerDraftStore((state) => state.setPermissionSelection);
  const userAvatarDataUrl = useSettingsStore((state) => state.userAvatarDataUrl);
  const [skillPreview, setSkillPreview] = useState<ChatSkillPreviewState | null>(null);
  const [artifactActiveSection, setArtifactActiveSection] = useState<ChatArtifactSection>('changes');
  const [artifactFocusedGroupKey, setArtifactFocusedGroupKey] = useState<string | null>(null);
  const [artifactFocusedFilePath, setArtifactFocusedFilePath] = useState<string | null>(null);
  const [artifactFocusedFileOverride, setArtifactFocusedFileOverride] = useState<ArtifactPreviewTarget | null>(null);
  const [artifactViewMode, setArtifactViewMode] = useState<'preview' | 'diff'>('diff');
  const [artifactSelectionOwnerKey, setArtifactSelectionOwnerKey] = useState(currentComposerDraftKey);
  if (artifactSelectionOwnerKey !== currentComposerDraftKey) {
    setArtifactSelectionOwnerKey(currentComposerDraftKey);
    setArtifactFocusedGroupKey(null);
    setArtifactFocusedFilePath(null);
    setArtifactFocusedFileOverride(null);
  }
  const [visibleRuntimeError, setVisibleRuntimeError] = useState<string | null>(null);
  const [exportingMarkdown, setExportingMarkdown] = useState(false);
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
  const isOpenClawModelSession = currentConversationEndpoint?.kind === 'native-runtime' && currentConversationEndpoint.runtimeAdapterId === 'openclaw';
  const isMatchaModelSession = currentConversationEndpoint?.kind === 'native-runtime' && currentConversationEndpoint.runtimeAdapterId === 'matcha-agent';
  const usesHostModelCandidates = isOpenClawModelSession || isMatchaModelSession;
  const availableModels = usesHostModelCandidates ? providerModels : EMPTY_AGENTS;
  const modelsLoading = usesHostModelCandidates && providerModelsLoading;
  const currentChatRuntimeAvailable = currentConversationRuntime.state === 'ready';
  const currentConfigurationScope = useMemo(() => currentConversationEndpoint && currentAgentId
    ? agentScope(currentConversationEndpoint, currentAgentId) : null, [currentAgentId, currentConversationEndpoint]);
  const currentSkillsScope = useMemo(() => isOpenClawModelSession && currentConversationEndpoint
    ? runtimeInstanceScope(currentConversationEndpoint) : isMatchaModelSession ? currentConfigurationScope : null,
  [currentConfigurationScope, currentConversationEndpoint, isMatchaModelSession, isOpenClawModelSession]);
  const currentDraftScope = currentConversation?.kind === 'draft' ? currentConfigurationScope : null;
  const draftConfigurationScopeKey = currentDraftScope ? buildCapabilityScopeKey(currentDraftScope) : '';
  const draftConfigurationOwner = useMemo(() => ({ scope: currentDraftScope, ready: currentChatRuntimeAvailable, scopeKey: draftConfigurationScopeKey }), [currentDraftScope, currentChatRuntimeAvailable, draftConfigurationScopeKey]);
  const [draftConfigurationCapability, setDraftConfigurationCapability] = useState<{
    owner: typeof draftConfigurationOwner; permission: boolean; modelSelection: boolean;
  } | null>(null);
  const draftConfigurationReady = currentChatRuntimeAvailable && Boolean(currentDraftScope)
    && draftConfigurationCapability?.owner === draftConfigurationOwner;
  const composerInitializationBusy = composerInitialization?.kind === 'creating' || composerInitialization?.kind === 'createUnknown'
    || composerInitialization?.kind === 'pending' && !composerInitialization.outcome;
  const composerConfigurationStatus = composerInitialization?.kind === 'createUnknown' ? t('input.configurationCreateUnknown')
    : composerInitialization?.kind === 'creating' ? t('input.configurationCreating')
      : composerInitialization?.kind === 'pending' && composerInitialization.outcome
        ? t(`input.configurationOutcome.${composerInitialization.outcome}`) : null;
  const sessionRuntimeInitializing = currentSession.items.length === 0 && (
    currentConversationRuntime.state === 'resolving'
    || currentConversationRuntime.state === 'starting'
    || (currentConversationRuntime.state === 'unselected' && runtimeEndpointDirectory.status !== 'error'
      && (sessionRuntimeCatalog.status === 'idle' || sessionRuntimeCatalog.status === 'loading'))
  );
  const currentRuntimeReconnecting = currentConversationRuntime.state === 'starting';
  const currentWorkspaceIdentity = currentSessionConversation?.sessionIdentity ?? currentSession.meta.sessionIdentity;
  const teamOwnership = currentWorkspaceIdentity && currentSession.meta.sessionIdentity
    && sessionIdentitiesEqual(currentWorkspaceIdentity, currentSession.meta.sessionIdentity)
    ? currentSession.meta.ownership : null;
  const teamGraphTeamId = teamOwnership?.kind === 'team' ? teamOwnership.teamId : null;
  const teamGraphRunId = teamOwnership?.kind === 'team' ? teamOwnership.teamRunId : null;
  const designTeamId = teamOwnership?.kind === 'team' && teamOwnership.roleId === 'leader' ? teamGraphTeamId : null;
  const designRunId = teamOwnership?.kind === 'team' && teamOwnership.roleId === 'leader' ? teamGraphRunId : null;
  const designTeamKnown = useTeamsStore((state) => Boolean(designTeamId && state.teams.some((team) => team.id === designTeamId)));
  const designRuntimeAvailable = designTeamKnown && designTeamId && designRunId
    ? runtimeEndpointDirectory.endpoints.some((entry) => {
        const scope = resolveTeamRuntimeScope(designTeamId, designRunId);
        return 'endpoint' in scope && runtimeEndpointsEqual(entry.endpointRef, scope.endpoint)
          && isRuntimeEndpointReady(entry) && supportsRuntimeEndpointCapabilityFamily(entry, 'team');
      }) : false;
  const designRecord = useTeamsStore((state) => designRunId ? state.designByRunId[designRunId] : undefined);
  const observeTeamDesign = useTeamsStore((state) => state.observeTeamDesign);
  const startDesign = useTeamsStore((state) => state.startDesign);
  const startRun = useTeamsStore((state) => state.startRun);
  const exitDesign = useTeamsStore((state) => state.exitDesign);
  const designActionPending = Boolean(designRecord?.mutationPending);
  const designSnapshot = designRecord?.snapshot && designRecord.snapshot.teamId === designTeamId && designRecord.snapshot.runId === designRunId ? designRecord.snapshot : null;
  const designContextKey = JSON.stringify([designTeamId, designRunId, currentWorkspaceIdentity ? buildSessionIdentityKey(currentWorkspaceIdentity) : null]);
  const [pendingDesignAction, setPendingDesignAction] = useState<{ contextKey: string; action: 'start' | 'exit' } | null>(null);
  const currentDesignContextRef = useRef(designContextKey);
  currentDesignContextRef.current = designContextKey;
  const currentWorkspacePath = currentAgent?.workspace?.trim() ?? '';
  const handleComposerDraftChange = useCallback((update: SetStateAction<string>) => {
    setComposerDraft(currentComposerDraftKey, update);
  }, [currentComposerDraftKey, setComposerDraft]);
  const handleComposerSelectionChange = useCallback((selection: ComposerDraftSelection) => {
    setComposerSelection(currentComposerDraftKey, selection);
  }, [currentComposerDraftKey, setComposerSelection]);
  const canChooseWorkspaceForCurrentAgent = !!currentAgent
    && currentConversationEndpoint?.kind === 'native-runtime' && currentConversationEndpoint.runtimeAdapterId === 'openclaw'
    && (currentAgent.kind !== 'system' || Boolean(currentAgent.isDefault))
    && !!currentAgentId;
  const chatRuntimeBranch: ChatRuntimeBranch = currentConversationRuntime.state === 'resolving'
    ? 'starting'
    : currentConversationRuntime.state;
  const chatSideEffectsActive = workspaceActive && currentChatRuntimeAvailable;
  const goalSupported = supportsSessionGoal(runtimeEndpointDirectory.endpoints, currentConversationEndpoint, currentAgentId ?? '');
  const chatGoals = useChatGoals(currentWorkspaceIdentity, currentSessionRecordKey, currentSession.meta.endpointSessionId, currentComposerDraftKey, goalSupported && chatSideEffectsActive, currentSession.meta.goal);
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
  const sessionQuestions = useSessionQuestions(
    currentWorkspaceIdentity,
    currentSession.meta.endpointSessionId,
    workspaceActive,
    currentChatRuntimeAvailable,
    String(sessionRuntimeCatalog.directoryRevision),
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
        if (isSessionTraceEnabled()) logSessionTrace('session.observe.failed', 'session-observation-boundary', () => (summarizeError(error)));
      });
    }
    return () => {
      for (const { identity, leaseId } of observations) {
        void useChatStore.getState().releaseSession(identity, leaseId).catch((error) => {
          console.warn('[session.release]', summarizeError(error));
          if (isSessionTraceEnabled()) logSessionTrace('session.release.failed', 'session-observation-boundary', () => (summarizeError(error)));
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
        if (isSessionTraceEnabled()) logSessionTrace('session.release.failed', 'session-observation-boundary', () => (summarizeError(error)));
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
        if (isSessionTraceEnabled()) logSessionTrace('session.observe.failed', 'session-observation-boundary', () => (summarizeError(error)));
      });
    }
  }, [chatSideEffectsActive, observedIdentitiesKey]);
  useEffect(() => () => {
    for (const { identity, leaseId } of openClawObservationsRef.current.values()) {
      void useChatStore.getState().releaseSession(identity, leaseId).catch((error) => {
        console.warn('[session.release]', summarizeError(error));
        if (isSessionTraceEnabled()) logSessionTrace('session.release.failed', 'session-observation-boundary', () => (summarizeError(error)));
      });
    }
    openClawObservationsRef.current.clear();
  }, []);
  useEffect(() => {
    traceLog(() => [JSON.stringify({
      prefix: STARTUP_TRACE_PREFIX,
      traceScope: 'renderer-boundary',
      ...chatStartupTraceSummary('chat-page', chatRuntimeBranch),
    })]);
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
    if (!chatSideEffectsActive || !designRuntimeAvailable || !designTeamKnown || !designTeamId || !designRunId) return;
    return observeTeamDesign({ teamId: designTeamId, runId: designRunId });
  }, [chatSideEffectsActive, designRuntimeAvailable, designTeamKnown, designTeamId, designRunId, observeTeamDesign]);
  const openedDesignNavigationRef = useRef<string | null>(null);
  useEffect(() => {
    const surface = (location.state as { teamDesignSurface?: Extract<ChatRuntimeSurfaceDescriptor, { kind: 'team-graph' }> } | null)?.teamDesignSurface;
    if (!surface || openedDesignNavigationRef.current === location.key || !chatSideEffectsActive || !currentWorkspaceIdentity
      || surface.teamId !== teamGraphTeamId || surface.runId !== teamGraphRunId
      || buildSessionIdentityKey(surface.sourceSessionIdentity) !== buildSessionIdentityKey(currentWorkspaceIdentity)) return;
    openedDesignNavigationRef.current = location.key;
    openChatRuntimeSurface(surface);
  }, [location.key, location.state, chatSideEffectsActive, currentWorkspaceIdentity, teamGraphTeamId, teamGraphRunId]);
  const designActionDisabled = !designTeamKnown || !designSnapshot || designSnapshot.startGate.status === 'started'
    || Boolean(designRecord?.loading) || designActionPending || !designRuntimeAvailable || !chatSideEffectsActive
    || isRunActive(currentSession.runtime) || isImageGenerationActive(currentSession.runtime)
    || approvalStatus === 'awaiting_approval' || !currentSendGate.canSend;
  const runDesignAction = async (action: (target: TeamDesignTarget) => Promise<void>, focusComposer = false): Promise<void> => {
    if (!designTeamId || !designRunId || designActionDisabled) return;
    const contextKey = designContextKey;
    const pending: typeof pendingDesignAction = action === startRun ? { contextKey, action: 'start' }
      : action === exitDesign ? { contextKey, action: 'exit' } : null;
    if (pending) setPendingDesignAction(pending);
    try {
      await action({ teamId: designTeamId, runId: designRunId });
      if (currentDesignContextRef.current !== contextKey) return;
      if (action === startRun && currentWorkspaceIdentity) {
        openChatRuntimeSurface({ kind: 'team-graph', sourceSessionIdentity: currentWorkspaceIdentity, teamId: designTeamId, runId: designRunId });
      }
      if (focusComposer) composerRef.current?.focus();
    } catch (error) {
      if (currentDesignContextRef.current === contextKey) toast.error(t('teams:design.actionFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (pending) setPendingDesignAction((current) => current === pending ? null : current);
    }
  };
  const chatWindowDock = useChatWindowDockController({
    enabled: workspaceActive && currentChatRuntimeAvailable,
    panelOpen: sidePanelIntentOpen,
    preferredWidth: sidePanelPreferredWidth,
    renderWidth: sidePanelRenderWidth,
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
    scope: useChatStore(selectRuntimeAgentScope),
  });

  useEffect(() => {
    resetSkillConfigSession();
    skillPreviewRequestSeqRef.current += 1;
    setSkillPreview(null);
  }, [currentAgentId, resetSkillConfigSession]);

  useEffect(() => {
    if (!currentChatRuntimeAvailable || !usesHostModelCandidates) {
      return;
    }
    void loadAvailableModels();
  }, [currentChatRuntimeAvailable, loadAvailableModels, usesHostModelCandidates]);

  useEffect(() => {
    setDraftConfigurationCapability(null);
    if (!currentChatRuntimeAvailable || !currentDraftScope) return;
    let cancelled = false;
    void hostCapabilityDescribe({ id: 'session.prompt', scope: currentDraftScope })
      .then(({ capability }) => {
        if (cancelled) return;
        const available = capability.availability === 'available'
          && capability.operations.some((operation) => operation.id === 'sessions.create');
        setDraftConfigurationCapability({
          owner: draftConfigurationOwner,
          permission: available && capability.sessionConfiguration?.permission === true,
          modelSelection: available && capability.sessionConfiguration?.modelSelection === true,
        });
      })
      .catch(() => {
        if (!cancelled) setDraftConfigurationCapability({ owner: draftConfigurationOwner, permission: false, modelSelection: false });
      });
    return () => { cancelled = true; };
  }, [currentChatRuntimeAvailable, currentDraftScope, draftConfigurationOwner]);

  const modelSelectionIdentityKey = currentSessionConversation && currentWorkspaceIdentity
    ? buildSessionIdentityKey(currentWorkspaceIdentity) : '';
  const modelSelectionSupported = Boolean(usesHostModelCandidates && currentChatRuntimeAvailable && modelSelectionIdentityKey
    && currentWorkspaceIdentity && runtimeEndpointDirectory.endpoints.some((entry) => {
      if (!runtimeEndpointsEqual(entry.endpointRef, currentWorkspaceIdentity.endpoint) || !entry.capabilities.modelSelection) return false;
      const agent = entry.agents.find((agent) => agent.agentId === currentWorkspaceIdentity.agentId);
      return agent ? agent.capabilities.modelSelection : entry.acceptsDynamicAgents;
    }));
  const modelSelectionOwner = useMemo(() => ({ conversation: currentSessionConversation, identityKey: modelSelectionIdentityKey, supported: modelSelectionSupported }), [currentSessionConversation, modelSelectionIdentityKey, modelSelectionSupported]);
  const [modelSelectionCapabilityOwner, setModelSelectionCapabilityOwner] = useState<typeof modelSelectionOwner | null>(null);
  const modelSelectionAvailable = modelSelectionSupported && modelSelectionCapabilityOwner === modelSelectionOwner;
  const modelSelectionOperationRef = useRef<{ owner: typeof modelSelectionOwner } | null>(null);
  const [modelSelectionOperation, setModelSelectionOperation] = useState<{ owner: typeof modelSelectionOwner } | null>(null);
  const modelSwitching = modelSelectionOperation?.owner === modelSelectionOwner;
  const currentModelSelectionOwnerRef = useRef<typeof modelSelectionOwner | null>(null);
  useLayoutEffect(() => {
    currentModelSelectionOwnerRef.current = modelSelectionOwner;
    return () => { currentModelSelectionOwnerRef.current = null; };
  }, [modelSelectionOwner]);
  useEffect(() => {
    setModelSelectionCapabilityOwner(null);
    if (!modelSelectionSupported || !currentWorkspaceIdentity) return;
    let cancelled = false;
    void hostCapabilityDescribe({ id: 'session.modelSelection', scope: sessionScope(currentWorkspaceIdentity) })
      .then(({ capability }) => {
        if (!cancelled && capability.availability === 'available'
          && capability.operations.some((operation) => operation.id === 'sessions.patchModel')) {
          setModelSelectionCapabilityOwner(modelSelectionOwner);
        }
      })
      .catch(() => { if (!cancelled) setModelSelectionCapabilityOwner(null); });
    return () => { cancelled = true; };
  }, [currentWorkspaceIdentity, modelSelectionOwner, modelSelectionSupported, runtimeEndpointDirectory.endpoints]);

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
    () => managementScope && currentConversationEndpoint && runtimeEndpointsEqual(managementScope.endpoint, currentConversationEndpoint)
      ? agents.map((agent) => ({
          id: agent.id,
          agentName: agent.name,
          avatarSeed: agent.avatarSeed,
          avatarStyle: agent.avatarStyle,
        })) : [],
    [agents, currentConversationEndpoint, managementScope],
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
    logSessionTrace('session.presentation.committed', 'session-presentation-boundary', () => ({
      identity: summarizeSessionIdentity(connectorSessionIdentity), recordKey: summarizeIdentifier(currentSessionRecordKey),
      runtimePhase: currentSession.runtime.runPhase, activeRunHash: summarizeIdentifier(currentSession.runtime.activeRunId).hash,
      pendingTurnHash: summarizeIdentifier(currentSession.runtime.pendingTurnKey).hash,
      viewport: summarizeRenderItems(viewportItems), presentation: summarizeRenderItems(renderItems),
      placeholderHashes: renderItems.slice(0, 200).filter((item) => !viewportItems.some((original) => original.key === item.key))
        .map((item) => summarizeIdentifier(item.key).hash),
      placeholderCount: renderItems.length - viewportItems.length,
    }));
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
    if (currentConversationEndpoint?.kind === 'native-runtime') {
      return currentAgent?.workspace?.trim() || null;
    }
    return resolveArtifactWorkspaceRoot({
      currentWorkspace: currentAgent?.workspace,
      artifactFiles,
      artifactFocusedFile,
    });
  }, [artifactFiles, artifactFocusedFile, currentAgent?.workspace, currentConversationEndpoint]);
  const artifactWorkspaceRoot = defaultArtifactWorkspaceRoot;
  const artifactWorkspaceContext = useMemo(() => ({
    workspaceRoot: artifactWorkspaceRoot || undefined,
    agentScope: currentConfigurationScope ?? undefined,
  }), [artifactWorkspaceRoot, currentConfigurationScope]);
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
    return isOpenClawModelSession
      ? resolveModelCatalogEntry(availableModels, currentSessionModelReference)
      : availableModels.find((model) => model.id === currentSession.meta.modelState?.selectionId);
  }, [availableModels, currentSession.meta.modelState?.selectionId, currentSessionModelReference, isOpenClawModelSession]);
  const currentSessionModelId = isMatchaModelSession
    ? currentSession.meta.modelState?.selectionId ?? ''
    : currentSessionModelEntry?.id ?? currentSessionModelReference;
  const contextUsage = useMemo(() => buildChatContextUsageViewModel({
    snapshot: currentSession.contextTokens,
    currentModelId: currentSessionModelId,
    availableModels: isOpenClawModelSession ? availableModels : EMPTY_AGENTS,
  }), [availableModels, currentSession.contextTokens, currentSessionModelId, isOpenClawModelSession]);
  const [workspaceRecoveryPending, setWorkspaceRecoveryPending] = useState(false);
  const handleChooseWorkspaceForCurrentAgent = useCallback(async () => {
    if (!canChooseWorkspaceForCurrentAgent || !currentAgent || workspaceRecoveryPending) {
      return;
    }
    const conversation = useChatStore.getState().currentConversation;
    const isCurrent = () => useChatStore.getState().currentConversation === conversation;
    setWorkspaceRecoveryPending(true);
    try {
      const selectedPath = await pickLocalDirectory({
        title: t('workspaceUnavailable.pickTitle'),
        defaultPath: currentWorkspacePath || undefined,
        buttonLabel: t('workspaceUnavailable.pickButton'),
      });
      if (!selectedPath || !isCurrent()) {
        return;
      }
      await updateAgent({
        agentId: currentAgentId,
        name: currentAgent.name ?? currentAgentId,
        workspace: selectedPath,
        model: currentAgent.model,
      });
      if (!isCurrent()) return;
      await newSession(currentAgentId);
      const selected = useChatStore.getState().currentConversation;
      if (conversation && selected?.agentId === conversation.agentId && runtimeEndpointsEqual(selected.endpoint, conversation.endpoint)) {
        toast.success(t('workspaceUnavailable.updateSuccess'));
      }
    } catch (error) {
      if (isCurrent()) toast.error(t('workspaceUnavailable.updateFailed', { error: error instanceof Error ? error.message : String(error) }));
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
  const workspaceRecoveryAction = canChooseWorkspaceForCurrentAgent ? (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto justify-start whitespace-normal p-0 text-left text-xs"
      disabled={workspaceRecoveryPending}
      onClick={() => {
        void handleChooseWorkspaceForCurrentAgent();
      }}
    >
      {workspaceRecoveryPending
        ? t('workspaceUnavailable.updating')
        : t('workspaceUnavailable.chooseWorkspaceAndNewSession')}
    </Button>
  ) : null;
  const activeRun = isRunActive(currentSession.runtime)
    || currentSession.runtime.activeRunId != null;
  const permissionPicker = useChatPermissions({
    scope: currentConfigurationScope,
    identity: currentSessionConversation?.sessionIdentity ?? null,
    ready: currentChatRuntimeAvailable,
    activeRun,
    draft: currentConversation?.kind === 'draft',
    draftAvailable: draftConfigurationReady && draftConfigurationCapability?.permission === true,
    draftLoading: Boolean(currentDraftScope) && currentChatRuntimeAvailable && !draftConfigurationReady,
    initializationBusy: composerInitializationBusy,
    pendingSelection: composerConfiguration?.permissionSelection,
    pendingConfiguration: composerInitialization?.kind === 'pending',
    onSelectIntent: (selection) => setPermissionSelection(currentComposerDraftKey, selection),
  });
  const modelPicker = useMemo(() => {
    const intendedModelId = composerConfiguration?.modelSelectionId;
    const currentModelId = intendedModelId ?? currentSessionModelId;
    if (!currentModelId && availableModels.length === 0 && !modelsLoading
      && !(isMatchaModelSession && (currentSession.meta.modelState?.selected || currentSession.meta.modelState?.active))) {
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
    const selectedLabel = currentModelId
      ? triggerLabels.get(currentModelId) ?? resolveModelTriggerLabel(currentModelId)
      : currentSession.meta.modelState?.selected?.model ?? t('input.pickModel');
    return {
      currentModelId,
      currentLabel: selectedLabel,
      options,
      loading: modelsLoading,
      switching: modelSwitching,
      disabled: activeRun || modelSwitching || !currentChatRuntimeAvailable || composerInitializationBusy || (currentDraftScope
        ? !draftConfigurationReady || draftConfigurationCapability?.modelSelection !== true : !modelSelectionAvailable),
    };
  }, [activeRun, availableModels, composerConfiguration?.modelSelectionId, composerInitializationBusy, currentChatRuntimeAvailable, currentDraftScope, currentSession.meta.modelState, currentSessionModelId, draftConfigurationCapability, draftConfigurationReady, isMatchaModelSession, modelSelectionAvailable, modelSwitching, modelsLoading, t]);
  const composerContextTraceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    const modelState = currentSession.meta.modelState;
    const context = {
      identity: summarizeSessionIdentity(connectorSessionIdentity), recordKey: summarizeIdentifier(currentSessionRecordKey),
      endpointSessionId: summarizeIdentifier(connectorEndpointSessionId),
      conversationKind: currentConversation?.kind ?? null, runtimeState: currentConversationRuntime.state,
      directoryStatus: runtimeEndpointDirectory.status, gatewayRunning: isGatewayRunning,
      composerDisabled: !currentChatRuntimeAvailable,
      historyStatus: currentSession.meta.historyStatus, runPhase: currentSession.runtime.runPhase,
      activeRun: summarizeIdentifier(currentSession.runtime.activeRunId), modelBlockedByRun: activeRun,
      modelState: {
        present: !!modelState, selectionId: summarizeIdentifier(modelState?.selectionId),
        selectedRef: summarizeIdentifier(modelState?.selected?.ref), activeRef: summarizeIdentifier(modelState?.active?.ref),
        overrideSource: modelState?.overrideSource ?? null,
      },
      displayedModel: summarizeIdentifier(currentSessionModelId), catalogMatch: !!currentSessionModelEntry,
      availableModelCount: availableModels.length, modelsLoading,
    };
    const signature = JSON.stringify(context);
    if (composerContextTraceRef.current === signature) return;
    composerContextTraceRef.current = signature;
    logSessionTrace('session.composer.context', 'session-composer-boundary', () => context);
  });
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
    logSessionTrace('model-selection.enter', traceId, () => ({
      currentSessionKey: summarizeIdentifier(currentSessionRecordKey),
      requestedModelSelectionId: summarizeIdentifier(normalizedModelSelectionId),
      currentModelSelectionId: summarizeIdentifier(currentModelSelectionId),
      activeRun: Boolean(activeRun),
    }));
    if (!normalizedModelSelectionId || !modelPicker || modelPicker.disabled || modelPicker.loading
      || !availableModels.some((model) => model.id === normalizedModelSelectionId)) return;
    if (currentConversation?.kind === 'draft' || composerInitialization?.kind === 'pending') {
      setModelSelection(currentComposerDraftKey, normalizedModelSelectionId);
      return;
    }
    if (!currentSessionRecordKey || !currentSessionConversation || normalizedModelSelectionId === currentModelSelectionId) return;
    const conversation = currentSessionConversation;
    if (currentModelSelectionOwnerRef.current !== modelSelectionOwner
      || modelSelectionOperationRef.current?.owner === modelSelectionOwner
      || useChatStore.getState().currentConversation !== conversation) return;
    const operation = { owner: modelSelectionOwner };
    modelSelectionOperationRef.current = operation;
    setModelSelectionOperation(operation);
    const isCurrent = () => currentModelSelectionOwnerRef.current === modelSelectionOwner
      && modelSelectionOperationRef.current === operation
      && useChatStore.getState().currentConversation === conversation;
    try {
      const result = await useChatStore.getState().selectSessionModel(currentSessionRecordKey, normalizedModelSelectionId);
      logSessionTrace('model-selection.result', traceId, () => ({ outcome: result.outcome }));
      if (result.outcome !== 'succeeded') throw new Error(result.outcome);
      if (isCurrent()) void loadSessions();
    } catch (error) {
      logSessionTrace('model-selection.error', traceId, () => summarizeError(error));
      if (isCurrent()) toast.error(t('input.modelSwitchFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (modelSelectionOperationRef.current === operation) modelSelectionOperationRef.current = null;
      setModelSelectionOperation((current) => current === operation ? null : current);
    }
  }, [activeRun, availableModels, composerInitialization?.kind, currentComposerDraftKey, currentConversation?.kind, currentSessionConversation, currentSessionModelId, currentSessionRecordKey, loadSessions, modelPicker, modelSelectionOwner, setModelSelection, t]);

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
      goalDock={goalSupported && chatGoals.dock ? <ChatGoalDock
        key={currentComposerDraftKey}
        goal={chatGoals.dock.goal}
        busy={chatGoals.busy}
        runActive={activeRun}
        disabled={!chatSideEffectsActive || chatGoals.unknown || Boolean(chatGoals.mode)}
        error={chatGoals.error}
        onEdit={() => { const goal = currentSession.meta.goal; if (goal.kind === 'known' && goal.goal) beginTypedGoal(goal.goal.id, goal.goal.objective); }}
        onAction={(update) => { const goal = currentSession.meta.goal; if (goal.kind === 'known' && goal.goal) void chatGoals.act(goal.goal.id, update); }}
        onRefresh={() => { void chatGoals.refresh(); }}
      /> : null}
      onStop={abortRun}
      skillsScope={currentSkillsScope}
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
      permissionPicker={permissionPicker}
      configurationStatus={composerConfigurationStatus}
      contextUsage={contextUsage}
      onOpenTeamGraph={teamGraphTeamId && teamGraphRunId && currentWorkspaceIdentity ? () => {
        openChatRuntimeSurface({ kind: 'team-graph', sourceSessionIdentity: currentWorkspaceIdentity, teamId: teamGraphTeamId, runId: teamGraphRunId });
      } : undefined}
      teamDesign={designTeamId && designRunId && currentWorkspaceIdentity ? {
        status: designSnapshot?.startGate.status ?? null,
        disabled: designActionDisabled,
        starting: designActionPending && pendingDesignAction?.contextKey === designContextKey && pendingDesignAction.action === 'start',
        exiting: designActionPending && pendingDesignAction?.contextKey === designContextKey && pendingDesignAction.action === 'exit',
        error: designRecord?.error ?? null,
        onStart: () => {
          openChatRuntimeSurface({ kind: 'team-graph', sourceSessionIdentity: currentWorkspaceIdentity, teamId: designTeamId, runId: designRunId });
          void runDesignAction(startDesign, true);
        },
        onExit: () => { void runDesignAction(exitDesign, true); },
        onRun: () => { void runDesignAction(startRun); },
      } : null}
      disabled={!currentChatRuntimeAvailable}
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

  if (sessionRuntimeInitializing) {
    return (
      <ChatOffline
        title={t('runtimePreparing.title')}
        description={t('runtimePreparing.description')}
        tone="loading"
      />
    );
  }

  if (currentConversationRuntime.state === 'unselected' && currentSession.items.length === 0
    && (runtimeEndpointDirectory.status === 'error' || sessionRuntimeCatalog.status === 'error')) {
    return (
      <ChatOffline
        title={t('runtimePreparationFailed.title')}
        description={runtimeEndpointDirectory.error || sessionRuntimeCatalog.error || t('runtimePreparationFailed.description')}
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
        isEmptyState={liveView.isEmptyState && chatQuestions.questions.length === 0 && !chatQuestions.error && sessionQuestions.questions.length === 0 && !sessionQuestions.error}
        emptyState={<WelcomeScreen input={inputNode} />}
        sidePanel={(
          <ChatSidePanel
            key={currentComposerDraftKey}
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
            workspaceRecoveryAction={workspaceRecoveryAction}
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
        errorBanner={visibleRuntimeError ? (
          <ChatErrorBanner
            error={visibleRuntimeError}
            dismissLabel={t('common:actions.dismiss')}
            onDismiss={clearError}
          />
        ) : runtimeStatusDock}
        approvalDock={approvalStatus === 'awaiting_approval' || chatQuestions.questions.length > 0 || chatQuestions.error || sessionQuestions.questions.length > 0 || sessionQuestions.error ? (
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
            <SessionQuestionDock
              key={sessionQuestions.scopeKey}
              questions={sessionQuestions.questions}
              confirmed={sessionQuestions.confirmed}
              error={sessionQuestions.error}
              submittingId={sessionQuestions.submittingId}
              onRefresh={sessionQuestions.refresh}
              onRespond={sessionQuestions.respond}
            />
          </>
        ) : null}
        input={inputNode}
      />
    </AssistantPendingLabelProvider>
  );
}

export default Chat;
