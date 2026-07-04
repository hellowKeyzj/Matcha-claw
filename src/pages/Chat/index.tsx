/**
 * Chat Page
 * Native React implementation using runtime-host session APIs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type ApprovalItem, type ChatStoreState } from '@/stores/chat';
import { useTeamsStore } from '@/stores/teams';
import { ABORT_STOPPING_TIMEOUT_ERROR } from '@/stores/chat/abort-handlers';
import { isRunActive } from '@/stores/chat/types';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useSettingsStore } from '@/stores/settings';
import type { GatewayTransportIssue } from '../../../runtime-host/shared/gateway-error';
import { buildSessionIdentityKey, type SessionIdentity } from '../../../runtime-host/shared/runtime-address';
import type { SessionRenderItem, SessionWindowStateSnapshot } from '../../../runtime-host/shared/session-adapter-types';
import { isGatewayOperational, isGatewayPreparing as resolveGatewayPreparing } from '@/lib/gateway-status';
import {
  createEmptySessionRecord,
  getPendingApprovals,
  getSessionApprovalStatus,
  patchSessionMeta,
  patchSessionSnapshot,
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
  resolveHydratedSessionSnapshot,
  type OpenClawToolPermissionMode,
} from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { toast } from 'sonner';
import { collectChatArtifactGroups } from './artifacts';
import { buildChatSessionMarkdownExport, downloadMarkdownFile } from './session-markdown-export';
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

function parseTeamRoleSessionKey(sessionKey: string): { runId: string; roleId: string } | null {
  const parts = sessionKey.split(':');
  if (parts.length !== 5 || parts[0] !== 'agent' || parts[2] !== 'team-role') {
    return null;
  }
  const runId = parts[3]?.trim();
  const roleId = parts[4]?.trim();
  return runId && roleId ? { runId, roleId } : null;
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
  const currentSessionKey = state.currentSessionKey;
  const currentSession = state.loadedSessions[currentSessionKey] ?? EMPTY_CHAT_PAGE_SESSION;
  return {
    currentSessionKey,
    currentSession,
    dismissedRuntimeError: state.dismissedRuntimeErrorBySession[currentSessionKey],
    approvalStatus: getSessionApprovalStatus(state, currentSessionKey),
    currentPendingApprovals: getPendingApprovals(state, currentSessionKey) ?? EMPTY_APPROVAL_ITEMS,
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

async function fetchChatMarkdownExportWindow(input: {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  mode: 'latest' | 'older';
  offset?: number;
}) {
  const initial = await hostSessionWindowFetch({
    sessionKey: input.sessionKey,
    sessionIdentity: input.sessionIdentity,
    mode: input.mode,
    limit: CHAT_MARKDOWN_EXPORT_WINDOW_LIMIT,
    ...(input.mode === 'older' ? { offset: input.offset } : {}),
    includeCanonical: true,
  });
  return await resolveHydratedSessionSnapshot({
    initial,
    refetch: async () => await hostSessionWindowFetch({
      sessionKey: input.sessionKey,
      sessionIdentity: input.sessionIdentity,
      mode: input.mode,
      limit: CHAT_MARKDOWN_EXPORT_WINDOW_LIMIT,
      ...(input.mode === 'older' ? { offset: input.offset } : {}),
      includeCanonical: true,
    }),
  });
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
  sessionKey: string;
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
  const latestSnapshot = await fetchChatMarkdownExportWindow({
    sessionKey: input.sessionKey,
    sessionIdentity: input.sessionIdentity,
    mode: 'latest',
  });
  if (!latestSnapshot) {
    throw new Error('session export did not return a snapshot');
  }

  collectSessionWindowItems({
    itemsByOffset,
    window: latestSnapshot.window,
    items: latestSnapshot.items,
  });

  let nextOffset = latestSnapshot.window.windowStartOffset;
  while (nextOffset > 0) {
    const previousOffset = nextOffset;
    const snapshot = await fetchChatMarkdownExportWindow({
      sessionKey: input.sessionKey,
      sessionIdentity: input.sessionIdentity,
      mode: 'older',
      offset: nextOffset,
    });
    if (!snapshot) {
      throw new Error('session export did not return a previous snapshot');
    }
    collectSessionWindowItems({
      itemsByOffset,
      window: snapshot.window,
      items: snapshot.items,
    });
    nextOffset = snapshot.window.windowStartOffset;
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
  const gatewayInitialized = useGatewayStore((state) => state.isInitialized);
  const isGatewayRunning = isGatewayOperational(gatewayStatus);
  const isGatewayPreparing = resolveGatewayPreparing(gatewayStatus, gatewayInitialized);
  const hasGatewayBeenOperationalRef = useRef(false);
  if (isGatewayRunning) {
    hasGatewayBeenOperationalRef.current = true;
  }
  const preserveChatDuringGatewayRecovery = hasGatewayBeenOperationalRef.current
    && !isGatewayRunning
    && isGatewayPreparing;
  const localizedGatewayIssue = useMemo(() => {
    return localizeGatewayIssue(gatewayStatus.lastIssue, t)
      ?? gatewayStatus.lastError
      ?? null;
  }, [gatewayStatus.lastError, gatewayStatus.lastIssue, t]);
  const {
    currentSessionKey,
    currentSession,
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
  } = useChatStore(useShallow(selectChatPageState));
  const currentAgentId = currentSession.meta.agentId ?? currentSession.meta.sessionIdentity?.agentId ?? '';
  const teams = useTeamsStore((state) => state.teams);
  const runListByTeamId = useTeamsStore((state) => state.runListByTeamId);
  const rolesByTeamId = useTeamsStore((state) => state.rolesByTeamId);
  const submitTeamRoleMessageFromChat = useTeamsStore((state) => state.submitTeamRoleMessageFromChat);
  const currentTeamChatTarget = useMemo(() => {
    const identity = currentSession.meta.sessionIdentity;
    if (!identity) return null;
    const identityKey = buildSessionIdentityKey(identity);
    const sessionKey = currentSession.meta.backendSessionKey || currentSessionKey;
    const parsedTeamRoleSession = parseTeamRoleSessionKey(sessionKey);
    for (const team of teams) {
      if (!team.activeRunId) continue;
      const run = (runListByTeamId[team.id] ?? []).find((candidate) => candidate.runId === team.activeRunId);
      const roleSession = run?.sessions.find((session) => buildSessionIdentityKey(session.sessionIdentity) === identityKey);
      if (roleSession) {
        return { teamId: team.id, runId: team.activeRunId, roleId: roleSession.roleId };
      }
      const roleBinding = (rolesByTeamId[team.id] ?? []).find((role) => (
        role.runId === team.activeRunId
        && (
          buildSessionIdentityKey(role.sessionIdentity) === identityKey
          || role.sessionKey === sessionKey
        )
      ));
      if (roleBinding) {
        return { teamId: team.id, runId: team.activeRunId, roleId: roleBinding.roleId };
      }
      if (parsedTeamRoleSession?.runId === team.activeRunId) {
        return { teamId: team.id, runId: team.activeRunId, roleId: parsedTeamRoleSession.roleId };
      }
    }
    return null;
  }, [currentSession.meta.backendSessionKey, currentSession.meta.sessionIdentity, currentSessionKey, rolesByTeamId, runListByTeamId, teams]);
  const agents = useSubagentsStore((state) => (
    Array.isArray(state.agentsResource.data) ? state.agentsResource.data : EMPTY_AGENTS
  ));
  const availableModels = useSubagentsStore((state) => state.availableModels);
  const modelsLoading = useSubagentsStore((state) => state.modelsLoading);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
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
  const autoDefaultModelPatchRef = useRef<string | null>(null);

  const chatLayoutRef = useRef<HTMLDivElement>(null);
  const viewportPaneRef = useRef<ChatListHandle>(null);
  const workspaceActive = isActive;
  const sideEffectsActive = workspaceActive && isGatewayRunning;
  useChatInit({
    isActive: sideEffectsActive,
    isGatewayRunning,
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
    sidePanelOpen,
    sidePanelMode,
    sidePanelWidth,
    activeSidePanelTab,
    artifactWorkbenchFullscreen,
    unfinishedTaskCount,
    taskInboxTasks,
    taskInboxLoading,
    taskInboxError,
    refreshTaskInbox,
    clearTaskInboxError,
    derivedPlanStatus,
    toggleSidePanel,
    setActiveSidePanelTab,
    closeSidePanel,
    setSidePanelWidth,
    toggleArtifactWorkbenchFullscreen,
  } = useChatSidePanelController(sideEffectsActive, chatLayoutRef);

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
    if (!isGatewayRunning) {
      return;
    }
    void loadAvailableModels();
  }, [isGatewayRunning, loadAvailableModels]);

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
    if (!sideEffectsActive) {
      return;
    }
    prepareSkillConfig();
  }, [prepareSkillConfig, sideEffectsActive]);
  const refreshing = foregroundHistorySessionKey === currentSessionKey;
  const viewportItems = currentSession.items;
  const liveView = useChatView({
    currentSessionKey,
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
    const nextItems = applyAssistantPresentationToItems({
      items: viewportItems,
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
  }, [assistantCatalogAgents, currentAgent?.avatarSeed, currentAgent?.avatarStyle, currentAgent?.name, currentAgentId, viewportItems]);
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
    return resolveArtifactWorkspaceRoot({
      currentWorkspace: currentAgent?.workspace,
      artifactFiles,
      artifactFocusedFile,
    });
  }, [artifactFiles, artifactFocusedFile, currentAgent?.workspace]);
  const artifactWorkspaceRoot = defaultArtifactWorkspaceRoot;
  const artifactWorkspaceContext = useMemo(() => ({
    workspaceId: currentAgentId || undefined,
    sourceId: currentAgent?.workspace?.trim() || artifactWorkspaceRoot || undefined,
  }), [artifactWorkspaceRoot, currentAgent?.workspace, currentAgentId]);
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
      if (artifactAutoOpenedSessionKeyRef.current === currentSessionKey) {
        artifactAutoOpenedSessionKeyRef.current = null;
      }
      if (artifactFocusedGroupKey !== null) {
        setArtifactFocusedGroupKey(null);
      }
      return;
    }
    if (artifactAutoOpenedSessionKeyRef.current === currentSessionKey) {
      return;
    }
    const firstArtifactFile = resolveArtifactGroupFocusFile(artifactGroups[0] ?? null, null);
    if (!firstArtifactFile) {
      return;
    }
    artifactAutoOpenedSessionKeyRef.current = currentSessionKey;
    openGeneratedArtifact(firstArtifactFile);
  }, [artifactFiles, artifactFocusedGroupKey, artifactGroups, currentSessionKey, openGeneratedArtifact]);
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
    const fallbackGatewayRuntimeError = (
      localizedGatewayIssue
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
  }, [currentSession.runtime, dismissedRuntimeError, localizedGatewayIssue, t]);
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
  const fallbackModelId = availableModels[0]?.id ?? '';
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
      disabled: activeRun,
    };
  }, [activeRun, availableModels, effectiveCurrentModelId, modelsLoading]);
  const handleSendMessage = useCallback(async (
    text: string,
    attachments?: Parameters<typeof sendMessage>[1],
  ) => {
    viewportPaneRef.current?.prepareCurrentLatestBottomAlign();
    if (currentTeamChatTarget && (!attachments || attachments.length === 0)) {
      void submitTeamRoleMessageFromChat(currentTeamChatTarget.teamId, currentTeamChatTarget.roleId, text)
        .catch(() => undefined);
      return { accepted: true } as const;
    }
    return sendMessage(text, attachments);
  }, [currentTeamChatTarget, sendMessage, submitTeamRoleMessageFromChat]);
  const handleExportMarkdown = useCallback(() => {
    if (exportingMarkdown) {
      return;
    }
    setExportingMarkdown(true);
    void (async () => {
      try {
        const target = currentSession.meta.sessionIdentity
          ? resolveSessionOperationTarget(useChatStore.getState(), currentSessionKey)
          : null;
        const protocolItems = target
          ? await fetchChatMarkdownExportItems({
            sessionKey: target.sessionKey,
            sessionIdentity: target.sessionIdentity,
            currentItems: viewportItems,
            currentWindow: currentSession.window,
          })
          : viewportItems;
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
          title: currentSession.meta.displayName || currentSession.meta.label || currentAgent?.name || currentSessionKey,
          sessionKey: currentSession.meta.backendSessionKey || currentSessionKey,
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
  }, [assistantCatalogAgents, currentAgent?.avatarSeed, currentAgent?.avatarStyle, currentAgent?.name, currentAgentId, currentSession.meta.backendSessionKey, currentSession.meta.displayName, currentSession.meta.label, currentSession.meta.sessionIdentity, currentSession.window, currentSessionKey, exportingMarkdown, t, viewportItems]);
  const handleComposerWheel = useCallback((deltaY: number) => {
    viewportPaneRef.current?.scrollByWheelDelta(deltaY);
  }, []);
  const handleComposerGeometryChange = useCallback(() => {
    viewportPaneRef.current?.notifyComposerGeometryChanged();
  }, []);
  const handleSelectModel = useCallback(async (nextModelId: string, options?: { forcePatch?: boolean }) => {
    const normalizedNextModelId = nextModelId.trim();
    const currentModelId = effectiveCurrentModelId;
    if (!currentSessionKey) {
      return;
    }
    if (!normalizedNextModelId || (!options?.forcePatch && normalizedNextModelId === currentModelId)) {
      return;
    }
    if (activeRun) {
      return;
    }
    const previousModelId = currentSession.meta.model?.trim() || null;
    useChatStore.setState((state) => ({
      loadedSessions: patchSessionMeta(state, currentSessionKey, {
        model: normalizedNextModelId,
      }),
    }));
    try {
      const target = resolveSessionOperationTarget(useChatStore.getState(), currentSessionKey);
      const result = await hostSessionPatch({
        sessionKey: target.sessionKey,
        sessionIdentity: target.sessionIdentity,
        runtimeModelRef: normalizedNextModelId,
      });
      if (result.snapshot) {
        useChatStore.setState((state) => ({
          loadedSessions: patchSessionSnapshot(state, currentSessionKey, result.snapshot),
        }));
      }
      const appliedModelId = result.snapshot?.catalog?.model?.trim() || normalizedNextModelId;
      if (appliedModelId !== normalizedNextModelId) {
        throw new Error(appliedModelId || normalizedNextModelId);
      }
      void loadSessions();
    } catch (error) {
      useChatStore.setState((state) => ({
        loadedSessions: patchSessionMeta(state, currentSessionKey, {
          model: previousModelId,
        }),
      }));
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('input.modelSwitchFailed', { error: message }));
    }
  }, [activeRun, currentSession.meta.model, currentSessionKey, effectiveCurrentModelId, loadSessions, t]);

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

  useEffect(() => {
    const normalizedSessionModel = currentSession.meta.model?.trim() || '';
    const normalizedAgentModel = currentAgent?.model?.trim() || '';
    const normalizedEffectiveModel = effectiveCurrentModelId.trim();
    const hasAvailableModels = availableModelIds.size > 0;
    const sessionModelAvailable = normalizedSessionModel && availableModelIds.has(normalizedSessionModel);
    const agentModelAvailable = normalizedAgentModel && availableModelIds.has(normalizedAgentModel);
    if (
      !normalizedEffectiveModel
      || !currentSessionKey
      || currentSession.meta.historyStatus !== 'ready'
      || isRunActive(currentSession.runtime)
      || currentSession.runtime.activeRunId != null
      || (hasAvailableModels && (sessionModelAvailable || (!normalizedSessionModel && agentModelAvailable)))
      || (!hasAvailableModels && (normalizedSessionModel || normalizedAgentModel))
    ) {
      return;
    }
    const patchKey = `${currentSessionKey}:${normalizedEffectiveModel}`;
    if (autoDefaultModelPatchRef.current === patchKey) {
      return;
    }
    autoDefaultModelPatchRef.current = patchKey;
    void handleSelectModel(normalizedEffectiveModel, { forcePatch: true });
  }, [availableModelIds, currentAgent?.model, currentSession.meta.historyStatus, currentSession.meta.model, currentSession.runtime, currentSessionKey, effectiveCurrentModelId, handleSelectModel]);

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
        onSelect: (modelId) => {
          void handleSelectModel(modelId);
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
      disabled={!isGatewayRunning}
      reconnecting={preserveChatDuringGatewayRecovery}
      sending={isRunActive(currentSession.runtime)}
      stopping={currentSession.runtime.runPhase === 'stopping'}
      approvalWaiting={approvalStatus === 'awaiting_approval'}
      allowedSkillIds={allowedSkillIdsForChat}
      sessionIdentity={currentSession.meta.sessionIdentity}
      workspaceContext={artifactWorkspaceContext}
    />
  );

  if (!isGatewayRunning && isGatewayPreparing && !preserveChatDuringGatewayRecovery) {
    return (
      <ChatOffline
        title={t('gatewayPreparing.title')}
        description={t('gatewayPreparing.description')}
        tone="loading"
      />
    );
  }

  if (!isGatewayRunning && !preserveChatDuringGatewayRecovery) {
    return (
      <ChatOffline
        title={t('gatewayNotRunning')}
        description={localizedGatewayIssue || t('gatewayRequired')}
      />
    );
  }

  return (
    <>
      <ChatShell
        chatLayoutRef={chatLayoutRef}
        sidePanelOpen={sidePanelOpen}
        sidePanelMode={sidePanelMode}
        sidePanelWidth={sidePanelWidth}
        artifactWorkbenchFullscreen={artifactWorkbenchFullscreen}
        onSidePanelResize={setSidePanelWidth}
        onComposerWheel={handleComposerWheel}
        onComposerGeometryChange={handleComposerGeometryChange}
        isEmptyState={liveView.isEmptyState}
        emptyState={<WelcomeScreen input={inputNode} />}
        sidePanel={(
          <ChatSidePanel
            mode={sidePanelMode === 'hidden' ? 'docked' : sidePanelMode}
            width={sidePanelWidth}
            activeTab={activeSidePanelTab}
            artifactWorkbenchFullscreen={artifactWorkbenchFullscreen}
            onTabChange={setActiveSidePanelTab}
            onClose={closeSidePanel}
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
              void refresh();
            }}
            refreshBusy={refreshing || sessionsLoading}
            showThinking={showThinking}
            onToggleThinking={toggleThinking}
            exportDisabled={exportingMarkdown}
            onExportMarkdown={handleExportMarkdown}
            sidePanelOpen={sidePanelOpen}
            unfinishedTaskCount={unfinishedTaskCount}
            onToggleSidePanel={toggleSidePanel}
          />
        )}
        viewportPane={(
          <ChatList
            ref={viewportPaneRef}
            isActive={workspaceActive}
            currentSessionKey={currentSessionKey}
            runtime={currentSession.runtime}
            viewport={currentSession.window}
            items={renderItems}
            liveView={liveView}
            errorMessage={localizedRuntimeError}
            showThinking={showThinking}
            userAvatarDataUrl={userAvatarDataUrl}
            sessionIdentity={currentSession.meta.sessionIdentity ?? undefined}
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
              void loadOlderViewportItems(currentSessionKey);
            }}
            loadOlderLabel={t('liveThread.loadOlder')}
            onJumpToLatest={() => {
              void jumpViewportToLatest(currentSessionKey);
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
        todoPanel={<SessionTodoPanel sessionKey={currentSessionKey} />}
        input={inputNode}
      />
    </>
  );
}

export default Chat;
