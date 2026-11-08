import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type ApprovalItem, type ChatSessionRuntimeState } from '@/plugins/chat/store';
import { buildPendingUserMessageItem, createSessionPending } from '@/plugins/chat/store/session-presentation';
import { useContributions } from '@/plugin-host/react';
import { messageContextTags } from '@/plugins/message-rendering/extensions';
import { ABORT_STOPPING_TIMEOUT_ERROR, ABORT_UNKNOWN_ERROR, ABORT_REJECTED_ERROR, ABORT_REQUEST_FAILED_ERROR } from '@/plugins/chat/store/abort-handlers';
import { isRunActive } from '@/plugins/chat/store/types';
import { getPendingApprovals, getSessionApprovalStatus, getSessionProjectionWatermark, projectSessionViewItems } from '@/plugins/chat/store/store-state-helpers';
import { hasVisibleRuntimeError } from '@/plugins/chat/store/runtime-error-view';
import { resolveSessionOperationTarget } from '@/plugins/chat/store/session-identity';
import { useGatewayStore } from '@/plugins/runtime/store';
import { useSettingsStore } from '@/plugins/settings/store';
import { useComposerDraftStore } from '@/plugins/chat/composer-drafts';
import type { GatewayTransportIssue } from '@/types/session/runtime-state';
import { runtimeEndpointsEqual, sessionIdentitiesEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionRenderItem, SessionRenderUserMessageItem } from '@/types/session/render-item';
import type { SessionWindowStateSnapshot } from '@/types/session/snapshot';
import { isGatewayOperational } from '@/plugins/runtime/gateway-status';
import { hostSessionWindowFetch } from '@/lib/host-api';
import { toast } from 'sonner';
import { logSessionTrace, summarizeIdentifier, summarizeSessionIdentity, isSessionTraceEnabled, summarizeRenderItems } from '@/lib/session-trace';
import { decodeHistorySessionView, resolveSessionViewError, sessionViewWindow } from '@/plugins/chat/store/history-fetch-helpers';
import { TRANSIENT_RUNTIME_ERROR_BANNER_DELAY_MS, shouldShowRuntimeErrorBannerImmediately } from '@/plugins/chat/runtime-error-banner';
import { AssistantPendingLabelProvider } from '@/plugins/chat/components/AssistantPendingIndicator';
import { ChatList, type ChatListHandle } from '@/plugins/chat/components/ChatList';
import type { ChatHeaderBar } from '@/plugins/chat/components/ChatHeaderBar';
import { ChatApprovalDock, ChatErrorBanner, ChatRuntimeStatusDock } from '@/plugins/chat/components/ChatRuntimeDock';
import { SessionTodoPanel } from '@/plugins/chat/components/SessionTodoPanel';
import { WelcomeScreen } from '@/plugins/chat/components/ChatStates';
import type { ChatInputHandle } from '@/plugins/chat/ChatInput';
import { useChatView } from '@/plugins/chat/useChatView';
import { useChatQuestions } from '@/plugins/chat/useChatQuestions';
import { useSessionQuestions } from '@/plugins/chat/useSessionQuestions';
import { SessionQuestionDock } from '@/plugins/chat/components/SessionQuestionDock';
import { ChatQuestionDock } from '@/plugins/chat/components/ChatQuestionDock';
import { applyAssistantPresentationToItems } from '@/plugins/chat/render-item-projection';
import type { ChatAssistantCatalogAgent, ChatAssistantPresentation, ChatRenderItem } from '@/plugins/message-rendering/chat-render-item-model';
import { buildChatSessionMarkdownExport, downloadMarkdownFile } from '@/plugins/chat/session-markdown-export';
import { ChatArtifacts, type ChatArtifactSlots, type ChatArtifactViewportContent } from '@/plugins/chat/ChatArtifacts';
import { selectChatSelection, selectChatSession, useChatAgent, useChatRuntime } from '@/plugins/chat/chat-session';

const EMPTY_APPROVAL_ITEMS: ApprovalItem[] = [];
const CHAT_MARKDOWN_EXPORT_WINDOW_LIMIT = 200;
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
    case 'session.runtime.unknown':
      return t('errors.runOutcomeUnknown');
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
function buildRunProgressPendingLabel(
  runProgress: ChatSessionRuntimeState['runProgress'],
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  return runProgress?.kind === 'retrying' ? t('pending.retrying', {
    attempt: runProgress.attempt,
    maxAttempts: runProgress.maxAttempts,
  }) : null;
}

