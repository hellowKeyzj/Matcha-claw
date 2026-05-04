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
import {
  createEmptySessionRecord,
  getPendingApprovals,
  getSessionApprovalStatus,
  getSessionRowCount,
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
    error: state.error,
    showThinking: state.showThinking,
    refresh: state.refresh,
    toggleThinking: state.toggleThinking,
    loadOlderMessages: state.loadOlderMessages,
    jumpToLatest: state.jumpToLatest,
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
  const isGatewayRunning = gatewayStatus.state === 'running';
  const {
    currentSessionKey,
    currentSession,
    approvalStatus,
    currentPendingApprovals,
    foregroundHistorySessionKey,
    sessionsLoading,
    mutating,
    error,
    showThinking,
    refresh,
    toggleThinking,
    loadOlderMessages,
    jumpToLatest,
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
    rowCount: getSessionRowCount(currentSession),
    sending: currentSession.runtime.sending,
    refreshing,
    mutating,
  });
  const allowedSkillIds = useMemo(() => {
    const matchedAgent = agents.find((agent) => agent.id === currentAgentId);
    return Array.isArray(matchedAgent?.skills) ? matchedAgent.skills : null;
  }, [agents, currentAgentId]);
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
        description={t('gatewayRequired')}
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
            errorMessage={error}
            showThinking={showThinking}
            userAvatarDataUrl={userAvatarDataUrl}
            defaultAssistant={{
              agentId: currentAgentId,
              agentName: currentAgent?.name || currentAgentId,
              avatarSeed: currentAgent?.avatarSeed,
              avatarStyle: currentAgent?.avatarStyle,
            }}
            onLoadOlder={() => {
              void loadOlderMessages(currentSessionKey);
            }}
            loadOlderLabel={t('liveThread.loadOlder')}
            onJumpToLatest={() => {
              void jumpToLatest(currentSessionKey);
            }}
            jumpToBottomLabel={t('liveThread.jumpToBottom')}
          />
        )}
        errorBanner={error ? (
          <ChatErrorBanner
            error={error}
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
