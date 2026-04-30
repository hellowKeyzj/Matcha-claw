/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. Session selector, thinking toggle, and refresh
 * are in the toolbar; messages render with markdown + streaming.
 */
import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChatShell } from './components/ChatShell';
import { AgentSkillConfigDialog } from './components/AgentSkillConfigDialog';
import { ChatOffline } from './components/ChatOffline';
import { ChatInput } from './ChatInput';
import { ChatViewportStage } from './components/ChatViewportStage';
import { ChatViewportPane, type ChatViewportPaneHandle } from './components/ChatViewportPane';
import { ChatHeaderBar } from './components/ChatHeaderBar';
import { ChatApprovalDock, ChatErrorBanner } from './components/ChatRuntimeDock';
import { useInboxLayout } from './useInboxLayout';
import { useChatActivation } from './useChatActivation';
import { useSkillConfig } from './useSkillConfig';
import { useChatView } from './useChatView';
import { useChatPageModel } from './useChatPageModel';

interface ChatProps {
  isActive?: boolean;
}

export function Chat({ isActive = true }: ChatProps) {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const navigate = useNavigate();
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
    viewportMessages,
    viewport,
    currentSessionKey,
    currentSessionStatus,
  } = sessionState;
  const {
    foregroundHistorySessionKey,
    mutating,
    error,
    showThinking,
  } = viewState;
  const {
    sending,
    streamingMessageId,
    streamingTools,
    pendingFinal,
    currentPendingApprovals,
  } = runtimeState;
  const {
    resolveApproval,
    loadHistory,
    loadOlderMessages,
    jumpToLatest,
    trimTopMessages,
    loadSessions,
    switchSession,
    openAgentConversation,
    sendMessage,
    abortRun,
    clearError,
    cleanupEmptySession,
  } = actions;

  const chatLayoutRef = useRef<HTMLDivElement>(null);
  const viewportPaneRef = useRef<ChatViewportPaneHandle>(null);
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
    if (!viewport.isAtLatest) {
      viewportPaneRef.current?.prepareCurrentLatestBottomAlign();
      await jumpToLatest(currentSessionKey);
    }
    await sendMessage(text, attachments);
  }, [currentSessionKey, jumpToLatest, sendMessage, viewport.isAtLatest]);

  const inputRowCount = useMemo(() => {
    const hasStreamingSurface = Boolean(
      streamingMessageId
      && viewportMessages.some((message) => message.id === streamingMessageId),
    );
    const runtimeStatusRow = (
      sending
      && !waitingApproval
      && !hasStreamingSurface
      && streamingTools.length === 0
    );
    return viewportMessages.length + (runtimeStatusRow ? 1 : 0);
  }, [sending, streamingMessageId, streamingTools.length, viewportMessages, waitingApproval]);

  const liveView = useChatView({
    currentSessionStatus,
    rowCount: inputRowCount,
    sending,
    refreshing: foregroundHistorySessionKey === currentSessionKey,
    mutating,
  });
  const showBackgroundStatus = liveView.showBackgroundStatus;

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

  const viewportPane = (
    <ChatViewportPane
      ref={viewportPaneRef}
      isActive={activation.workspaceActive}
      currentSessionKey={currentSessionKey}
      viewport={viewport}
      agents={agents}
      isGatewayRunning={isGatewayRunning}
      gatewayRpc={gatewayRpc}
      currentSessionStatus={currentSessionStatus}
      errorMessage={error}
      sending={sending}
      pendingFinal={Boolean(pendingFinal)}
      waitingApproval={waitingApproval}
      showThinking={showThinking}
      streamingTools={streamingTools}
      userAvatarDataUrl={userAvatarDataUrl}
      assistantAgentId={currentAgentId}
      assistantAgentName={currentAgent?.name || currentAgentId}
      assistantAvatarSeed={currentAgent?.avatarSeed}
      assistantAvatarStyle={currentAgent?.avatarStyle}
      onLoadOlder={() => {
        void loadOlderMessages(currentSessionKey).then(() => {
          trimTopMessages(currentSessionKey, 120);
        });
      }}
      loadOlderLabel={t('liveThread.loadOlder')}
      onJumpToLatest={() => {
        void jumpToLatest(currentSessionKey);
      }}
      jumpToLatestLabel={t('liveThread.jumpToLatest')}
      jumpToBottomLabel={t('liveThread.jumpToBottom')}
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

  const stagePanel = (
    <ChatViewportStage
      header={(
        <ChatHeaderBar
          showBackgroundStatus={showBackgroundStatus}
          refreshing={foregroundHistorySessionKey === currentSessionKey}
          hasCurrentAgent={Boolean(currentAgent)}
          onOpenSkillConfig={openSkillConfigDialog}
          skillConfigLabel={t('toolbar.skillConfig')}
          statusRefreshingLabel={t('status.refreshing')}
          statusMutatingLabel={t('status.mutating')}
        />
      )}
      viewportPane={viewportPane}
      errorBanner={error ? (
        <ChatErrorBanner
          error={error}
          dismissLabel={t('common:actions.dismiss')}
          onDismiss={clearError}
        />
      ) : null}
      approvalDock={waitingApproval ? (
        <ChatApprovalDock
          waitingLabel={t('approval.waitingLabel')}
          approvals={currentPendingApprovals}
          onResolve={(id, decision) => {
            void resolveApproval(id, decision);
          }}
        />
      ) : null}
      input={(
        <ChatInput
          onSend={handleSendMessage}
          onStop={abortRun}
          disabled={!isGatewayRunning}
          sending={sending}
          approvalWaiting={waitingApproval}
        />
      )}
    />
  );

  return (
    <>
      <ChatShell
        chatLayoutRef={chatLayoutRef}
        taskInboxCollapsed={taskInboxCollapsed}
        taskInboxWidth={taskInboxWidth}
        taskInboxResizerWidth={taskInboxResizerWidth}
        onTaskInboxResizeStart={startTaskInboxResize}
        onToggleTaskInbox={() => {
          setTaskInboxCollapsed((prev) => !prev);
        }}
        stagePanel={stagePanel}
      />
      <AgentSkillConfigDialog
        open={skillConfigOpen}
        title={t('skillConfigDialog.titleWithAgent', { agent: currentAgent?.name || currentAgentId })}
        skillOptions={availableSkillOptions}
        skillsLoading={skillConfigSkillsLoading}
        selectedSkillIds={selectedSkillIds}
        submitting={skillConfigSaving}
        onToggleSkill={toggleSkillConfigSelection}
        onClose={closeSkillConfigDialog}
        onSubmit={() => {
          void saveSkillConfig();
        }}
      />
    </>
  );
}

export default Chat;