async function fetchChatMarkdownExportWindow(input: {
  endpointSessionId?: string;
  sessionIdentity: SessionIdentity;
  mode: 'latest' | 'older';
  offset?: number;
}): Promise<{ view: ReturnType<typeof decodeHistorySessionView>; items: SessionRenderItem[] }> {
  try {
    const view = decodeHistorySessionView(await hostSessionWindowFetch({
      ...(input.endpointSessionId ? { endpointSessionId: input.endpointSessionId } : {}),
      sessionIdentity: input.sessionIdentity,
      mode: input.mode,
      limit: CHAT_MARKDOWN_EXPORT_WINDOW_LIMIT,
      ...(input.mode === 'older' ? { offset: input.offset } : {}),
      includeCanonical: true,
    }));
    return { view, items: projectSessionViewItems(view) };
  } catch (error) {
    throw resolveSessionViewError(error);
  }
}

function collectSessionWindowItems(input: {
  itemsByOffset: Map<number, SessionRenderItem>;
  window: SessionWindowStateSnapshot;
  items: ReadonlyArray<SessionRenderItem>;
}): void {
  input.items.forEach((item, index) => {
    input.itemsByOffset.set(input.window.windowStartOffset + index, item);
  });
}

async function fetchChatMarkdownExportItems(input: {
  endpointSessionId?: string;
  sessionIdentity: SessionIdentity;
  currentItems: ReadonlyArray<SessionRenderItem>;
  currentWindow: SessionWindowStateSnapshot;
}): Promise<SessionRenderItem[]> {
  if (
    input.currentWindow.totalItemCount === 0
    || (
      input.currentWindow.windowStartOffset === 0
      && input.currentWindow.windowEndOffset >= input.currentWindow.totalItemCount
    )
  ) {
    return [...input.currentItems];
  }

  const itemsByOffset = new Map<number, SessionRenderItem>();
  const latestWindow = await fetchChatMarkdownExportWindow({
    ...(input.endpointSessionId ? { endpointSessionId: input.endpointSessionId } : {}),
    sessionIdentity: input.sessionIdentity,
    mode: 'latest',
  });

  const latestWindowState = sessionViewWindow(latestWindow.view);
  collectSessionWindowItems({
    itemsByOffset,
    window: latestWindowState,
    items: latestWindow.items,
  });

  let nextOffset = latestWindowState.windowStartOffset;
  while (nextOffset > 0) {
    const previousOffset = nextOffset;
    const olderWindow = await fetchChatMarkdownExportWindow({
      ...(input.endpointSessionId ? { endpointSessionId: input.endpointSessionId } : {}),
      sessionIdentity: input.sessionIdentity,
      mode: 'older',
      offset: nextOffset,
    });
    const olderWindowState = sessionViewWindow(olderWindow.view);
    collectSessionWindowItems({
      itemsByOffset,
      window: olderWindowState,
      items: olderWindow.items,
    });
    nextOffset = olderWindowState.windowStartOffset;
    if (nextOffset >= previousOffset) {
      break;
    }
  }

  if (itemsByOffset.size === 0) {
    return [...input.currentItems];
  }
  return [...itemsByOffset.entries()]
    .sort(([leftOffset], [rightOffset]) => leftOffset - rightOffset)
    .map(([, item]) => item);
}

export interface ChatMessageSlots extends ChatArtifactSlots {
  headerProps: Omit<ComponentProps<typeof ChatHeaderBar>, 'sidePanelOpen' | 'onToggleSidePanel'>;
  input: ReactNode;
  emptyState: ReactNode;
  isEmptyState: boolean;
}

