import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type ApprovalItem, type ChatSessionRuntimeState } from '@/stores/chat';
import { createSessionPending } from '@/stores/chat/session-presentation';
import { ABORT_STOPPING_TIMEOUT_ERROR, ABORT_UNKNOWN_ERROR, ABORT_REJECTED_ERROR, ABORT_REQUEST_FAILED_ERROR } from '@/stores/chat/abort-handlers';
import { isRunActive } from '@/stores/chat/types';
import { getPendingApprovals, getSessionApprovalStatus, projectSessionViewItems } from '@/stores/chat/store-state-helpers';
import { hasVisibleRuntimeError } from '@/stores/chat/runtime-error-view';
import { resolveSessionOperationTarget } from '@/stores/chat/session-identity';
import { useGatewayStore } from '@/stores/gateway';
import { useSettingsStore } from '@/stores/settings';
import { useComposerDraftStore } from '@/stores/composer-drafts';
import type { GatewayTransportIssue } from '@/types/session/runtime-state';
import { runtimeEndpointsEqual, sessionIdentitiesEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionRenderItem } from '@/types/session/render-item';
import type { SessionWindowStateSnapshot } from '@/types/session/snapshot';
import { isGatewayOperational } from '@/lib/gateway-status';
import { hostSessionWindowFetch } from '@/lib/host-api';
import { toast } from 'sonner';
import { logSessionTrace, summarizeIdentifier, summarizeSessionIdentity, isSessionTraceEnabled, summarizeRenderItems } from '@/lib/session-trace';
import { decodeHistorySessionView, resolveSessionViewError, sessionViewWindow } from '@/stores/chat/history-fetch-helpers';
import { TRANSIENT_RUNTIME_ERROR_BANNER_DELAY_MS, shouldShowRuntimeErrorBannerImmediately } from './runtime-error-banner';
import { AssistantPendingLabelProvider } from './components/AssistantPendingIndicator';
import { ChatList, type ChatListHandle } from './components/ChatList';
import type { ChatHeaderBar } from './components/ChatHeaderBar';
import { ChatApprovalDock, ChatErrorBanner, ChatRuntimeStatusDock } from './components/ChatRuntimeDock';
import { SessionTodoPanel } from './components/SessionTodoPanel';
import { WelcomeScreen } from './components/ChatStates';
import type { ChatInputHandle } from './ChatInput';
import { useChatView } from './useChatView';
import { useChatQuestions } from './useChatQuestions';
import { useSessionQuestions } from './useSessionQuestions';
import { SessionQuestionDock } from './components/SessionQuestionDock';
import { ChatQuestionDock } from './components/ChatQuestionDock';
import { applyAssistantPresentationToItems, type ChatAssistantCatalogAgent, type ChatAssistantPresentation, type ChatRenderItem } from './chat-render-item-model';
import { buildChatSessionMarkdownExport, downloadMarkdownFile } from './session-markdown-export';
import { ChatArtifacts, type ChatArtifactSlots, type ChatArtifactViewportContent } from './ChatArtifacts';
import { selectChatSelection, selectChatSession, useChatAgent, useChatRuntime } from './chat-session';

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
  if (!runProgress) {
    return null;
  }
  if (runProgress.kind === 'retrying') {
    return t('pending.retrying', {
      attempt: runProgress.attempt,
      maxAttempts: runProgress.maxAttempts,
    });
  }
  return t(`pending.startup.${runProgress.phase}`);
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
  errorBanner: ReactNode;
  approvalDock: ReactNode;
  emptyState: ReactNode;
  isEmptyState: boolean;
}

