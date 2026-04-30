import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { buildChatAutoFollowSignal } from '../chat-auto-follow';
import { useChatScroll } from '../useChatScroll';
import { useChatView } from '../useChatView';
import { useViewportListItems } from '../viewport-list-items';
import { ChatList } from './ChatList';
import type { ToolStatus } from '@/stores/chat';
import type {
  ChatSessionHistoryStatus,
  ChatSessionViewportState,
} from '@/stores/chat/types';

interface ThreadAgent {
  id: string;
  name?: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

interface ChatViewportPaneProps {
  isActive: boolean;
  currentSessionKey: string;
  viewport: ChatSessionViewportState;
  agents: ThreadAgent[];
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  currentSessionStatus: ChatSessionHistoryStatus;
  errorMessage: string | null;
  sending: boolean;
  pendingFinal: boolean;
  waitingApproval: boolean;
  showThinking: boolean;
  streamingTools: ToolStatus[];
  userAvatarDataUrl: string | null;
  assistantAgentId: string;
  assistantAgentName: string;
  assistantAvatarSeed?: string;
  assistantAvatarStyle?: AgentAvatarStyle;
  onLoadOlder: () => void;
  loadOlderLabel: string;
  onJumpToLatest: () => void;
  jumpToLatestLabel: string;
  jumpToBottomLabel: string;
}

export interface ChatViewportPaneHandle {
  prepareCurrentLatestBottomAlign: () => void;
}

const CHAT_BOTTOM_FOLLOW_THRESHOLD_PX = 96;

export const ChatViewportPane = forwardRef<ChatViewportPaneHandle, ChatViewportPaneProps>(function ChatViewportPane(
  {
    isActive,
    currentSessionKey,
    viewport,
    agents,
    isGatewayRunning,
    gatewayRpc,
    currentSessionStatus,
    errorMessage,
    sending,
    pendingFinal,
    waitingApproval,
    showThinking,
    streamingTools,
    userAvatarDataUrl,
    assistantAgentId,
    assistantAgentName,
    assistantAvatarSeed,
    assistantAvatarStyle,
    onLoadOlder,
    loadOlderLabel,
    onJumpToLatest,
    jumpToLatestLabel,
    jumpToBottomLabel,
  },
  ref,
) {
  const scopeKey = currentSessionKey;
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const sessionPipelineCostRef = useRef({
    sessionKey: scopeKey,
    staticRowsMs: 0,
    runtimeRowsMs: 0,
  });

  const effectiveSending = sending;
  const effectivePendingFinal = pendingFinal;
  const effectiveWaitingApproval = waitingApproval;
  const effectiveStreamingTools = streamingTools;

  const {
    items,
    suppressedToolCardRowKeys,
  } = useViewportListItems({
    scopeKey,
    sessionKey: currentSessionKey,
    messages: viewport.messages,
    agents,
    isGatewayRunning,
    gatewayRpc,
    sending: effectiveSending,
    pendingFinal: effectivePendingFinal,
    waitingApproval: effectiveWaitingApproval,
    showThinking,
    streamingTools: effectiveStreamingTools,
    sessionPipelineCostRef,
  });

  const liveView = useChatView({
    currentSessionStatus,
    rowCount: items.length,
    sending: effectiveSending,
    refreshing: false,
    mutating: false,
  });
  const showBlockingLoading = liveView.showBlockingLoading;
  const showBlockingError = liveView.showBlockingError;
  const isEmptyState = liveView.isEmptyState;

  const autoFollowSignal = buildChatAutoFollowSignal(items);
  const tailActivityOpen = (
    effectiveSending
    || effectivePendingFinal
    || effectiveStreamingTools.length > 0
  );

  const {
    handleViewportPointerDown,
    handleViewportTouchMove,
    handleViewportWheel,
    handleViewportScroll,
    prepareScopeAnchorRestore,
    prepareScopeBottomAlign,
    jumpToBottom,
    isBottomLocked,
  } = useChatScroll({
    enabled: isActive,
    scrollScopeKey: scopeKey,
    autoFollowSignal,
    tailActivityOpen,
    viewportRef: messagesViewportRef,
    contentRef: messageContentRef,
    stickyBottomThresholdPx: CHAT_BOTTOM_FOLLOW_THRESHOLD_PX,
  });

  const scrollToRowKey = useCallback((rowKey?: string) => {
    if (!rowKey) {
      return;
    }
    const viewportNode = messagesViewportRef.current;
    if (!viewportNode) {
      return;
    }
    const target = Array.from(viewportNode.querySelectorAll<HTMLElement>('[data-chat-row-key]'))
      .find((element) => element.dataset.chatRowKey === rowKey);
    if (!target) {
      return;
    }
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, []);

  useImperativeHandle(ref, () => ({
    prepareCurrentLatestBottomAlign: () => {
      prepareScopeBottomAlign(currentSessionKey);
    },
  }), [currentSessionKey, prepareScopeBottomAlign]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <ChatList
        messagesViewportRef={messagesViewportRef}
        messageContentRef={messageContentRef}
        isEmptyState={isEmptyState}
        showBlockingLoading={showBlockingLoading}
        showBlockingError={showBlockingError}
        errorMessage={errorMessage}
        onPointerDown={handleViewportPointerDown}
        onScroll={handleViewportScroll}
        onTouchMove={handleViewportTouchMove}
        onWheel={handleViewportWheel}
        items={items}
        showLoadOlder={viewport.hasMore || viewport.isLoadingMore}
        isLoadingOlder={viewport.isLoadingMore}
        onLoadOlder={() => {
          prepareScopeAnchorRestore(currentSessionKey);
          onLoadOlder();
        }}
        loadOlderLabel={loadOlderLabel}
        showJumpToBottom={!isEmptyState && !showBlockingLoading && !showBlockingError && (!isBottomLocked || !viewport.isAtLatest)}
        onJumpAction={viewport.isAtLatest ? jumpToBottom : onJumpToLatest}
        jumpActionLabel={viewport.isAtLatest ? jumpToBottomLabel : jumpToLatestLabel}
        showThinking={showThinking}
        assistantAgentId={assistantAgentId}
        assistantAgentName={assistantAgentName}
        assistantAvatarSeed={assistantAvatarSeed}
        assistantAvatarStyle={assistantAvatarStyle}
        userAvatarImageUrl={userAvatarDataUrl}
        suppressedToolCardRowKeys={suppressedToolCardRowKeys}
        onJumpToRowKey={scrollToRowKey}
      />
    </div>
  );
});
