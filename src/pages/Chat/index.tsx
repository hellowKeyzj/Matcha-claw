/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. Session selector, thinking toggle, and refresh
 * are in the toolbar; messages render with markdown + streaming.
 */
import { useCallback, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '@/stores/chat';
import { selectChatLiveThreadHostKeys } from '@/stores/chat/selectors';
import { ChatShell } from './components/ChatShell';
import { ChatOffline } from './components/ChatOffline';
import { ChatThreadPane, type ChatThreadPaneHandle } from './components/ChatThreadPane';
import { useInboxLayout } from './useInboxLayout';
import { useChatActivation } from './useChatActivation';
import { useSkillConfig } from './useSkillConfig';
import { useChatView } from './useChatView';
import { useChatPageModel } from './useChatPageModel';
import { useChatShellProps } from './useChatShellProps';
import { useChatProjection } from './useChatProjection';

interface ChatProps {
  isActive?: boolean;
}

export function Chat({ isActive = true }: ChatProps) {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const navigate = useNavigate();
  const liveSessionHostKeys = useChatStore(useShallow(selectChatLiveThreadHostKeys));
  const {
    isGatewayRunning,
    gatewayRpc,
    sessionState,
    viewState,
    runtimeState,
    actions,
    agents,
    loadAgents,
    updateAgent,
    skills,
    skillsSnapshotReady,
    skillsInitialLoading,
    fetchSkills,
    userAvatarDataUrl,
    currentAgentId,
    currentAgent,
    waitingApproval,
  } = useChatPageModel();
  const {
    canonicalMessages,
    currentSessionKey,
    currentSessionReady,
    currentSessionHasActivity,
  } = sessionState;
  const {
    initialLoading,
    refreshing,
    mutating,
    error,
    showThinking,
  } = viewState;
  const {
    sending,
    pendingUserMessage,
    streamingMessage,
    streamingTools,
    currentPendingApprovals,
  } = runtimeState;
  const {
    resolveApproval,
    loadHistory,
    loadSessions,
    switchSession,
    openAgentConversation,
    sendMessage,
    abortRun,
    clearError,
    cleanupEmptySession,
  } = actions;

  const chatLayoutRef = useRef<HTMLDivElement>(null);
  const threadPaneRef = useRef<ChatThreadPaneHandle>(null);
  const activation = useChatActivation({
    isActive,
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
  const projection = useChatProjection({
    currentSessionKey,
    liveMessages: canonicalMessages,
    gatewayRpc,
  });

  const {
    taskInboxCollapsed,
    setTaskInboxCollapsed,
    taskInboxWidth,
    startTaskInboxResize,
    taskInboxResizerWidth,
  } = useInboxLayout(activation.layoutEffectsActive, chatLayoutRef);

  const handleSendMessage = useCallback(async (
    text: string,
    attachments?: Parameters<typeof sendMessage>[1],
  ) => {
    if (projection.isHistoryProjection) {
      threadPaneRef.current?.prepareCurrentLiveBottomAlign();
      flushSync(() => {
        projection.returnToLive();
      });
    }
    await sendMessage(text, attachments);
  }, [projection, sendMessage]);

  const inputRowCount = useMemo(() => {
    const historyMessageCount = projection.messages.length;
    if (projection.isHistoryProjection) {
      return historyMessageCount;
    }
    let runtimeRowCount = historyMessageCount;
    if (pendingUserMessage) {
      runtimeRowCount += 1;
    }
    if (streamingMessage || streamingTools.length > 0) {
      runtimeRowCount += 1;
    }
    return runtimeRowCount;
  }, [pendingUserMessage, projection, streamingMessage, streamingTools.length]);

  const liveView = useChatView({
    currentSessionKey,
    currentSessionReady,
    currentSessionHasActivity,
    rowCount: inputRowCount,
    sending: projection.isHistoryProjection ? false : sending,
    initialLoading,
    refreshing,
    mutating,
  });
  const showBackgroundStatus = projection.isHistoryProjection ? false : liveView.showBackgroundStatus;
  const isEmptyState = projection.isHistoryProjection
    ? projection.messages.length === 0 && !projection.loading
    : liveView.isEmptyState;

  const {
    open: skillConfigOpen,
    saving: skillConfigSaving,
    selectedSkillIds,
    availableSkillOptions,
    skillsLoading: skillConfigSkillsLoading,
    openDialog: openSkillConfigDialog,
    closeDialog: closeSkillConfigDialog,
    toggleSkill: toggleSkillConfigSelection,
    save: saveSkillConfig,
  } = useSkillConfig({
    currentAgent,
    skills,
    skillsSnapshotReady,
    skillsInitialLoading,
    fetchSkills,
    updateAgent,
  });

  const threadPanel = (
    <ChatThreadPane
      ref={threadPaneRef}
      isActive={activation.workspaceActive}
      currentSessionKey={currentSessionKey}
      liveSessionHostKeys={liveSessionHostKeys}
      readProjection={projection.readProjection}
      historyMessages={projection.messages}
      historyLoading={projection.loading}
      agents={agents}
      isGatewayRunning={isGatewayRunning}
      gatewayRpc={gatewayRpc}
      initialLoading={initialLoading}
      refreshing={refreshing}
      mutating={mutating}
      showThinking={showThinking}
      userAvatarDataUrl={userAvatarDataUrl}
      onEnterHistory={projection.enterHistory}
      viewFullHistoryLabel={t('liveThread.viewFullHistory')}
    />
  );

  const chatShellProps = useChatShellProps({
    t,
    chatLayoutRef,
    taskInboxCollapsed,
    setTaskInboxCollapsed,
    taskInboxWidth,
    taskInboxResizerWidth,
    startTaskInboxResize,
    showBackgroundStatus,
    refreshing,
    hasCurrentAgent: Boolean(currentAgent),
    openSkillConfigDialog,
    threadPanel,
    isEmptyState,
    error: projection.error ?? error,
    clearError,
    waitingApproval: projection.isHistoryProjection ? false : waitingApproval,
    isHistoryProjection: projection.isHistoryProjection,
    currentPendingApprovals,
    resolveApproval,
    sendMessage: handleSendMessage,
    abortRun,
    isGatewayRunning,
    sending,
    skillConfigOpen,
    currentAgentName: currentAgent?.name || '',
    currentAgentId,
    availableSkillOptions,
    skillConfigSkillsLoading,
    selectedSkillIds,
    skillConfigSaving,
    toggleSkillConfigSelection,
    closeSkillConfigDialog,
    saveSkillConfig,
  });

  if (!isGatewayRunning) {
    return (
      <ChatOffline
        title={t('gatewayNotRunning')}
        description={t('gatewayRequired')}
      />
    );
  }

  return (
    <ChatShell {...chatShellProps} />
  );
}

export default Chat;
