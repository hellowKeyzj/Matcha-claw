/**
 * Chat Page
 * Native React implementation using runtime-host session APIs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type ApprovalItem, type ChatStoreState } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { useSubagentsStore } from '@/stores/subagents';
import { useSettingsStore } from '@/stores/settings';
import type { GatewayTransportIssue } from '../../../runtime-host/shared/gateway-error';
import { isGatewayOperational, isGatewayPreparing as resolveGatewayPreparing } from '@/lib/gateway-status';
import {
  createEmptySessionRecord,
  getPendingApprovals,
  getSessionApprovalStatus,
  patchSessionMeta,
  patchSessionSnapshot,
} from '@/stores/chat/store-state-helpers';
import { hasVisibleRuntimeError } from '@/stores/chat/runtime-error-view';
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
import { useSkillConfig } from './useSkillConfig';
import { useChatView } from './useChatView';
import {
  applyAssistantPresentationToItems,
  type ChatAssistantCatalogAgent,
  type ChatRenderItem,
} from './chat-render-item-model';
import { hostApiFetch, hostSessionPatch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { toast } from 'sonner';
import { collectChatArtifactGroups } from './artifacts';
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
    loadHistory: state.loadHistory,
    loadSessions: state.loadSessions,
    cleanupEmptySession: state.cleanupEmptySession,
  };
}

function parseAgentIdFromSessionKey(sessionKey: string): string {
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? 'main';
}

function resolveEffectiveChatModelId(
  sessionModel: string | null | undefined,
  agentDefaultModel: string | null | undefined,
): string {
  const normalizedSessionModel = typeof sessionModel === 'string' ? sessionModel.trim() : '';
  if (normalizedSessionModel) {
    return normalizedSessionModel;
  }
  const normalizedAgentDefaultModel = typeof agentDefaultModel === 'string' ? agentDefaultModel.trim() : '';
  return normalizedAgentDefaultModel;
}

export function Chat({ isActive = true }: ChatProps) {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const navigate = useNavigate();
  const gatewayStatus = useGatewayStore((state) => state.status);
  const gatewayInitialized = useGatewayStore((state) => state.isInitialized);
  const isGatewayRunning = isGatewayOperational(gatewayStatus);
  const isGatewayPreparing = resolveGatewayPreparing(gatewayStatus, gatewayInitialized);
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
    loadHistory,
    loadSessions,
    cleanupEmptySession,
  } = useChatStore(useShallow(selectChatPageState));
  const currentAgentId = parseAgentIdFromSessionKey(currentSessionKey);
  const agents = useSubagentsStore((state) => (
    Array.isArray(state.agentsResource.data) ? state.agentsResource.data : EMPTY_AGENTS
  ));
  const availableModels = useSubagentsStore((state) => state.availableModels);
  const modelsLoading = useSubagentsStore((state) => state.modelsLoading);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const currentAgent = agents.find((agent) => agent.id === currentAgentId);
  const skills = useSkillsStore((state) => state.skills);
  const skillsSnapshotReady = useSkillsStore((state) => state.snapshotReady);
  const skillsInitialLoading = useSkillsStore((state) => state.initialLoading);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const userAvatarDataUrl = useSettingsStore((state) => state.userAvatarDataUrl);
  const [skillPreview, setSkillPreview] = useState<ChatSkillPreviewState | null>(null);
  const [artifactActiveSection, setArtifactActiveSection] = useState<ChatArtifactSection>('changes');
  const [artifactFocusedGroupKey, setArtifactFocusedGroupKey] = useState<string | null>(null);
  const [artifactFocusedFilePath, setArtifactFocusedFilePath] = useState<string | null>(null);
  const [artifactFocusedFileOverride, setArtifactFocusedFileOverride] = useState<ArtifactPreviewTarget | null>(null);
  const [artifactViewMode, setArtifactViewMode] = useState<'preview' | 'diff'>('diff');
  const skillPreviewRequestSeqRef = useRef(0);
  const previousRenderedItemsRef = useRef<ChatRenderItem[] | null>(null);
  const artifactAutoOpenedSessionKeyRef = useRef<string | null>(null);

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
    derivedPlanStatus,
    toggleSidePanel,
    setActiveSidePanelTab,
    closeSidePanel,
    setSidePanelWidth,
    toggleArtifactWorkbenchFullscreen,
  } = useChatSidePanelController(sideEffectsActive, chatLayoutRef);

  const {
    selectedSkillIds,
    availableSkillOptions,
    skillsLoading: skillConfigSkillsLoading,
    prepare: prepareSkillConfig,
    resetSession: resetSkillConfigSession,
    toggleSkill: toggleSkillConfigSelection,
  } = useSkillConfig({
    currentAgent,
    readAgent: (agentId) => (
      useSubagentsStore.getState().agentsResource.data.find((agent) => agent.id === agentId)
    ),
    skills,
    skillsSnapshotReady,
    skillsInitialLoading,
    fetchSkills,
    updateAgent: useSubagentsStore.getState().updateAgent,
  });

  useEffect(() => {
    resetSkillConfigSession();
    skillPreviewRequestSeqRef.current += 1;
    setSkillPreview(null);
  }, [currentAgentId, resetSkillConfigSession]);

  useEffect(() => {
    void loadAvailableModels();
  }, [loadAvailableModels]);

  useEffect(() => {
    if (sidePanelOpen && activeSidePanelTab === 'skills') {
      prepareSkillConfig();
    }
  }, [activeSidePanelTab, prepareSkillConfig, sidePanelOpen]);
  const refreshing = foregroundHistorySessionKey === currentSessionKey;
  const viewportItems = currentSession.items;
  const liveView = useChatView({
    currentSessionStatus: currentSession.meta.historyStatus,
    itemCount: viewportItems.length,
    sending: currentSession.runtime.sending,
  });
  const allowedSkillIds = useMemo(() => {
    const matchedAgent = agents.find((agent) => agent.id === currentAgentId);
    return Array.isArray(matchedAgent?.skills) ? matchedAgent.skills : null;
  }, [agents, currentAgentId]);
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
    const visibleRuntimeError = hasVisibleRuntimeError({
      runtime: currentSession.runtime,
      dismissedMarker: dismissedRuntimeError,
    });
    const localizedRuntimeIssue = visibleRuntimeError
      ? localizeGatewayIssue(currentSession.runtime.lastIssue ?? undefined, t)
      : null;
    const runtimeMessage = visibleRuntimeError
      ? (localizedRuntimeIssue ?? currentSession.runtime.lastError)
      : null;
    const fallbackGatewayRuntimeError = (
      localizedGatewayIssue
      && (
        currentSession.runtime.sending
        || currentSession.runtime.pendingFinal
        || currentSession.runtime.runPhase === 'finalizing'
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
    return effectiveRuntimeError;
  }, [currentSession.runtime, dismissedRuntimeError, localizedGatewayIssue, t]);
  const effectiveCurrentModelId = useMemo(() => {
    return resolveEffectiveChatModelId(currentSession.meta.model, currentAgent?.model);
  }, [currentAgent?.model, currentSession.meta.model]);
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
    };
  }, [availableModels, effectiveCurrentModelId, modelsLoading]);
  const handleSendMessage = useCallback(async (
    text: string,
    attachments?: Parameters<typeof sendMessage>[1],
  ) => {
    viewportPaneRef.current?.prepareCurrentLatestBottomAlign();
    await sendMessage(text, attachments);
  }, [sendMessage]);
  const handleComposerWheel = useCallback((deltaY: number) => {
    viewportPaneRef.current?.scrollByWheelDelta(deltaY);
  }, []);
  const handleComposerGeometryChange = useCallback(() => {
    viewportPaneRef.current?.notifyComposerGeometryChanged();
  }, []);
  const handleSelectModel = useCallback(async (nextModelId: string) => {
    const normalizedNextModelId = nextModelId.trim();
    const currentModelId = effectiveCurrentModelId;
    if (!currentSessionKey) {
      return;
    }
    if (!normalizedNextModelId || normalizedNextModelId === currentModelId) {
      return;
    }
    const previousModelId = currentSession.meta.model?.trim() || null;
    useChatStore.setState((state) => ({
      loadedSessions: patchSessionMeta(state, currentSessionKey, {
        model: normalizedNextModelId,
      }),
    }));
    try {
      const result = await hostSessionPatch({
        sessionKey: currentSessionKey,
        model: normalizedNextModelId,
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
  }, [currentSession.meta.model, currentSessionKey, effectiveCurrentModelId, loadSessions, t]);
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
      disabled={false}
      sending={currentSession.runtime.sending}
      approvalWaiting={approvalStatus === 'awaiting_approval'}
      allowedSkillIds={allowedSkillIds}
    />
  );

  if (!isGatewayRunning && isGatewayPreparing) {
    return (
      <ChatOffline
        title={t('gatewayPreparing.title')}
        description={t('gatewayPreparing.description')}
        tone="loading"
      />
    );
  }

  if (!isGatewayRunning) {
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
            onArtifactFocusFile={handleArtifactFocusTarget}
            onOpenGeneratedArtifactFile={openGeneratedArtifact}
            onOpenArtifactGroup={handleOpenArtifactGroup}
            onArtifactSectionChange={setArtifactActiveSection}
            onArtifactViewModeChange={setArtifactViewMode}
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
        errorBanner={localizedRuntimeError ? (
          <ChatErrorBanner
            error={localizedRuntimeError}
            dismissLabel={t('common:actions.dismiss')}
            onDismiss={clearError}
          />
        ) : null}
        approvalDock={approvalStatus === 'awaiting_approval' ? (
          <ChatApprovalDock
            waitingLabel={t('approval.waitingLabel')}
            approvals={currentPendingApprovals}
            onResolve={(id, decision) => {
              void resolveApproval(id, decision);
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
