import { useCallback, useMemo, type ComponentProps, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import type { ApprovalDecision, ApprovalItem } from '@/stores/chat';
import { ChatShell } from './components/ChatShell';
import { ChatInput } from './ChatInput';
import type { ChatRenderItem } from './chat-render-items';
import type { MarkdownBodyRenderMode } from './md-pipeline';

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type ChatInputShellProps = ComponentProps<typeof ChatInput>;

interface UseChatShellPropsInput {
  t: TranslateFn;
  chatLayoutRef: RefObject<HTMLDivElement | null>;
  taskInboxCollapsed: boolean;
  setTaskInboxCollapsed: Dispatch<SetStateAction<boolean>>;
  taskInboxWidth: number;
  taskInboxResizerWidth: number;
  startTaskInboxResize: ComponentProps<typeof ChatShell>['onTaskInboxResizeStart'];
  showBackgroundStatus: boolean;
  refreshing: boolean;
  hasCurrentAgent: boolean;
  openSkillConfigDialog: () => void;
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  messageContentRef: RefObject<HTMLDivElement | null>;
  isEmptyState: boolean;
  showBlockingLoading: boolean;
  handleViewportPointerDown: () => void;
  handleViewportScroll: () => void;
  handleViewportTouchMove: ComponentProps<typeof ChatShell>['listProps']['onTouchMove'];
  handleViewportWheel: ComponentProps<typeof ChatShell>['listProps']['onWheel'];
  chatItems: ChatRenderItem[];
  hiddenHistoryCount: number;
  isHistoryProjection: boolean;
  onViewHistory: () => void;
  showThinking: boolean;
  assistantAgentId: string;
  assistantAgentName: string;
  assistantAvatarSeed?: string;
  assistantAvatarStyle?: AgentAvatarStyle;
  userAvatarDataUrl: string | null;
  suppressedToolCardRowKeys: Set<string>;
  bodyRenderModeByRowKey: ReadonlyMap<string, MarkdownBodyRenderMode>;
  requestFullRender: (rowKey: string) => void;
  scrollToRowKey: (rowKey?: string) => void;
  error: string | null;
  clearError: () => void;
  waitingApproval: boolean;
  currentPendingApprovals: ApprovalItem[];
  resolveApproval: (id: string, decision: ApprovalDecision) => Promise<void>;
  sendMessage: ChatInputShellProps['onSend'];
  abortRun: ChatInputShellProps['onStop'];
  isGatewayRunning: boolean;
  sending: boolean;
  skillConfigOpen: boolean;
  currentAgentName: string;
  currentAgentId: string;
  availableSkillOptions: ComponentProps<typeof ChatShell>['skillDialogProps']['skillOptions'];
  skillConfigSkillsLoading: boolean;
  selectedSkillIds: string[];
  skillConfigSaving: boolean;
  toggleSkillConfigSelection: (skillId: string, checked: boolean) => void;
  closeSkillConfigDialog: () => void;
  saveSkillConfig: () => Promise<void>;
}

export function useChatShellProps(input: UseChatShellPropsInput): ComponentProps<typeof ChatShell> {
  const {
    t,
    chatLayoutRef,
    taskInboxCollapsed,
    setTaskInboxCollapsed,
    taskInboxWidth,
    taskInboxResizerWidth,
    startTaskInboxResize,
    showBackgroundStatus,
    refreshing,
    hasCurrentAgent,
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
    isHistoryProjection,
    onViewHistory,
    showThinking,
    assistantAgentId,
    assistantAgentName,
    assistantAvatarSeed,
    assistantAvatarStyle,
    userAvatarDataUrl,
    suppressedToolCardRowKeys,
    bodyRenderModeByRowKey,
    requestFullRender,
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
    currentAgentName,
    currentAgentId,
    availableSkillOptions,
    skillConfigSkillsLoading,
    selectedSkillIds,
    skillConfigSaving,
    toggleSkillConfigSelection,
    closeSkillConfigDialog,
    saveSkillConfig,
  } = input;

  const onToggleTaskInbox = useCallback(() => {
    setTaskInboxCollapsed((prev) => !prev);
  }, [setTaskInboxCollapsed]);

  const onResolveApproval = useCallback((id: string, decision: ApprovalDecision) => {
    void resolveApproval(id, decision);
  }, [resolveApproval]);

  const onSubmitSkillConfig = useCallback(() => {
    void saveSkillConfig();
  }, [saveSkillConfig]);

  const headerProps = useMemo<ComponentProps<typeof ChatShell>['headerProps']>(() => ({
    showBackgroundStatus,
    refreshing,
    hasCurrentAgent,
    onOpenSkillConfig: openSkillConfigDialog,
    skillConfigLabel: t('toolbar.skillConfig'),
    statusRefreshingLabel: t('status.refreshing'),
    statusMutatingLabel: t('status.mutating'),
  }), [
    showBackgroundStatus,
    refreshing,
    hasCurrentAgent,
    openSkillConfigDialog,
    t,
  ]);

  const listProps = useMemo<ComponentProps<typeof ChatShell>['listProps']>(() => ({
    messagesViewportRef,
    messageContentRef,
    isEmptyState,
    showBlockingLoading,
    onPointerDown: handleViewportPointerDown,
    onScroll: handleViewportScroll,
    onTouchMove: handleViewportTouchMove,
    onWheel: handleViewportWheel,
    items: chatItems,
    showHistoryEntry: !isHistoryProjection && hiddenHistoryCount > 0,
    onViewHistory,
    viewFullHistoryLabel: t('liveThread.viewFullHistory'),
    showThinking,
    assistantAgentId,
    assistantAgentName,
    assistantAvatarSeed,
    assistantAvatarStyle,
    userAvatarImageUrl: userAvatarDataUrl,
    suppressedToolCardRowKeys,
    bodyRenderModeByRowKey,
    onRequestFullRender: requestFullRender,
    onJumpToRowKey: scrollToRowKey,
  }), [
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
    isHistoryProjection,
    onViewHistory,
    t,
    showThinking,
    assistantAgentId,
    assistantAgentName,
    assistantAvatarSeed,
    assistantAvatarStyle,
    userAvatarDataUrl,
    suppressedToolCardRowKeys,
    bodyRenderModeByRowKey,
    requestFullRender,
    scrollToRowKey,
  ]);

  const errorBannerProps = useMemo<ComponentProps<typeof ChatShell>['errorBannerProps']>(() => (
    error ? {
      error,
      dismissLabel: t('common:actions.dismiss'),
      onDismiss: clearError,
    } : null
  ), [error, t, clearError]);

  const approvalDockProps = useMemo<ComponentProps<typeof ChatShell>['approvalDockProps']>(() => (
    waitingApproval && !isHistoryProjection ? {
      waitingLabel: t('approval.waitingLabel'),
      approvals: currentPendingApprovals,
      onResolve: onResolveApproval,
    } : null
  ), [isHistoryProjection, waitingApproval, t, currentPendingApprovals, onResolveApproval]);

  const inputProps = useMemo<ComponentProps<typeof ChatShell>['inputProps']>(() => ({
    layout: isEmptyState ? 'hero' : 'dock',
    onSend: sendMessage,
    onStop: abortRun,
    disabled: !isGatewayRunning,
    sending,
    approvalWaiting: waitingApproval,
  }), [isEmptyState, sendMessage, abortRun, isGatewayRunning, sending, waitingApproval]);

  const skillDialogProps = useMemo<ComponentProps<typeof ChatShell>['skillDialogProps']>(() => ({
    open: skillConfigOpen,
    title: t('skillConfigDialog.titleWithAgent', { agent: currentAgentName || currentAgentId }),
    skillOptions: availableSkillOptions,
    skillsLoading: skillConfigSkillsLoading,
    selectedSkillIds,
    submitting: skillConfigSaving,
    onToggleSkill: toggleSkillConfigSelection,
    onClose: closeSkillConfigDialog,
    onSubmit: onSubmitSkillConfig,
  }), [
    skillConfigOpen,
    t,
    currentAgentName,
    currentAgentId,
    availableSkillOptions,
    skillConfigSkillsLoading,
    selectedSkillIds,
    skillConfigSaving,
    toggleSkillConfigSelection,
    closeSkillConfigDialog,
    onSubmitSkillConfig,
  ]);

  return useMemo<ComponentProps<typeof ChatShell>>(() => ({
    chatLayoutRef,
    taskInboxCollapsed,
    taskInboxWidth,
    taskInboxResizerWidth,
    onTaskInboxResizeStart: startTaskInboxResize,
    onToggleTaskInbox,
    headerProps,
    listProps,
    errorBannerProps,
    approvalDockProps,
    inputProps,
    skillDialogProps,
  }), [
    chatLayoutRef,
    taskInboxCollapsed,
    taskInboxWidth,
    taskInboxResizerWidth,
    startTaskInboxResize,
    onToggleTaskInbox,
    headerProps,
    listProps,
    approvalDockProps,
    errorBannerProps,
    inputProps,
    skillDialogProps,
  ]);
}
