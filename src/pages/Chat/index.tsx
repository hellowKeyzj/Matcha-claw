/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. Session selector, thinking toggle, and refresh
 * are in the toolbar; messages render with markdown + streaming.
 */
import { useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChatShell } from './components/ChatShell';
import { ChatOffline } from './components/ChatOffline';
import { useInboxLayout } from './useInboxLayout';
import { useChatRealtimePerfMetrics } from './useChatPerf';
import { useChatFirstPaint } from './useFirstPaint';
import { useRowsPipeline } from './useRowsPipeline';
import { useChatInit } from './useChatInit';
import { useSkillConfig } from './useSkillConfig';
import { useChatView } from './useChatView';
import { useChatPageModel } from './useChatPageModel';
import { useChatListCtl } from './useChatListCtl';
import { useChatShellProps } from './useChatShellProps';

export function Chat() {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const navigate = useNavigate();
  const {
    isGatewayRunning,
    gatewayRpc,
    messages,
    initialLoading,
    refreshing,
    mutating,
    sending,
    error,
    showThinking,
    streamingMessage,
    streamingTools,
    pendingFinal,
    lastUserMessageAt,
    currentPendingApprovals,
    resolveApproval,
    loadHistory,
    loadSessions,
    switchSession,
    openAgentConversation,
    currentSessionKey,
    currentSessionReady,
    currentSessionHasActivity,
    sendMessage,
    abortRun,
    clearError,
    cleanupEmptySession,
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
    assistantAvatarEmoji,
    waitingApproval,
  } = useChatPageModel();

  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const chatLayoutRef = useRef<HTMLDivElement>(null);
  const streamingTimestamp = lastUserMessageAt != null ? (lastUserMessageAt / 1000) : 0;
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
    chatRows,
    suppressedToolCardRowKeys,
    rowSliceCostMs,
    runtimeRowsCostMs,
    hasOlderRenderableRows,
    increaseRenderableWindowLimit,
  } = useRowsPipeline({
    currentSessionKey,
    messages,
    agents,
    isGatewayRunning,
    gatewayRpc,
    sending,
    pendingFinal,
    waitingApproval,
    showThinking,
    streamingMessage,
    streamingTools,
    streamingTimestamp,
    sessionPipelineCostRef,
  });

  const { showBlockingLoading, showBackgroundStatus, isEmptyState } = useChatView({
    currentSessionKey,
    currentSessionReady,
    currentSessionHasActivity,
    rowCount: chatRows.length,
    sending,
    initialLoading,
    refreshing,
    mutating,
  });

  useChatFirstPaint({
    currentSessionKey,
    rowCount: chatRows.length,
    isEmptyState,
    showBlockingLoading,
    rowSliceCostMs,
    sessionPipelineCostRef,
  });

  const { markScrollActivity } = useChatRealtimePerfMetrics({
    currentSessionKey,
    sending,
    streamingMessage,
    streamingTools,
    runtimeRowsCostMs,
    chatRowRenderSignal: chatRows,
  });

  const {
    handleViewportPointerDown,
    handleViewportTouchMove,
    handleViewportWheel,
    handleViewportScrollWithWindowing,
    messageVirtualizer,
    virtualMessageItems,
    scrollToRowKey,
  } = useChatListCtl({
    currentSessionKey,
    chatRows,
    hasOlderRenderableRows,
    messagesViewportRef,
    messageContentRef,
    markScrollActivity,
    increaseRenderableWindowLimit,
  });
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
    handleViewportScrollWithWindowing,
    handleViewportTouchMove,
    handleViewportWheel,
    messageVirtualizer,
    virtualMessageItems,
    chatRows,
    showThinking,
    assistantAvatarEmoji,
    userAvatarDataUrl,
    suppressedToolCardRowKeys,
    scrollToRowKey,
    error,
    clearError,
    waitingApproval,
    currentPendingApprovals,
    resolveApproval,
    sendMessage,
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

