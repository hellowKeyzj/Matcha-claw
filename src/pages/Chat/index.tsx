/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. Session selector, thinking toggle, and refresh
 * are in the toolbar; messages render with markdown + streaming.
 */
import { useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { useSubagentsStore } from '@/stores/subagents';
import { useSettingsStore } from '@/stores/settings';
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
import type { ChatSessionRecord } from '@/stores/chat/types';

interface ChatProps {
  isActive?: boolean;
}

const EMPTY_APPROVALS: never[] = [];
const EMPTY_AGENTS: never[] = [];

function parseAgentIdFromSessionKey(sessionKey: string): string {
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? 'main';
}

function ChatHeaderBarSlot({
  hasCurrentAgent,
  onOpenSkillConfig,
  skillConfigLabel,
  statusRefreshingLabel,
  statusMutatingLabel,
}: {
  hasCurrentAgent: boolean;
  onOpenSkillConfig: () => void;
  skillConfigLabel: string;
  statusRefreshingLabel: string;
  statusMutatingLabel: string;
}) {
  const currentSessionKey = useChatStore((state) => state.currentSessionKey);
  const historyStatus = useChatStore((state) => state.loadedSessions[state.currentSessionKey]?.meta.historyStatus ?? 'idle');
  const rowCount = useChatStore((state) => state.loadedSessions[state.currentSessionKey]?.window.messages.length ?? 0);
  const sending = useChatStore((state) => state.loadedSessions[state.currentSessionKey]?.runtime.sending ?? false);
  const foregroundHistorySessionKey = useChatStore((state) => state.foregroundHistorySessionKey);
  const mutating = useChatStore((state) => state.mutating);

  const liveView = useChatView({
    currentSessionStatus: historyStatus,
    rowCount,
    sending,
    refreshing: foregroundHistorySessionKey === currentSessionKey,
    mutating,
  });

  return (
    <ChatHeaderBar
      showBackgroundStatus={liveView.showBackgroundStatus}
      refreshing={foregroundHistorySessionKey === currentSessionKey}
      hasCurrentAgent={hasCurrentAgent}
      onOpenSkillConfig={onOpenSkillConfig}
      skillConfigLabel={skillConfigLabel}
      statusRefreshingLabel={statusRefreshingLabel}
      statusMutatingLabel={statusMutatingLabel}
    />
  );
}

function ChatViewportPaneSlot({
  viewportPaneRef,
  isActive,
  agents,
  isGatewayRunning,
  gatewayRpc,
  userAvatarDataUrl,
  assistantAgentId,
  assistantAgentName,
  assistantAvatarSeed,
  assistantAvatarStyle,
  loadOlderLabel,
  jumpToLatestLabel,
  jumpToBottomLabel,
}: {
  viewportPaneRef: React.RefObject<ChatViewportPaneHandle | null>;
  isActive: boolean;
  agents: Array<{
    id: string;
    name?: string;
    avatarSeed?: string;
    avatarStyle?: React.ComponentProps<typeof ChatViewportPane>['assistantAvatarStyle'];
  }>;
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  userAvatarDataUrl: string | null;
  assistantAgentId: string;
  assistantAgentName: string;
  assistantAvatarSeed?: React.ComponentProps<typeof ChatViewportPane>['assistantAvatarSeed'];
  assistantAvatarStyle?: React.ComponentProps<typeof ChatViewportPane>['assistantAvatarStyle'];
  loadOlderLabel: string;
  jumpToLatestLabel: string;
  jumpToBottomLabel: string;
}) {
  const currentSessionKey = useChatStore((state) => state.currentSessionKey);
  const currentSession = useChatStore((state) => state.loadedSessions[state.currentSessionKey] as ChatSessionRecord);
  const error = useChatStore((state) => state.error);
  const showThinking = useChatStore((state) => state.showThinking);
  const loadOlderMessages = useChatStore((state) => state.loadOlderMessages);
  const trimTopMessages = useChatStore((state) => state.trimTopMessages);
  const jumpToLatest = useChatStore((state) => state.jumpToLatest);

  return (
    <ChatViewportPane
      ref={viewportPaneRef}
      isActive={isActive}
      currentSessionKey={currentSessionKey}
      currentSession={currentSession}
      agents={agents}
      isGatewayRunning={isGatewayRunning}
      gatewayRpc={gatewayRpc}
      errorMessage={error}
      showThinking={showThinking}
      userAvatarDataUrl={userAvatarDataUrl}
      assistantAgentId={assistantAgentId}
      assistantAgentName={assistantAgentName}
      assistantAvatarSeed={assistantAvatarSeed}
      assistantAvatarStyle={assistantAvatarStyle}
      onLoadOlder={() => {
        void loadOlderMessages(currentSessionKey).then(() => {
          trimTopMessages(currentSessionKey, 120);
        });
      }}
      loadOlderLabel={loadOlderLabel}
      onJumpToLatest={() => {
        void jumpToLatest(currentSessionKey);
      }}
      jumpToLatestLabel={jumpToLatestLabel}
      jumpToBottomLabel={jumpToBottomLabel}
    />
  );
}

function useChatRuntimeOverlays({
  dismissLabel,
  waitingLabel,
}: {
  dismissLabel: string;
  waitingLabel: string;
}) {
  const error = useChatStore((state) => state.error);
  const approvalStatus = useChatStore((state) => state.loadedSessions[state.currentSessionKey]?.runtime.approvalStatus ?? 'idle');
  const currentPendingApprovals = useChatStore((state) => state.pendingApprovalsBySession[state.currentSessionKey] ?? EMPTY_APPROVALS);
  const clearError = useChatStore((state) => state.clearError);
  const resolveApproval = useChatStore((state) => state.resolveApproval);

  return {
    errorBanner: error ? (
      <ChatErrorBanner
        error={error}
        dismissLabel={dismissLabel}
        onDismiss={clearError}
      />
    ) : null,
    approvalDock: approvalStatus === 'awaiting_approval' ? (
      <ChatApprovalDock
        waitingLabel={waitingLabel}
        approvals={currentPendingApprovals}
        onResolve={(id, decision) => {
          void resolveApproval(id, decision);
        }}
      />
    ) : null,
  };
}

function ChatInputSlot({
  viewportPaneRef,
}: {
  viewportPaneRef: React.RefObject<ChatViewportPaneHandle | null>;
}) {
  const currentSessionKey = useChatStore((state) => state.currentSessionKey);
  const isAtLatest = useChatStore((state) => state.loadedSessions[state.currentSessionKey]?.window.isAtLatest ?? true);
  const sending = useChatStore((state) => state.loadedSessions[state.currentSessionKey]?.runtime.sending ?? false);
  const approvalStatus = useChatStore((state) => state.loadedSessions[state.currentSessionKey]?.runtime.approvalStatus ?? 'idle');
  const jumpToLatest = useChatStore((state) => state.jumpToLatest);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const abortRun = useChatStore((state) => state.abortRun);

  const handleSendMessage = useCallback(async (
    text: string,
    attachments?: Parameters<typeof sendMessage>[1],
  ) => {
    if (!isAtLatest) {
      viewportPaneRef.current?.prepareCurrentLatestBottomAlign();
      await jumpToLatest(currentSessionKey);
    }
    await sendMessage(text, attachments);
  }, [currentSessionKey, isAtLatest, jumpToLatest, sendMessage, viewportPaneRef]);

  return (
    <ChatInput
      onSend={handleSendMessage}
      onStop={abortRun}
      disabled={false}
      sending={sending}
      approvalWaiting={approvalStatus === 'awaiting_approval'}
    />
  );
}

function ChatStagePanel({
  viewportPaneRef,
  isActive,
  agents,
  isGatewayRunning,
  gatewayRpc,
  userAvatarDataUrl,
  assistantAgentId,
  assistantAgentName,
  assistantAvatarSeed,
  assistantAvatarStyle,
  hasCurrentAgent,
  onOpenSkillConfig,
  skillConfigLabel,
  statusRefreshingLabel,
  statusMutatingLabel,
  dismissLabel,
  waitingLabel,
  loadOlderLabel,
  jumpToLatestLabel,
  jumpToBottomLabel,
}: {
  viewportPaneRef: React.RefObject<ChatViewportPaneHandle | null>;
  isActive: boolean;
  agents: Array<{
    id: string;
    name?: string;
    avatarSeed?: string;
    avatarStyle?: React.ComponentProps<typeof ChatViewportPane>['assistantAvatarStyle'];
  }>;
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  userAvatarDataUrl: string | null;
  assistantAgentId: string;
  assistantAgentName: string;
  assistantAvatarSeed?: React.ComponentProps<typeof ChatViewportPane>['assistantAvatarSeed'];
  assistantAvatarStyle?: React.ComponentProps<typeof ChatViewportPane>['assistantAvatarStyle'];
  hasCurrentAgent: boolean;
  onOpenSkillConfig: () => void;
  skillConfigLabel: string;
  statusRefreshingLabel: string;
  statusMutatingLabel: string;
  dismissLabel: string;
  waitingLabel: string;
  loadOlderLabel: string;
  jumpToLatestLabel: string;
  jumpToBottomLabel: string;
}) {
  const overlays = useChatRuntimeOverlays({
    dismissLabel,
    waitingLabel,
  });

  return (
    <ChatViewportStage
      header={(
        <ChatHeaderBarSlot
          hasCurrentAgent={hasCurrentAgent}
          onOpenSkillConfig={onOpenSkillConfig}
          skillConfigLabel={skillConfigLabel}
          statusRefreshingLabel={statusRefreshingLabel}
          statusMutatingLabel={statusMutatingLabel}
        />
      )}
      viewportPane={(
        <ChatViewportPaneSlot
          viewportPaneRef={viewportPaneRef}
          isActive={isActive}
          agents={agents}
          isGatewayRunning={isGatewayRunning}
          gatewayRpc={gatewayRpc}
          userAvatarDataUrl={userAvatarDataUrl}
          assistantAgentId={assistantAgentId}
          assistantAgentName={assistantAgentName}
          assistantAvatarSeed={assistantAvatarSeed}
          assistantAvatarStyle={assistantAvatarStyle}
          loadOlderLabel={loadOlderLabel}
          jumpToLatestLabel={jumpToLatestLabel}
          jumpToBottomLabel={jumpToBottomLabel}
        />
      )}
      errorBanner={overlays.errorBanner}
      approvalDock={overlays.approvalDock}
      input={(
        <ChatInputSlot viewportPaneRef={viewportPaneRef} />
      )}
    />
  );
}

export function Chat({ isActive = true }: ChatProps) {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const navigate = useNavigate();
  const gatewayStatus = useGatewayStore((state) => state.status);
  const gatewayRpc = useGatewayStore((state) => state.rpc);
  const isGatewayRunning = gatewayStatus.state === 'running';
  const switchSession = useChatStore((state) => state.switchSession);
  const openAgentConversation = useChatStore((state) => state.openAgentConversation);
  const loadHistory = useChatStore((state) => state.loadHistory);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const cleanupEmptySession = useChatStore((state) => state.cleanupEmptySession);
  const currentSessionKey = useChatStore((state) => state.currentSessionKey);
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
        taskInboxCollapsed={taskInboxCollapsed}
        taskInboxWidth={taskInboxWidth}
        taskInboxResizerWidth={taskInboxResizerWidth}
        onTaskInboxResizeStart={startTaskInboxResize}
        onToggleTaskInbox={() => {
          setTaskInboxCollapsed((prev) => !prev);
        }}
        stagePanel={(
          <ChatStagePanel
            viewportPaneRef={viewportPaneRef}
            isActive={activation.workspaceActive}
            agents={agents}
            isGatewayRunning={isGatewayRunning}
            gatewayRpc={gatewayRpc}
            userAvatarDataUrl={userAvatarDataUrl}
            assistantAgentId={currentAgentId}
            assistantAgentName={currentAgent?.name || currentAgentId}
            assistantAvatarSeed={currentAgent?.avatarSeed}
            assistantAvatarStyle={currentAgent?.avatarStyle}
            hasCurrentAgent={Boolean(currentAgent)}
            onOpenSkillConfig={openSkillConfigDialog}
            skillConfigLabel={t('toolbar.skillConfig')}
            statusRefreshingLabel={t('status.refreshing')}
            statusMutatingLabel={t('status.mutating')}
            dismissLabel={t('common:actions.dismiss')}
            waitingLabel={t('approval.waitingLabel')}
            loadOlderLabel={t('liveThread.loadOlder')}
            jumpToLatestLabel={t('liveThread.jumpToLatest')}
            jumpToBottomLabel={t('liveThread.jumpToBottom')}
          />
        )}
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
