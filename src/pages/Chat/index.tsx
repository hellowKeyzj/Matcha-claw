/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. Session selector, thinking toggle, and refresh
 * are in the toolbar; messages render with markdown + streaming.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type ApprovalItem, type ChatStoreState } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { useSubagentsStore } from '@/stores/subagents';
import { useSettingsStore } from '@/stores/settings';
import type { GatewayTransportIssue } from '../../../runtime-host/shared/gateway-error';
import { isGatewayOperational } from '@/lib/gateway-status';
import {
  createEmptySessionRecord,
  getPendingApprovals,
  getSessionApprovalStatus,
  getSessionItemCount,
} from '@/stores/chat/store-state-helpers';
import { ChatShell } from './components/ChatShell';
import { ChatSidePanel } from './components/ChatSidePanel';
import { ChatOffline } from './components/ChatOffline';
import { ChatInput } from './ChatInput';
import { ChatList, type ChatListHandle } from './components/ChatList';
import { ChatHeaderBar } from './components/ChatHeaderBar';
import { ChatApprovalDock, ChatErrorBanner } from './components/ChatRuntimeDock';
import { WelcomeScreen } from './components/ChatStates';
import { useChatInit } from './useChatInit';
import { useChatSidePanelController } from './useChatSidePanelController';
import { useSkillConfig } from './useSkillConfig';
import { useChatView } from './useChatView';

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
    approvalStatus: getSessionApprovalStatus(state, currentSessionKey),
    currentPendingApprovals: getPendingApprovals(state, currentSessionKey) ?? EMPTY_APPROVAL_ITEMS,
    foregroundHistorySessionKey: state.foregroundHistorySessionKey,
    sessionsLoading: state.sessionCatalogStatus.status === 'loading',
    mutating: state.mutating,
    runtimeError: currentSession.runtime.lastError,
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
    currentSessionKey,
    currentSession,
    approvalStatus,
    currentPendingApprovals,
    foregroundHistorySessionKey,
    sessionsLoading,
    mutating,
    runtimeError,
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
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const updateAgent = useSubagentsStore((state) => state.updateAgent);
  const currentAgent = agents.find((agent) => agent.id === currentAgentId);
  const skills = useSkillsStore((state) => state.skills);
  const skillsSnapshotReady = useSkillsStore((state) => state.snapshotReady);
  const skillsInitialLoading = useSkillsStore((state) => state.initialLoading);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const userAvatarDataUrl = useSettingsStore((state) => state.userAvatarDataUrl);

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
    unfinishedTaskCount,
    toggleSidePanel,
    setActiveSidePanelTab,
    closeSidePanel,
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
    updateAgent,
  });

  useEffect(() => {
    resetSkillConfigSession();
  }, [currentAgentId, resetSkillConfigSession]);

  useEffect(() => {
    if (sidePanelOpen && activeSidePanelTab === 'skills') {
      prepareSkillConfig();
    }
  }, [activeSidePanelTab, prepareSkillConfig, sidePanelOpen]);
  const refreshing = foregroundHistorySessionKey === currentSessionKey;
  const liveView = useChatView({
    currentSessionStatus: currentSession.meta.historyStatus,
    itemCount: getSessionItemCount(currentSession),
    sending: currentSession.runtime.sending,
    refreshing,
    mutating,
  });
  const allowedSkillIds = useMemo(() => {
    const matchedAgent = agents.find((agent) => agent.id === currentAgentId);
    return Array.isArray(matchedAgent?.skills) ? matchedAgent.skills : null;
  }, [agents, currentAgentId]);
  const localizedRuntimeError = useMemo(() => {
    const localizedRuntimeIssue = localizeGatewayIssue(currentSession.runtime.lastIssue ?? undefined, t);
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
    const effectiveRuntimeError = localizedRuntimeIssue
      ?? runtimeError
      ?? fallbackGatewayRuntimeError;
    if (!effectiveRuntimeError) {
      return null;
    }
    if (effectiveRuntimeError === ACTIVE_RUN_DISCONNECTED_ERROR) {
      return t('errors.activeRunDisconnected');
    }
    return effectiveRuntimeError;
  }, [currentSession.runtime.lastIssue, currentSession.runtime.pendingFinal, currentSession.runtime.runPhase, currentSession.runtime.sending, localizedGatewayIssue, runtimeError, t]);
  const handleSendMessage = useCallback(async (
    text: string,
    attachments?: Parameters<typeof sendMessage>[1],
  ) => {
    viewportPaneRef.current?.prepareCurrentLatestBottomAlign();
    await sendMessage(text, attachments);
  }, [sendMessage]);
  const inputNode = (
    <ChatInput
      onSend={handleSendMessage}
      onStop={abortRun}
      disabled={false}
      sending={currentSession.runtime.sending}
      approvalWaiting={approvalStatus === 'awaiting_approval'}
      allowedSkillIds={allowedSkillIds}
    />
  );

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
        isEmptyState={liveView.isEmptyState}
        emptyState={<WelcomeScreen input={inputNode} />}
        sidePanel={(
          <ChatSidePanel
            mode={sidePanelMode === 'hidden' ? 'docked' : sidePanelMode}
            width={sidePanelWidth}
            activeTab={activeSidePanelTab}
            onTabChange={setActiveSidePanelTab}
            onClose={closeSidePanel}
            unfinishedTaskCount={unfinishedTaskCount}
            skillConfigLabel={t('toolbar.skillConfig')}
            skillConfigTitle={t('skillConfigDialog.titleWithAgent', { agent: currentAgent?.name || currentAgentId })}
            skillOptions={availableSkillOptions}
            skillsLoading={skillConfigSkillsLoading}
            selectedSkillIds={selectedSkillIds}
            onToggleSkill={toggleSkillConfigSelection}
          />
        )}
        header={(
          <ChatHeaderBar
            showBackgroundStatus={liveView.showBackgroundStatus}
            refreshing={refreshing}
            statusRefreshingLabel={t('status.refreshing')}
            statusMutatingLabel={t('status.mutating')}
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
            currentSession={currentSession}
            approvalStatus={approvalStatus}
            agents={agents}
            isGatewayRunning={isGatewayRunning}
            errorMessage={localizedRuntimeError}
            showThinking={showThinking}
            userAvatarDataUrl={userAvatarDataUrl}
            defaultAssistant={{
              agentId: currentAgentId,
              agentName: currentAgent?.name || currentAgentId,
              avatarSeed: currentAgent?.avatarSeed,
              avatarStyle: currentAgent?.avatarStyle,
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
        input={inputNode}
      />
    </>
  );
}

export default Chat;