export const ChatMessages = memo(function ChatMessages({ isActive, input, composerRef, viewportPaneRef, onRuntimeSendMessage, onRuntimeOpenLink, children }: {
  isActive: boolean;
  input: ReactNode;
  composerRef: RefObject<ChatInputHandle | null>;
  viewportPaneRef: RefObject<ChatListHandle | null>;
  onRuntimeSendMessage: (text: string) => Promise<void>;
  onRuntimeOpenLink: (url: string) => Promise<void>;
  children: (slots: ChatMessageSlots) => ReactNode;
}) {
  const { t } = useTranslation('chat');
  const { currentConversation, currentSessionRecordKey, currentComposerDraftKey, currentWorkspaceIdentity, connectorSessionIdentity, currentAgentId } = useChatStore(useShallow(selectChatSelection));
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
  const [dismissedComposerInitialization, setDismissedComposerInitialization] = useState<typeof composerInitialization>();
  const composerConfigurationError = composerInitialization === dismissedComposerInitialization ? null
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
  const liveView = useChatView({
    currentSessionKey: currentSessionRecordKey,
    currentSessionStatus: currentSession.meta.historyStatus,
    itemCount: viewportItems.length,
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
  const imageGenerationActive = currentSession.runtime.imageGeneration?.active === true;
  const imageGenerationLabel = t('input.imageGenerationActive');
  const pendingRunProgressLabel = buildRunProgressPendingLabel(currentSession.runtime.runProgress, t);
  const sessionPending = useMemo(() => createSessionPending(currentSession, currentSessionRecordKey), [currentSession, currentSessionRecordKey]);
  const renderItems = useMemo(() => {
    const runtimePlaceholder = sessionPending?.kind === 'assistant' ? {
      ...sessionPending.item,
      pendingLabel: pendingRunProgressLabel,
      ...(imageGenerationActive ? {
        text: imageGenerationLabel,
        segments: [{ kind: 'message' as const, key: `${sessionPending.item.key}:image-generation`, text: imageGenerationLabel }],
      } : {}),
    } : null;
    const protocolItems = runtimePlaceholder ? [...viewportItems, runtimePlaceholder] : viewportItems;
    const nextItems = applyAssistantPresentationToItems({
      items: [...protocolItems],
      agents: assistantCatalogAgents,
      defaultAssistant: assistantPresentation,
      previousItems: previousRenderedItemsRef.current ?? undefined,
    });
    previousRenderedItemsRef.current = nextItems;
    return nextItems;
  }, [assistantCatalogAgents, assistantPresentation, imageGenerationActive, imageGenerationLabel, pendingRunProgressLabel, sessionPending, viewportItems]);
  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    logSessionTrace('session.presentation.committed', 'session-presentation-boundary', () => ({
      identity: summarizeSessionIdentity(connectorSessionIdentity), recordKey: summarizeIdentifier(currentSessionRecordKey),
      runtimePhase: currentSession.runtime.runPhase, activeRunHash: summarizeIdentifier(currentSession.runtime.activeRunId).hash,
      pendingTurnHash: summarizeIdentifier(currentSession.runtime.pendingTurnKey).hash,
      viewport: summarizeRenderItems(viewportItems), presentation: summarizeRenderItems(renderItems),
      placeholderHashes: renderItems.slice(0, 200).filter((item) => !viewportItems.some((original) => original.key === item.key))
        .map((item) => summarizeIdentifier(item.key).hash),
      placeholderCount: renderItems.length - viewportItems.length,
    }));
  }, [connectorSessionIdentity, currentSession.runtime, currentSessionRecordKey, renderItems, viewportItems]);
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
  const errorBanner = bannerError ? (
    <ChatErrorBanner
      error={bannerError}
      dismissLabel={t('common:actions.dismiss')}
      onDismiss={composerConfigurationError
        ? () => setDismissedComposerInitialization(composerInitialization)
        : clearError}
    />
  ) : null;
  const runtimeStatusDock = currentSession.runtime.runtimeActivity === 'compacting' || currentSession.runtime.errorDetail || currentSession.runtime.runtimeNotice ? (
    <ChatRuntimeStatusDock
      compacting={currentSession.runtime.runtimeActivity === 'compacting'}
      errorDetail={currentSession.runtime.errorDetail}
      runtimeNotice={currentSession.runtime.runtimeNotice}
    />
  ) : null;
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
          exportedAt: new Date(),
        });
        downloadMarkdownFile(exportedSession.fileName, exportedSession.markdown);
      } catch (error) {
        toast.error(t('errors.exportMarkdownFailed', { error: error instanceof Error ? error.message : String(error) }));
      } finally {
        setExportingMarkdown(false);
      }
    })();
  }, [assistantCatalogAgents, currentAgent?.avatarSeed, currentAgent?.avatarStyle, currentAgent?.name, currentAgentId, currentSession.meta.displayName, currentSession.meta.label, currentSession.window, currentSessionConversation, currentSessionRecordKey, exportingMarkdown, t, viewportItems]);
  const handleReuseMessage = useCallback((text: string) => { composerRef.current?.replaceText(text); }, [composerRef]);
  const runtimeActionsMatchRenderedSession = !!currentWorkspaceIdentity && !!currentSession.meta.sessionIdentity
    && sessionIdentitiesEqual(currentWorkspaceIdentity, currentSession.meta.sessionIdentity);
  const headerProps = {
    showThinking,
    onToggleThinking: toggleThinking,
    exportDisabled: exportingMarkdown || !currentSessionRecordKey,
    onExportMarkdown: handleExportMarkdown,
    todoPanel: <SessionTodoPanel sessionKey={currentSessionRecordKey} />,
  };
  const approvalDock = approvalStatus === 'awaiting_approval' || chatQuestions.questions.length > 0 || chatQuestions.error || sessionQuestions.questions.length > 0 || sessionQuestions.error ? (
    <>
      {approvalStatus === 'awaiting_approval' ? <ChatApprovalDock
        waitingLabel={t('approval.waitingLabel')}
        approvals={currentPendingApprovals}
        onResolve={(approval, decision) => { void resolveApproval(approval, decision); }}
      /> : null}
      <ChatQuestionDock key={chatQuestions.scopeKey} questions={chatQuestions.questions} confirmed={chatQuestions.confirmed}
        error={chatQuestions.error} submittingId={chatQuestions.submittingId} onRefresh={chatQuestions.refresh} onResolve={chatQuestions.resolve} />
      <SessionQuestionDock key={sessionQuestions.scopeKey} questions={sessionQuestions.questions} confirmed={sessionQuestions.confirmed}
        error={sessionQuestions.error} submittingId={sessionQuestions.submittingId} onRefresh={sessionQuestions.refresh} onRespond={sessionQuestions.respond} />
    </>
  ) : null;
  const renderViewport = useCallback((artifacts: ChatArtifactViewportContent) => <ChatList
    ref={viewportPaneRef}
    isActive={workspaceActive}
    currentSessionKey={currentSessionRecordKey}
    runtime={currentSession.runtime}
    viewport={currentSession.window}
    items={renderItems}
    activity={sessionPending?.kind === 'activity' ? sessionPending.mode : null}
    assistantPresentation={assistantPresentation}
    onReuseMessage={handleReuseMessage}
    onRuntimeSendMessage={runtimeActionsMatchRenderedSession ? onRuntimeSendMessage : undefined}
    onRuntimeOpenLink={runtimeActionsMatchRenderedSession ? onRuntimeOpenLink : undefined}
    liveView={liveView}
    errorMessage={localizedRuntimeError}
    showThinking={showThinking}
    userAvatarDataUrl={userAvatarDataUrl}
    sessionIdentity={currentSession.meta.sessionIdentity ?? undefined}
    endpointSessionId={currentSession.meta.endpointSessionId}
    onLoadOlder={() => { if (currentSessionRecordKey) void loadOlderViewportItems(currentSessionRecordKey); }}
    loadOlderLabel={t('liveThread.loadOlder')}
    onJumpToLatest={() => { if (currentSessionRecordKey) void jumpViewportToLatest(currentSessionRecordKey); }}
    jumpToBottomLabel={t('liveThread.jumpToBottom')}
    workspaceContext={artifacts.workspaceContext}
    artifactGroups={artifacts.artifactGroups}
    onOpenArtifactFile={artifacts.onOpenArtifactFile}
    onOpenAttachedArtifact={artifacts.onOpenAttachedArtifact}
  />, [assistantPresentation, currentSession.meta.endpointSessionId, currentSession.meta.sessionIdentity,
    currentSession.runtime, currentSession.window, currentSessionRecordKey, handleReuseMessage, jumpViewportToLatest,
    liveView, loadOlderViewportItems, localizedRuntimeError, onRuntimeOpenLink, onRuntimeSendMessage, renderItems,
    runtimeActionsMatchRenderedSession, sessionPending, showThinking, t, userAvatarDataUrl, viewportPaneRef, workspaceActive]);
  return (
    <AssistantPendingLabelProvider label={pendingRunProgressLabel}>
      <ChatArtifacts renderItems={renderItems} renderViewport={renderViewport}>
        {({ viewportPane, sidePanel }) => children({
          viewportPane, sidePanel, headerProps, approvalDock,
          errorBanner: errorBanner ?? runtimeStatusDock,
          isEmptyState: liveView.isEmptyState && chatQuestions.questions.length === 0 && !chatQuestions.error && sessionQuestions.questions.length === 0 && !sessionQuestions.error,
          emptyState: <WelcomeScreen input={<div className="flex flex-col gap-2">{errorBanner}{input}</div>} />,
        })}
      </ChatArtifacts>
    </AssistantPendingLabelProvider>
  );
});
