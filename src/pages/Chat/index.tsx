/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. Session selector, thinking toggle, and refresh
 * are in the toolbar; messages render with markdown + streaming.
 */
import { useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChatShell } from './components/ChatShell';
import { ChatOffline } from './components/ChatOffline';
import { useInboxLayout } from './useInboxLayout';
import { useChatRealtimePerfMetrics } from './useChatPerf';
import { useChatFirstPaint } from './useFirstPaint';
import { useChatRenderItems } from './chat-render-items';
import { useRowsPipeline } from './useRowsPipeline';
import { useChatInit } from './useChatInit';
import { useSkillConfig } from './useSkillConfig';
import { useChatView } from './useChatView';
import { useChatPageModel } from './useChatPageModel';
import { useChatListCtl } from './useChatListCtl';
import { useChatShellProps } from './useChatShellProps';
import { useChatProjection } from './useChatProjection';

export function Chat() {
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
    messages,
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
    streamingMessage,
    streamingTools,
    pendingFinal,
    lastUserMessageAt,
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

  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const chatLayoutRef = useRef<HTMLDivElement>(null);
  const markScrollActivityRef = useRef<() => void>(() => {});
  const streamingTimestamp = lastUserMessageAt != null ? (lastUserMessageAt / 1000) : 0;
  const projection = useChatProjection({
    currentSessionKey,
    gatewayRpc,
  });
  const projectionScopeKey = projection.projectionScopeKey;
  const rowSourceMessages = projection.isHistoryProjection ? projection.messages : messages;
  const runtimeSending = projection.isHistoryProjection ? false : sending;
  const runtimePendingFinal = projection.isHistoryProjection ? false : pendingFinal;
  const runtimeWaitingApproval = projection.isHistoryProjection ? false : waitingApproval;
  const runtimeStreamingMessage = projection.isHistoryProjection ? null : streamingMessage;
  const runtimeStreamingTools = projection.isHistoryProjection ? [] : streamingTools;
  const {
    taskInboxCollapsed,
    setTaskInboxCollapsed,
    taskInboxWidth,
    startTaskInboxResize,
    taskInboxResizerWidth,
  } = useInboxLayout(chatLayoutRef);
  const sessionPipelineCostRef = useRef<{
    sessionKey: string;
    rowSliceMs: number;
    staticRowsMs: number;
    runtimeRowsMs: number;
  }>({
    sessionKey: currentSessionKey,
    rowSliceMs: 0,
    staticRowsMs: 0,
    runtimeRowsMs: 0,
  });

  useChatInit({
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
    handleViewportPointerDown,
    handleViewportTouchMove,
    handleViewportWheel,
    handleViewportScroll,
    isUserScrolling,
    scrollDirection,
    scrollEventSeq,
    scrollToRowKey,
    prepareScopeAnchorRestore,
    prepareScopeBottomAlign,
  } = useChatListCtl({
    scrollScopeKey: projectionScopeKey,
    scrollResetKey: currentSessionKey,
    messagesViewportRef,
    messageContentRef,
    markScrollActivity: () => markScrollActivityRef.current(),
  });
  const {
    chatRows,
    suppressedToolCardRowKeys,
    bodyRenderModeByRowKey,
    requestFullRender,
    hiddenHistoryCount,
    rowSliceCostMs,
    runtimeRowsCostMs,
  } = useRowsPipeline({
    projectionScopeKey,
    rowSessionKey: currentSessionKey,
    messages: rowSourceMessages,
    isHistoryProjection: projection.isHistoryProjection,
    viewportRef: messagesViewportRef,
    contentRef: messageContentRef,
    isUserScrolling,
    scrollDirection,
    scrollEventSeq,
    agents,
    isGatewayRunning,
    gatewayRpc,
    sending: runtimeSending,
    pendingFinal: runtimePendingFinal,
    waitingApproval: runtimeWaitingApproval,
    showThinking,
    streamingMessage: runtimeStreamingMessage,
    streamingTools: runtimeStreamingTools,
    streamingTimestamp,
    sessionPipelineCostRef,
  });
  const chatItems = useChatRenderItems(projectionScopeKey, chatRows);

  const handleOpenHistoryProjection = useCallback(() => {
    prepareScopeAnchorRestore(`${currentSessionKey}::history`);
    projection.enterHistory();
  }, [currentSessionKey, prepareScopeAnchorRestore, projection]);

  const handleSendMessage = useCallback(async (
    text: string,
    attachments?: Parameters<typeof sendMessage>[1],
  ) => {
    if (projection.isHistoryProjection) {
      prepareScopeBottomAlign(`${currentSessionKey}::live`);
      flushSync(() => {
        projection.returnToLive();
      });
    }
    await sendMessage(text, attachments);
  }, [currentSessionKey, prepareScopeBottomAlign, projection, sendMessage]);

  const liveView = useChatView({
    currentSessionKey,
    currentSessionReady,
    currentSessionHasActivity,
    rowCount: chatRows.length,
    sending: runtimeSending,
    initialLoading,
    refreshing,
    mutating,
  });
  const showBlockingLoading = projection.isHistoryProjection ? projection.loading : liveView.showBlockingLoading;
  const showBackgroundStatus = projection.isHistoryProjection ? false : liveView.showBackgroundStatus;
  const isEmptyState = projection.isHistoryProjection
    ? !projection.loading && chatRows.length === 0
    : liveView.isEmptyState;

  useChatFirstPaint({
    currentSessionKey: projectionScopeKey,
    rowCount: chatRows.length,
    isEmptyState,
    showBlockingLoading,
    rowSliceCostMs,
    sessionPipelineCostRef,
  });

  const { markScrollActivity } = useChatRealtimePerfMetrics({
    currentSessionKey: projectionScopeKey,
    sending: runtimeSending,
    streamingMessage: runtimeStreamingMessage,
    streamingTools: runtimeStreamingTools,
    runtimeRowsCostMs,
    chatRowRenderSignal: chatRows,
  });
  markScrollActivityRef.current = markScrollActivity;
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
    messagesViewportRef,
    messageContentRef,
    isEmptyState,
    showBlockingLoading,
    handleViewportPointerDown,
    handleViewportScroll,
    handleViewportTouchMove,
    handleViewportWheel,
    chatItems,
    hiddenHistoryCount,
    isHistoryProjection: projection.isHistoryProjection,
    onViewHistory: handleOpenHistoryProjection,
    showThinking,
    assistantAgentId: currentAgentId,
    assistantAgentName: currentAgent?.name || currentAgentId,
    assistantAvatarSeed: currentAgent?.avatarSeed,
    assistantAvatarStyle: currentAgent?.avatarStyle,
    userAvatarDataUrl,
    suppressedToolCardRowKeys,
    bodyRenderModeByRowKey,
    requestFullRender,
    scrollToRowKey,
    error: projection.error ?? error,
    clearError,
    waitingApproval: runtimeWaitingApproval,
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

  // Gateway not running
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