export const ChatMessages = memo(function ChatMessages({ isActive, renderInput, composerRef, viewportPaneRef, onRuntimeSendMessage, onRuntimeOpenLink, children }: {
  isActive: boolean;
  renderInput: (topContent: ReactNode) => ReactNode;
  composerRef: RefObject<ChatInputHandle | null>;
  viewportPaneRef: RefObject<ChatListHandle | null>;
  onRuntimeSendMessage: (text: string) => Promise<void>;
  onRuntimeOpenLink: (url: string) => Promise<void>;
  children: (slots: ChatMessageSlots) => ReactNode;
}) {
  const { t } = useTranslation('chat');
  const contextTags = useContributions(messageContextTags);
  const { currentConversation, currentSessionRecordKey, currentComposerDraftKey, currentWorkspaceIdentity, currentWorkspaceDraftId, connectorSessionIdentity, currentAgentId } = useChatStore(useShallow(selectChatSelection));
  const currentSession = useChatStore(selectChatSession);
  const currentSessionConversation = currentConversation?.kind === 'session' ? currentConversation : null;
  const currentConversationEndpoint = currentConversation?.endpoint ?? null;
  const { agents, managementScope, currentAgent } = useChatAgent();
  const { runtime: currentConversationRuntime } = useChatRuntime();
  const currentChatRuntimeAvailable = currentConversationRuntime.state === 'ready';
  const workspaceActive = isActive;
  const gatewayStatus = useGatewayStore((state) => state.status);
  const questionRecoveryKey = useGatewayStore((state) => `${state.status.connectedAt ?? ''}:${state.runtimeHost.restartCount}`);
  const isGatewayRunning = isGatewayOperational(gatewayStatus);
  const directoryRevision = useChatStore((state) => String(state.sessionRuntimeCatalog.directoryRevision));
  const dismissedRuntimeError = useChatStore((state) => currentSessionRecordKey ? state.dismissedRuntimeErrorBySession[currentSessionRecordKey] : undefined);
  const approvalStatus = useChatStore((state) => currentSessionRecordKey ? getSessionApprovalStatus(state, currentSessionRecordKey) : 'idle');
  const currentPendingApprovals = useChatStore((state) => currentSessionRecordKey ? getPendingApprovals(state, currentSessionRecordKey) ?? EMPTY_APPROVAL_ITEMS : EMPTY_APPROVAL_ITEMS);
  const { showThinking, toggleThinking, loadOlderViewportItems, jumpViewportToLatest, clearError, resolveApproval } = useChatStore(useShallow((state) => ({
    showThinking: state.showThinking, toggleThinking: state.toggleThinking, loadOlderViewportItems: state.loadOlderViewportItems,
    jumpViewportToLatest: state.jumpViewportToLatest, clearError: state.clearError, resolveApproval: state.resolveApproval,
  })));
  const userAvatarDataUrl = useSettingsStore((state) => state.userAvatarDataUrl);
  const composerInitialization = useComposerDraftStore((state) => currentComposerDraftKey ? state.initializations[currentComposerDraftKey] : undefined);
  const composerSubmission = useComposerDraftStore((state) => currentComposerDraftKey ? state.submissions[currentComposerDraftKey] : undefined);
  const [dismissedComposerInitialization, setDismissedComposerInitialization] = useState<typeof composerInitialization>();
  const composerConfigurationError = composerInitialization === dismissedComposerInitialization ? null
    : composerInitialization?.kind === 'createRejected' ? t('input.configurationCreateRejected')
      : composerInitialization?.kind === 'createUnknown' ? t('input.configurationCreateUnknown')
        : composerInitialization?.kind === 'pending' && composerInitialization.outcome
          ? t(`input.configurationOutcome.${composerInitialization.outcome}`) : null;
  const [visibleRuntimeError, setVisibleRuntimeError] = useState<string | null>(null);
  const [exportingMarkdown, setExportingMarkdown] = useState(false);
  const previousRenderedItemsRef = useRef<ChatRenderItem[] | null>(null);
  const localizedGatewayIssue = useMemo(() => localizeGatewayIssue(gatewayStatus.lastIssue, t) ?? gatewayStatus.lastError ?? null, [gatewayStatus.lastError, gatewayStatus.lastIssue, t]);
  const chatQuestions = useChatQuestions(
    currentWorkspaceIdentity,
    workspaceActive,
    currentChatRuntimeAvailable && isGatewayRunning,
    questionRecoveryKey,
  );
  const sessionQuestions = useSessionQuestions(
    currentWorkspaceIdentity,
    currentSession.meta.endpointSessionId,
    workspaceActive,
    currentChatRuntimeAvailable,
    directoryRevision,
  );
  const viewportItems = currentSession.items;
  const submissionItem = useMemo<SessionRenderUserMessageItem | null>(() => {
    if (!composerSubmission || !currentSession.window.isAtLatest
      || currentConversation?.kind === 'draft' && composerSubmission.draftId !== currentConversation.id
      || composerSubmission.status !== 'submitting' && !(currentWorkspaceDraftId && composerSubmission.draftId === currentWorkspaceDraftId
        && (composerSubmission.status === 'failed' || composerSubmission.status === 'unknown'))
      || viewportItems.some((item) => item.key === `renderer-user:${composerSubmission.operationId}`)) return null;
    const item = buildPendingUserMessageItem({
      clientId: composerSubmission.operationId,
      sessionKey: currentSessionRecordKey,
      text: composerSubmission.message,
      createdAt: composerSubmission.createdAt,
      attachments: composerSubmission.attachments,
    });
    return composerSubmission.status === 'submitting' ? item : { ...item, status: undefined };
  }, [composerSubmission, currentConversation, currentSession.window.isAtLatest, currentSessionRecordKey, currentWorkspaceDraftId, viewportItems]);
  const scrollScopeKey = currentWorkspaceDraftId ? `composer-draft:${currentWorkspaceDraftId}` : currentSessionRecordKey;
  const liveView = useChatView({
    currentSessionKey: currentSessionRecordKey,
    currentSessionStatus: currentSession.meta.historyStatus,
    itemCount: viewportItems.length + (submissionItem ? 1 : 0),
    runActive: isRunActive(currentSession.runtime),
  });
  const assistantCatalogAgents = useMemo<ChatAssistantCatalogAgent[]>(
    () => managementScope && currentConversationEndpoint && runtimeEndpointsEqual(managementScope.endpoint, currentConversationEndpoint)
      ? agents.map((agent) => ({
          id: agent.id,
          agentName: agent.name,
          avatarSeed: agent.avatarSeed,
          avatarStyle: agent.avatarStyle,
        })) : [],
    [agents, currentConversationEndpoint, managementScope],
  );
  const assistantPresentation = useMemo<ChatAssistantPresentation>(() => ({
    agentId: currentAgentId,
    agentName: currentAgent?.name || currentAgentId,
    avatarSeed: currentAgent?.avatarSeed,
    avatarStyle: currentAgent?.avatarStyle,
  }), [currentAgent?.avatarSeed, currentAgent?.avatarStyle, currentAgent?.name, currentAgentId]);
  const pendingRunProgressLabel = buildRunProgressPendingLabel(currentSession.runtime.runProgress, t);
  const sessionPending = useMemo(() => createSessionPending(currentSession, currentSessionRecordKey), [currentSession, currentSessionRecordKey]);
  const renderItems = useMemo(() => {
    const runtimePlaceholder = sessionPending?.kind === 'assistant' ? {
      ...sessionPending.item,
      pendingLabel: pendingRunProgressLabel,
    } : null;
    const protocolItems = [...viewportItems];
    if (submissionItem) protocolItems.push(submissionItem);
    if (runtimePlaceholder) protocolItems.push(runtimePlaceholder);
    const nextItems = applyAssistantPresentationToItems({
      items: protocolItems,
      agents: assistantCatalogAgents,
      defaultAssistant: assistantPresentation,
      previousItems: previousRenderedItemsRef.current ?? undefined,
    });
    previousRenderedItemsRef.current = nextItems;
    return nextItems;
  }, [assistantCatalogAgents, assistantPresentation, pendingRunProgressLabel, sessionPending, submissionItem, viewportItems]);
  const presentationWatermark = isSessionTraceEnabled() && currentSession.meta.sessionIdentity
    ? getSessionProjectionWatermark(useChatStore.getState, currentSession.meta.sessionIdentity) : null;
  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    logSessionTrace('session.presentation.committed', 'session-presentation-boundary', () => {
      const viewportKeys = new Set(viewportItems.map((item) => item.key));
      return {
        identity: summarizeSessionIdentity(connectorSessionIdentity), recordKey: summarizeIdentifier(currentSessionRecordKey),
        projectionWatermark: presentationWatermark, // epoch:public seq:public cursor captured by this render, not a later store read.
        boundary: 'react-passive-effect-after-commit', // Not a compositor/physical presentation acknowledgement.
        runtimePhase: currentSession.runtime.runPhase, activeRunHash: summarizeIdentifier(currentSession.runtime.activeRunId).hash,
        pendingTurnHash: summarizeIdentifier(currentSession.runtime.pendingTurnKey).hash,
        viewport: summarizeRenderItems(viewportItems), presentation: summarizeRenderItems(renderItems),
        placeholderHashes: renderItems.slice(0, 200).filter((item) => !viewportKeys.has(item.key))
          .map((item) => summarizeIdentifier(item.key).hash),
        placeholderCount: renderItems.length - viewportItems.length,
      };
    });
  }, [connectorSessionIdentity, currentSession.runtime, currentSessionRecordKey, presentationWatermark, renderItems, viewportItems]);
  const localizedRuntimeError = useMemo(() => {
    const hasRuntimeError = hasVisibleRuntimeError({
      runtime: currentSession.runtime,
      dismissedMarker: dismissedRuntimeError,
    });
    const localizedRuntimeIssue = hasRuntimeError
      ? localizeGatewayIssue(currentSession.runtime.lastIssue ?? undefined, t)
      : null;
    const runtimeMessage = hasRuntimeError
      ? (localizedRuntimeIssue ?? currentSession.runtime.lastError)
      : null;
    const currentRuntimeAdapterId = currentSession.meta.sessionIdentity?.endpoint.kind === 'native-runtime'
      ? currentSession.meta.sessionIdentity.endpoint.runtimeAdapterId
      : null;
    const fallbackGatewayRuntimeError = (
      localizedGatewayIssue
      && currentRuntimeAdapterId === 'openclaw'
      && (
        isRunActive(currentSession.runtime)
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
    if (effectiveRuntimeError === ABORT_STOPPING_TIMEOUT_ERROR) {
      return t('errors.abortStoppingTimeout');
    }
    if (effectiveRuntimeError === ABORT_UNKNOWN_ERROR) {
      return t('errors.abortUnknown');
    }
    if (effectiveRuntimeError === ABORT_REJECTED_ERROR) {
      return t('errors.abortRejected');
    }
    if (effectiveRuntimeError === ABORT_REQUEST_FAILED_ERROR) {
      return t('errors.abortRequestFailed');
    }
    return effectiveRuntimeError;
  }, [currentSession.meta.sessionIdentity, currentSession.runtime, dismissedRuntimeError, localizedGatewayIssue, t]);
  useEffect(() => {
    if (!localizedRuntimeError) {
      setVisibleRuntimeError(null);
      return;
    }

    if (shouldShowRuntimeErrorBannerImmediately({
      runtime: currentSession.runtime,
      gatewayIssue: gatewayStatus.lastIssue,
      message: localizedRuntimeError,
    })) {
      setVisibleRuntimeError(localizedRuntimeError);
      return;
    }

    const timeout = window.setTimeout(() => {
      setVisibleRuntimeError(localizedRuntimeError);
    }, TRANSIENT_RUNTIME_ERROR_BANNER_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [currentSession.runtime, gatewayStatus.lastIssue, localizedRuntimeError]);
  const bannerError = composerConfigurationError ?? visibleRuntimeError;
  const topContent = useMemo(() => {
    const notice = bannerError ? <ChatErrorBanner
      error={bannerError}
      dismissLabel={t('common:actions.dismiss')}
      onDismiss={composerConfigurationError
        ? () => setDismissedComposerInitialization(composerInitialization)
        : clearError}
    /> : currentSession.runtime.runtimeActivity === 'compacting' || currentSession.runtime.errorDetail || currentSession.runtime.runtimeNotice ? <ChatRuntimeStatusDock
      compacting={currentSession.runtime.runtimeActivity === 'compacting'}
      errorDetail={currentSession.runtime.errorDetail}
      runtimeNotice={currentSession.runtime.runtimeNotice}
    /> : null;
    const awaitingApproval = approvalStatus === 'awaiting_approval';
    const hasChatQuestion = chatQuestions.questions.length > 0 || !!chatQuestions.error;
    const hasSessionQuestion = sessionQuestions.questions.length > 0 || !!sessionQuestions.error;
    if (!notice && !awaitingApproval && !hasChatQuestion && !hasSessionQuestion) return null;
    return <>
      {notice ? <div className="max-h-[min(20vh,8rem)] shrink-0 overflow-y-auto empty:hidden" data-chat-composer-wheel-local="true">{notice}</div> : null}
      {awaitingApproval ? <ChatApprovalDock
        waitingLabel={t('approval.waitingLabel')}
        approvals={currentPendingApprovals}
        onResolve={(approval, decision) => { void resolveApproval(approval, decision); }}
      /> : null}
      {hasChatQuestion ? <ChatQuestionDock key={chatQuestions.scopeKey} questions={chatQuestions.questions} confirmed={chatQuestions.confirmed}
        error={chatQuestions.error} submittingId={chatQuestions.submittingId} onRefresh={chatQuestions.refresh} onResolve={chatQuestions.resolve} /> : null}
      {hasSessionQuestion ? <SessionQuestionDock key={sessionQuestions.scopeKey} questions={sessionQuestions.questions} confirmed={sessionQuestions.confirmed}
        error={sessionQuestions.error} submittingId={sessionQuestions.submittingId} onRefresh={sessionQuestions.refresh} onRespond={sessionQuestions.respond} /> : null}
    </>;
  }, [bannerError, composerConfigurationError, composerInitialization, clearError, t,
    currentSession.runtime.runtimeActivity, currentSession.runtime.errorDetail, currentSession.runtime.runtimeNotice,
    approvalStatus, currentPendingApprovals, resolveApproval,
    chatQuestions.questions, chatQuestions.confirmed, chatQuestions.error, chatQuestions.scopeKey, chatQuestions.submittingId, chatQuestions.refresh, chatQuestions.resolve,
    sessionQuestions.questions, sessionQuestions.confirmed, sessionQuestions.error, sessionQuestions.scopeKey, sessionQuestions.submittingId, sessionQuestions.refresh, sessionQuestions.respond]);
  const input = useMemo(() => renderInput(topContent), [renderInput, topContent]);
  const handleExportMarkdown = useCallback(() => {
    if (exportingMarkdown || !currentSessionRecordKey || !currentSessionConversation) {
      return;
    }
    setExportingMarkdown(true);
    void (async () => {
      try {
        const target = resolveSessionOperationTarget(useChatStore.getState(), currentSessionRecordKey);
        const protocolItems = await fetchChatMarkdownExportItems({
          ...(target.endpointSessionId ? { endpointSessionId: target.endpointSessionId } : {}),
          sessionIdentity: target.sessionIdentity,
          currentItems: viewportItems,
          currentWindow: currentSession.window,
        });
        const items = applyAssistantPresentationToItems({
          items: [...protocolItems],
          agents: assistantCatalogAgents,
          defaultAssistant: {
            agentId: currentAgentId,
            agentName: currentAgent?.name || currentAgentId,
            avatarSeed: currentAgent?.avatarSeed,
            avatarStyle: currentAgent?.avatarStyle,
          },
        });
        const exportedSession = buildChatSessionMarkdownExport({
          title: currentSession.meta.displayName || currentSession.meta.label || currentAgent?.name || currentSessionRecordKey,
          sessionKey: currentSessionConversation.sessionIdentity.sessionKey || currentSessionRecordKey,
          agentName: currentAgent?.name || currentAgentId,
          items,
          contextTags,
          exportedAt: new Date(),
        });
        downloadMarkdownFile(exportedSession.fileName, exportedSession.markdown);
      } catch (error) {
        toast.error(t('errors.exportMarkdownFailed', { error: error instanceof Error ? error.message : String(error) }));
      } finally {
        setExportingMarkdown(false);
      }
    })();
  }, [assistantCatalogAgents, contextTags, currentAgent?.avatarSeed, currentAgent?.avatarStyle, currentAgent?.name, currentAgentId, currentSession.meta.displayName, currentSession.meta.label, currentSession.window, currentSessionConversation, currentSessionRecordKey, exportingMarkdown, t, viewportItems]);
  // Export the latest committed message/window snapshot without invalidating the header on every tool delta.
  const exportMarkdownHandlerRef = useRef(handleExportMarkdown);
  useLayoutEffect(() => { exportMarkdownHandlerRef.current = handleExportMarkdown; }, [handleExportMarkdown]);
  const exportMarkdown = useCallback(() => exportMarkdownHandlerRef.current(), []);
  const handleReuseMessage = useCallback((text: string) => { composerRef.current?.replaceText(text); }, [composerRef]);
  const runtimeActionsMatchRenderedSession = !!currentWorkspaceIdentity && !!currentSession.meta.sessionIdentity
    && sessionIdentitiesEqual(currentWorkspaceIdentity, currentSession.meta.sessionIdentity);
  const headerProps = useMemo(() => ({
    showThinking,
    onToggleThinking: toggleThinking,
    exportDisabled: exportingMarkdown || !currentSessionRecordKey,
    onExportMarkdown: exportMarkdown,
    todoPanel: <SessionTodoPanel sessionKey={currentSessionRecordKey} />,
  }), [currentSessionRecordKey, exportMarkdown, exportingMarkdown, showThinking, toggleThinking]);
  const handleLoadOlder = useCallback(() => { if (currentSessionRecordKey) void loadOlderViewportItems(currentSessionRecordKey); }, [currentSessionRecordKey, loadOlderViewportItems]);
  const handleJumpToLatest = useCallback(() => { if (currentSessionRecordKey) void jumpViewportToLatest(currentSessionRecordKey); }, [currentSessionRecordKey, jumpViewportToLatest]);
  const renderViewport = useCallback((artifacts: ChatArtifactViewportContent) => <ChatList
    ref={viewportPaneRef}
    isActive={workspaceActive}
    currentSessionKey={currentSessionRecordKey}
    scrollScopeKey={scrollScopeKey}
    runtime={currentSession.runtime}
    viewport={currentSession.window}
    items={renderItems}
    runTimings={currentSession.runTimings}
    activeRunId={isRunActive(currentSession.runtime) ? currentSession.runtime.activeRunId : null}
    activity={sessionPending?.kind === 'activity' ? sessionPending.mode : null}
    assistantPresentation={assistantPresentation}
    onReuseMessage={handleReuseMessage}
    onRuntimeSendMessage={runtimeActionsMatchRenderedSession ? onRuntimeSendMessage : undefined}
    onRuntimeOpenLink={runtimeActionsMatchRenderedSession ? onRuntimeOpenLink : undefined}
    liveView={liveView}
    errorMessage={liveView.showBlockingError ? t('errors.historyUnavailable') : localizedRuntimeError}
    showThinking={showThinking}
    userAvatarDataUrl={userAvatarDataUrl}
    sessionIdentity={currentSession.meta.sessionIdentity ?? undefined}
    endpointSessionId={currentSession.meta.endpointSessionId}
    onLoadOlder={handleLoadOlder}
    loadOlderLabel={t('liveThread.loadOlder')}
    onJumpToLatest={handleJumpToLatest}
    jumpToBottomLabel={t('liveThread.jumpToBottom')}
    workspaceContext={artifacts.workspaceContext}
    artifactGroups={artifacts.artifactGroups}
    onOpenArtifactFile={artifacts.onOpenArtifactFile}
    onOpenAttachedArtifact={artifacts.onOpenAttachedArtifact}
  />, [assistantPresentation, currentSession.meta.endpointSessionId, currentSession.meta.sessionIdentity,
    currentSession.runTimings, currentSession.runtime, currentSession.window, currentSessionRecordKey, handleJumpToLatest, handleLoadOlder, handleReuseMessage,
    liveView, localizedRuntimeError, onRuntimeOpenLink, onRuntimeSendMessage, renderItems,
    runtimeActionsMatchRenderedSession, scrollScopeKey, sessionPending, showThinking, t, userAvatarDataUrl, viewportPaneRef, workspaceActive]);
  const emptyState = useMemo(() => <WelcomeScreen />, []);
  const isEmptyState = liveView.isEmptyState && chatQuestions.questions.length === 0 && !chatQuestions.error && sessionQuestions.questions.length === 0 && !sessionQuestions.error;
  const renderArtifactSlots = useCallback(({ viewportPane }: ChatArtifactSlots) => children({
    viewportPane, headerProps, input, isEmptyState, emptyState,
  }), [children, emptyState, headerProps, input, isEmptyState]);
  return (
    <AssistantPendingLabelProvider label={pendingRunProgressLabel}>
      <ChatArtifacts renderItems={renderItems} renderViewport={renderViewport}>
        {renderArtifactSlots}
      </ChatArtifacts>
    </AssistantPendingLabelProvider>
  );
});
