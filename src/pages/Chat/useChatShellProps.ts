import { useCallback, useMemo, type ComponentProps, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import type { ApprovalDecision, ApprovalItem } from '@/stores/chat';
import { ChatShell } from './components/ChatShell';
import { ChatInput } from './ChatInput';

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
  threadPanel: ReactNode;
  isEmptyState: boolean;
  error: string | null;
  clearError: () => void;
  waitingApproval: boolean;
  isHistoryProjection: boolean;
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
    threadPanel,
    isEmptyState,
    error,
    clearError,
    waitingApproval,
    isHistoryProjection,
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
    hasCurrentAgent,
    openSkillConfigDialog,
    refreshing,
    showBackgroundStatus,
    t,
  ]);

  const errorBannerProps = useMemo<ComponentProps<typeof ChatShell>['errorBannerProps']>(() => (
    error ? {
      error,
      dismissLabel: t('common:actions.dismiss'),
      onDismiss: clearError,
    } : null
  ), [clearError, error, t]);

  const approvalDockProps = useMemo<ComponentProps<typeof ChatShell>['approvalDockProps']>(() => (
    waitingApproval && !isHistoryProjection ? {
      waitingLabel: t('approval.waitingLabel'),
      approvals: currentPendingApprovals,
      onResolve: onResolveApproval,
    } : null
  ), [currentPendingApprovals, isHistoryProjection, onResolveApproval, t, waitingApproval]);

  const inputProps = useMemo<ComponentProps<typeof ChatShell>['inputProps']>(() => ({
    layout: isEmptyState ? 'hero' : 'dock',
    onSend: sendMessage,
    onStop: abortRun,
    disabled: !isGatewayRunning,
    sending,
    approvalWaiting: waitingApproval,
  }), [abortRun, isEmptyState, isGatewayRunning, sendMessage, sending, waitingApproval]);

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
    availableSkillOptions,
    closeSkillConfigDialog,
    currentAgentId,
    currentAgentName,
    onSubmitSkillConfig,
    selectedSkillIds,
    skillConfigOpen,
    skillConfigSaving,
    skillConfigSkillsLoading,
    t,
    toggleSkillConfigSelection,
  ]);

  return useMemo<ComponentProps<typeof ChatShell>>(() => ({
    chatLayoutRef,
    taskInboxCollapsed,
    taskInboxWidth,
    taskInboxResizerWidth,
    onTaskInboxResizeStart: startTaskInboxResize,
    onToggleTaskInbox,
    headerProps,
    threadPanel,
    errorBannerProps,
    approvalDockProps,
    inputProps,
    skillDialogProps,
  }), [
    approvalDockProps,
    chatLayoutRef,
    errorBannerProps,
    headerProps,
    inputProps,
    onToggleTaskInbox,
    skillDialogProps,
    startTaskInboxResize,
    taskInboxCollapsed,
    taskInboxResizerWidth,
    taskInboxWidth,
    threadPanel,
  ]);
}
