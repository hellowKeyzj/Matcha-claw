/**
 * Chat Page
 * Native React implementation using runtime-host session APIs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type ApprovalItem, type ChatSessionRuntimeState, type ChatStoreState } from '@/stores/chat';
import { selectCurrentChatSendGate } from '@/stores/chat/selectors';
import { useTeamsStore } from '@/stores/teams';
import { ABORT_STOPPING_TIMEOUT_ERROR } from '@/stores/chat/abort-handlers';
import { isRunActive } from '@/stores/chat/types';
import { buildCurrentConversationFromSessionRecord, resolveCurrentConversationRuntimeState } from '@/stores/chat/session-runtime-graph';
import { useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useCapabilityRoutingStore } from '@/stores/capability-routing';
import { useSettingsStore } from '@/stores/settings';
import type { GatewayTransportIssue } from '../../types/session/runtime-state';
import type {
  SessionIdentity,
} from '../../../electron/desktop-contract/runtime-address';
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
import { ChatInput } from './ChatInput';
import { ChatList, type ChatListHandle } from './components/ChatList';
import { ChatHeaderBar } from './components/ChatHeaderBar';
import { ChatApprovalDock, ChatErrorBanner } from './components/ChatRuntimeDock';
import { SessionTodoPanel } from './components/SessionTodoPanel';
import { WelcomeScreen } from './components/ChatStates';
import { useChatInit } from './useChatInit';
import { useChatSidePanelController } from './useChatSidePanelController';
import { useChatWindowDockController } from './useChatWindowDockController';
import { useAgentSkillConfig } from './useAgentSkillConfig';
import { useChatView } from './useChatView';
import {
  applyAssistantPresentationToItems,
  type ChatAssistantCatalogAgent,
  type ChatRenderItem,
} from './chat-render-item-model';
import {
  hostApiFetch,
  hostOpenClawGetToolPermissionMode,
  hostOpenClawSetToolPermissionMode,
  hostSessionPatch,
  hostSessionWindowFetch,
  type OpenClawToolPermissionMode,
} from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { toast } from 'sonner';
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeError,
  summarizeIdentifier,
  summarizeSessionIdentity,
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
  resolveArtifactGroupFocusFile,
  resolveArtifactGroupKeyForFile,
  resolvePreviewableArtifactGroupTarget,
  resolveArtifactWorkbenchSelection,
} from './artifact-workbench';
import { supportsInlineDiff, type GeneratedFile } from '@/lib/generated-files';
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
    foregroundHistorySessionKey: state.foregroundHistorySessionKey,
    sessionsLoading: state.sessionCatalogStatus.status === 'loading',
    showThinking: state.showThinking,
    refresh: state.refresh,
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
    cleanupEmptySession: state.cleanupEmptySession,
    sessionRuntimeGraph: state.sessionRuntimeGraph,
    sessionRuntimeCatalog: state.sessionRuntimeCatalog,
  };
}

function resolveEffectiveChatModelId(
  sessionModel: string | null | undefined,
  agentDefaultModel: string | null | undefined,
  fallbackModel: string | null | undefined,
  availableModelIds: ReadonlySet<string>,
): string {
  const normalizedFallbackModel = typeof fallbackModel === 'string' ? fallbackModel.trim() : '';
  const hasCatalog = availableModelIds.size > 0;
  const normalizeAvailableModel = (model: string | null | undefined): string => {
    const normalized = typeof model === 'string' ? model.trim() : '';
    if (!normalized) return '';
    return !hasCatalog || availableModelIds.has(normalized) ? normalized : '';
  };

  return normalizeAvailableModel(sessionModel)
    || normalizeAvailableModel(agentDefaultModel)
    || normalizedFallbackModel;
}

function buildRuntimeAssistantPlaceholder(input: {
  sessionKey: string;
  runtime: ChatSessionRuntimeState;
  items: ReadonlyArray<SessionRenderItem>;
}): SessionRenderItem | null {
  const activeRunId = input.runtime.activeRunId;
  if (!activeRunId || !isRunActive(input.runtime)) {
    return null;
  }
  if (input.items.some((item) => item.kind === 'assistant-turn' && item.runId === activeRunId)) {
    return null;
  }

  const isWaitingForTool = input.runtime.runPhase === 'waiting_tool';
  return {
    key: `runtime-pending:${input.sessionKey}:${activeRunId}`,
    kind: 'assistant-turn',
    role: 'assistant',
    sessionKey: input.sessionKey,
    runId: activeRunId,
    identitySource: 'run',
    identityMode: 'run',
    identityConfidence: 'strong',
    status: isWaitingForTool ? 'waiting_tool' : 'streaming',
    segments: [],
    thinking: null,
    tools: [],
    text: '',
    images: [],
    attachedFiles: [],
    pendingState: isWaitingForTool ? 'activity' : 'typing',
    ...(input.runtime.lastUserMessageAt != null ? { createdAt: input.runtime.lastUserMessageAt } : {}),
    ...(input.runtime.updatedAt != null ? { updatedAt: input.runtime.updatedAt } : {}),
  };
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
    foregroundHistorySessionKey,
    sessionsLoading,
    showThinking,
    refresh,
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
    cleanupEmptySession,
    sessionRuntimeGraph,
    sessionRuntimeCatalog,
  } = useChatStore(useShallow(selectChatPageState));
  const currentSessionConversation = currentConversation?.kind === 'session' ? currentConversation : null;
  const currentSessionRecordKey = selectedSessionRecordKey;
  const currentAgentId = currentConversation?.agentId ?? currentSession.meta.agentId ?? '';
  const submitTeamRoleMessageFromChat = useTeamsStore((state) => state.submitTeamRoleMessageFromChat);
  const resolveTeamRoleChatTargetBySession = useTeamsStore((state) => state.resolveTeamRoleChatTargetBySession);
  const isTeamRoleSession = useTeamsStore((state) => state.isTeamRoleSession);
  const currentTeamRoleSessionProbe = {
    sessionIdentity: currentSessionConversation?.sessionIdentity ?? currentSession.meta.sessionIdentity,
    sessionKey: currentSessionRecordKey,
    endpointSessionId: currentSessionConversation?.endpointSessionId ?? currentSession.meta.endpointSessionId,
  };
  const currentTeamChatTarget = resolveTeamRoleChatTargetBySession(currentTeamRoleSessionProbe);
  const isCurrentTeamRoleSession = isTeamRoleSession(currentTeamRoleSessionProbe);
  const agents = useSubagentsStore((state) => (
    Array.isArray(state.agentsResource.data) ? state.agentsResource.data : EMPTY_AGENTS
  ));
  const availableModels = useSubagentsStore((state) => state.availableModels);
  const modelsLoading = useSubagentsStore((state) => state.modelsLoading);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const chatModelRoute = useCapabilityRoutingStore((state) => state.routing.chat);
  const routingReady = useCapabilityRoutingStore((state) => state.ready);
  const routingLoading = useCapabilityRoutingStore((state) => state.loading);
  const refreshCapabilityRouting = useCapabilityRoutingStore((state) => state.refresh);
  const currentAgent = currentAgentId ? agents.find((agent) => agent.id === currentAgentId) : undefined;
  const userAvatarDataUrl = useSettingsStore((state) => state.userAvatarDataUrl);
  const [skillPreview, setSkillPreview] = useState<ChatSkillPreviewState | null>(null);
  const [artifactActiveSection, setArtifactActiveSection] = useState<ChatArtifactSection>('changes');
  const [artifactFocusedGroupKey, setArtifactFocusedGroupKey] = useState<string | null>(null);
  const [artifactFocusedFilePath, setArtifactFocusedFilePath] = useState<string | null>(null);
  const [artifactFocusedFileOverride, setArtifactFocusedFileOverride] = useState<ArtifactPreviewTarget | null>(null);
  const [artifactViewMode, setArtifactViewMode] = useState<'preview' | 'diff'>('diff');
  const [visibleRuntimeError, setVisibleRuntimeError] = useState<string | null>(null);
  const [exportingMarkdown, setExportingMarkdown] = useState(false);
  const [toolPermissionMode, setToolPermissionMode] = useState<OpenClawToolPermissionMode>('fullAccess');
  const [toolPermissionModeLoading, setToolPermissionModeLoading] = useState(true);
  const [toolPermissionModeSwitching, setToolPermissionModeSwitching] = useState(false);
  const skillPreviewRequestSeqRef = useRef(0);
  const previousRenderedItemsRef = useRef<ChatRenderItem[] | null>(null);
  const artifactAutoOpenedSessionKeyRef = useRef<string | null>(null);
  const chatLayoutRef = useRef<HTMLDivElement>(null);
  const viewportPaneRef = useRef<ChatListHandle>(null);
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
  const chatRuntimeBranch: ChatRuntimeBranch = currentConversationRuntime.state === 'ready'
    ? 'ready'
    : (currentConversationRuntime.state === 'unavailable' ? 'unavailable' : 'starting');
  const chatSideEffectsActive = workspaceActive && currentChatRuntimeAvailable;
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



  const {
    sidePanelOpen: sidePanelIntentOpen,
    sidePanelWidth: sidePanelRenderWidth,
    sidePanelPreferredWidth,
    sidePanelWidthPolicy,
    activeSidePanelTab,
    artifactWorkbenchFullscreen,
    unfinishedTaskCount,
    taskInboxTasks,
    taskInboxLoading,
    taskInboxError,
    refreshTaskInbox,
    clearTaskInboxError,
    derivedPlanStatus,
    openSidePanel: openSidePanelDomain,
    setActiveSidePanelTab,
    closeSidePanel: closeSidePanelDomain,
    setSidePanelWidth,
    toggleArtifactWorkbenchFullscreen,
  } = useChatSidePanelController(chatSideEffectsActive, chatLayoutRef);
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

  useEffect(() => {
    if (!isGatewayRunning) {
      setToolPermissionModeLoading(false);
      return;
    }
    let cancelled = false;
    setToolPermissionModeLoading(true);
    void hostOpenClawGetToolPermissionMode()
      .then((result) => {
        if (!cancelled) {
          setToolPermissionMode(result.mode);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(t('input.permissionLoadFailed', { error: error instanceof Error ? error.message : String(error) }));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setToolPermissionModeLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isGatewayRunning, t]);

  useEffect(() => {
    if (!chatSideEffectsActive) {
      return;
    }
    prepareSkillConfig();
  }, [prepareSkillConfig, chatSideEffectsActive]);
  const refreshing = Boolean(currentSessionRecordKey) && foregroundHistorySessionKey === currentSessionRecordKey;
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
  const renderItems = useMemo(() => {
    const runtimePlaceholder = buildRuntimeAssistantPlaceholder({
      sessionKey: currentSessionRecordKey,
      runtime: currentSession.runtime,
      items: viewportItems,
    });
    const protocolItems = runtimePlaceholder ? [...viewportItems, runtimePlaceholder] : viewportItems;
    const nextItems = applyAssistantPresentationToItems({
      items: protocolItems,
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
  }, [assistantCatalogAgents, currentAgent?.avatarSeed, currentAgent?.avatarStyle, currentAgent?.name, currentAgentId, currentSession.runtime, currentSessionRecordKey, viewportItems]);
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
    if (artifactGroups.length === 0) {
      if (artifactAutoOpenedSessionKeyRef.current === currentSessionRecordKey) {
        artifactAutoOpenedSessionKeyRef.current = null;
      }
      if (artifactFocusedGroupKey !== null) {
        setArtifactFocusedGroupKey(null);
      }
      return;
    }
    if (!currentSessionRecordKey || artifactAutoOpenedSessionKeyRef.current === currentSessionRecordKey) {
      return;
    }
    const firstArtifactFile = resolveArtifactGroupFocusFile(artifactGroups[0] ?? null, null);
    if (!firstArtifactFile) {
      return;
    }
    artifactAutoOpenedSessionKeyRef.current = currentSessionRecordKey;
    openGeneratedArtifact(firstArtifactFile);
  }, [artifactFiles, artifactFocusedGroupKey, artifactGroups, currentSessionRecordKey, openGeneratedArtifact]);
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
  useEffect(() => {
    if (!chatSideEffectsActive || routingReady || routingLoading) {
      return;
    }
    void refreshCapabilityRouting();
  }, [refreshCapabilityRouting, routingLoading, routingReady, chatSideEffectsActive]);

  const fallbackModelId = useMemo(() => {
    if (!routingReady) {
      return '';
    }
    const primary = chatModelRoute?.primary;
    if (primary) {
      const routed = availableModels.find((model) => (
        model.accountId === primary.accountId
        && model.modelLabel === primary.modelId
      ));
      if (routed) return routed.id;
    }
    return availableModels[0]?.id ?? '';
  }, [availableModels, chatModelRoute?.primary, routingReady]);
  const availableModelIds = useMemo(() => new Set(availableModels.map((model) => model.id)), [availableModels]);
  const effectiveCurrentModelId = useMemo(() => {
    return resolveEffectiveChatModelId(currentSession.meta.model, currentAgent?.model, fallbackModelId, availableModelIds);
  }, [availableModelIds, currentAgent?.model, currentSession.meta.model, fallbackModelId]);
  const contextUsage = useMemo(() => buildChatContextUsageViewModel({
    snapshot: currentSession.contextTokens,
    currentModelId: effectiveCurrentModelId,
    availableModels,
  }), [availableModels, currentSession.contextTokens, effectiveCurrentModelId]);
  const activeRun = isRunActive(currentSession.runtime)
    || currentSession.runtime.activeRunId != null;
  const modelPicker = useMemo(() => {
    const currentModelId = effectiveCurrentModelId;
    if (!currentModelId) {
      return null;
    }
    const labels = new Map<string, string>();
    for (const model of availableModels) {
      labels.set(model.id, model.displayLabel);
    }
    const options = availableModels.map((model) => ({
      id: model.id,
      label: model.displayLabel,
    }));
    if (!labels.has(currentModelId)) {
      options.unshift({
        id: currentModelId,
        label: currentModelId,
      });
    }
    return {
      currentModelId,
      currentLabel: labels.get(currentModelId) ?? currentModelId,
      options,
      loading: modelsLoading,
      switching: false,
      disabled: activeRun || !currentSessionRecordKey,
    };
  }, [activeRun, availableModels, currentSessionRecordKey, effectiveCurrentModelId, modelsLoading]);
  const handleSendMessage = useCallback(async (
    text: string,
    attachments?: Parameters<typeof sendMessage>[1],
  ) => {
    viewportPaneRef.current?.prepareCurrentLatestBottomAlign();
    if (isCurrentTeamRoleSession) {
      if (!currentTeamChatTarget) {
        return { accepted: false, reason: 'error', error: 'Team role session is not ready yet.' } as const;
      }
      if (attachments && attachments.length > 0) {
        return { accepted: false, reason: 'error', error: 'Team role chat does not support attachments yet.' } as const;
      }
      void submitTeamRoleMessageFromChat(currentTeamChatTarget.teamId, currentTeamChatTarget.roleId, text, currentTeamChatTarget.runId)
        .catch(() => undefined);
      return { accepted: true } as const;
    }
    return sendMessage(text, attachments);
  }, [currentTeamChatTarget, isCurrentTeamRoleSession, sendMessage, submitTeamRoleMessageFromChat]);
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
  const handleComposerWheel = useCallback((deltaY: number) => {
    viewportPaneRef.current?.scrollByWheelDelta(deltaY);
  }, []);
  const handleComposerGeometryChange = useCallback(() => {
    viewportPaneRef.current?.notifyComposerGeometryChanged();
  }, []);
  const handleSelectModel = useCallback(async (modelSelectionId: string) => {
    const traceId = createSessionTraceId('model-selection');
    const normalizedModelSelectionId = modelSelectionId.trim();
    const currentModelSelectionId = effectiveCurrentModelId;
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
          model: normalizedModelSelectionId,
        }),
      }));
      void loadSessions();
    } catch (error) {
      logSessionTrace('model-selection.error', traceId, summarizeError(error));
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('input.modelSwitchFailed', { error: message }));
    }
  }, [activeRun, currentSessionConversation, currentSessionRecordKey, effectiveCurrentModelId, loadSessions, t]);

  const handleSelectToolPermissionMode = useCallback(async (nextMode: OpenClawToolPermissionMode) => {
    if (nextMode === toolPermissionMode || toolPermissionModeSwitching || activeRun) {
      return;
    }
    const previousMode = toolPermissionMode;
    setToolPermissionMode(nextMode);
    setToolPermissionModeSwitching(true);
    try {
      const result = await hostOpenClawSetToolPermissionMode(nextMode);
      setToolPermissionMode(result.mode);
    } catch (error) {
      setToolPermissionMode(previousMode);
      toast.error(t('input.permissionSwitchFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setToolPermissionModeSwitching(false);
    }
  }, [activeRun, t, toolPermissionMode, toolPermissionModeSwitching]);

  const handlePreviewSkill = useCallback(async (skill: {
    id: string;
    name: string;
    filePath?: string;
    baseDir?: string;
  }) => {
    setActiveSidePanelTab('skills');
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
  }, [setActiveSidePanelTab, t]);
  const inputNode = (
    <ChatInput
      onSend={handleSendMessage}
      onStop={abortRun}
      onPreviewSkill={handlePreviewSkill}
      modelPicker={modelPicker ? {
        ...modelPicker,
        onSelect: (modelSelectionId) => {
          void handleSelectModel(modelSelectionId);
        },
      } : null}
      permissionPicker={{
        currentMode: toolPermissionMode,
        loading: toolPermissionModeLoading,
        switching: toolPermissionModeSwitching,
        disabled: !isGatewayRunning || activeRun,
        onSelect: (mode) => {
          void handleSelectToolPermissionMode(mode);
        },
      }}
      contextUsage={contextUsage}
      disabled={!currentChatRuntimeAvailable}
      reconnecting={currentRuntimeReconnecting}
      sending={isRunActive(currentSession.runtime)}
      sendGate={currentSendGate}
      stopping={currentSession.runtime.runPhase === 'stopping'}
      approvalWaiting={approvalStatus === 'awaiting_approval'}
      allowedSkillIds={allowedSkillIdsForChat}
      sessionIdentity={currentSession.meta.sessionIdentity}
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

  if (!currentChatRuntimeAvailable && currentSession.items.length === 0) {
    return (
      <ChatOffline
        title={t('runtimeUnavailable.title')}
        description={(currentConversationRuntime.state === 'unavailable' ? currentConversationRuntime.error : sessionRuntimeCatalog.error) || t('runtimeUnavailable.description')}
      />
    );
  }

  return (
    <>
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
        isEmptyState={liveView.isEmptyState}
        emptyState={<WelcomeScreen input={inputNode} />}
        sidePanel={(
          <ChatSidePanel
            mode={sidePanelMode}
            width={sidePanelWidth}
            activeTab={activeSidePanelTab}
            artifactWorkbenchFullscreen={artifactWorkbenchFullscreen}
            onTabChange={setActiveSidePanelTab}
            onClose={chatWindowDock.closeSidePanel}
            onToggleArtifactWorkbenchFullscreen={toggleArtifactWorkbenchFullscreen}
            unfinishedTaskCount={unfinishedTaskCount}
            taskInboxTasks={taskInboxTasks}
            taskInboxLoading={taskInboxLoading}
            taskInboxError={taskInboxError}
            onRefreshTaskInbox={refreshTaskInbox}
            onClearTaskInboxError={clearTaskInboxError}
            derivedPlanStatus={derivedPlanStatus}
            skillConfigLabel={t('toolbar.skillConfig')}
            skillConfigTitle={t('skillConfigDialog.titleWithAgent', { agent: currentAgent?.name || currentAgentId })}
            skillOptions={availableSkillOptions}
            skillsLoading={skillConfigSkillsLoading}
            selectedSkillIds={selectedSkillIds}
            onToggleSkill={toggleSkillConfigSelection}
            skillPreview={skillPreview}
            onClearSkillPreview={() => setSkillPreview(null)}
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
            onRefresh={() => {
              if (!currentSessionRecordKey) return;
              void refresh();
            }}
            refreshBusy={refreshing || sessionsLoading || !currentSessionRecordKey}
            showThinking={showThinking}
            onToggleThinking={toggleThinking}
            exportDisabled={exportingMarkdown || !currentSessionRecordKey}
            onExportMarkdown={handleExportMarkdown}
            sidePanelOpen={chatWindowDock.sidePanelExpanded}
            unfinishedTaskCount={unfinishedTaskCount}
            onToggleSidePanel={chatWindowDock.toggleSidePanel}
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
              const target = buildArtifactPreviewTargetFromAttachedFile(file);
              if (!target) {
                if (file.filePath) {
                  void invokeIpc('shell:openPath', file.filePath);
                }
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
        ) : null}
        approvalDock={approvalStatus === 'awaiting_approval' ? (
          <ChatApprovalDock
            waitingLabel={t('approval.waitingLabel')}
            approvals={currentPendingApprovals}
            onResolve={(approval, decision) => {
              void resolveApproval(approval, decision);
            }}
          />
        ) : null}
        todoPanel={<SessionTodoPanel sessionKey={currentSessionRecordKey} />}
        input={inputNode}
      />
    </>
  );
}

export default Chat;
