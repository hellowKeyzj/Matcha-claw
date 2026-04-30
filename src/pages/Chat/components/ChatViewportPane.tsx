import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { buildChatAutoFollowSignal } from '../chat-auto-follow';
import { createChatScrollChromeStore } from '../chat-scroll-chrome-store';
import { useChatRenderModel } from '../chat-render-model';
import { useChatScroll } from '../useChatScroll';
import { useChatView } from '../useChatView';
import { ChatList } from './ChatList';
import type {
  ChatSessionRecord,
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
  currentSession: ChatSessionRecord;
  agents: ThreadAgent[];
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  errorMessage: string | null;
  showThinking: boolean;
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

interface ChatViewportCommandShell {
  loadOlder: () => void;
  jumpToRowKey: (rowKey?: string) => void;
  prepareLatestBottomAlign: () => void;
}

export const ChatViewportPane = forwardRef<ChatViewportPaneHandle, ChatViewportPaneProps>(function ChatViewportPane(
  {
    isActive,
    currentSessionKey,
    currentSession,
    agents,
    isGatewayRunning,
    gatewayRpc,
    errorMessage,
    showThinking,
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
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const scrollChromeStoreRef = useRef<ReturnType<typeof createChatScrollChromeStore> | null>(null);
  const currentSessionKeyRef = useRef(currentSessionKey);
  const onLoadOlderRef = useRef(onLoadOlder);
  const viewport: ChatSessionViewportState = currentSession.window;
  const runtime = currentSession.runtime;
  if (scrollChromeStoreRef.current == null) {
    scrollChromeStoreRef.current = createChatScrollChromeStore({
      isBottomLocked: true,
      visible: false,
      isAtLatest: viewport.isAtLatest,
      jumpActionLabel: viewport.isAtLatest ? jumpToBottomLabel : jumpToLatestLabel,
    });
  }
  const scrollChromeStore = scrollChromeStoreRef.current;

  const {
    rows,
    executionGraphSlots,
    pendingAssistantShell,
  } = useChatRenderModel({
    sessionKey: currentSessionKey,
    messages: viewport.messages,
    runtime,
    agents,
    isGatewayRunning,
    gatewayRpc,
    showThinking,
  });

  const liveView = useChatView({
    currentSessionStatus: currentSession.meta.historyStatus,
    rowCount: rows.length,
    sending: runtime.sending,
    refreshing: false,
    mutating: false,
  });
  const showBlockingLoading = liveView.showBlockingLoading;
  const showBlockingError = liveView.showBlockingError;
  const isEmptyState = liveView.isEmptyState;
  const canShowScrollChrome = !isEmptyState && !showBlockingLoading && !showBlockingError;

  const autoFollowSignal = buildChatAutoFollowSignal(rows);
  const tailActivityOpen = (
    runtime.sending
    || runtime.pendingFinal
    || runtime.streamingTools.length > 0
  );

  const {
    handleViewportPointerDown,
    handleViewportTouchMove,
    handleViewportWheel,
    handleViewportScroll,
    prepareScopeAnchorRestore,
    prepareScopeBottomAlign,
    jumpToBottom,
  } = useChatScroll({
    enabled: isActive,
    scrollScopeKey: currentSessionKey,
    autoFollowSignal,
    tailActivityOpen,
    setScrollChromeBottomLocked: scrollChromeStore.setBottomLocked,
    viewportRef: messagesViewportRef,
    contentRef: messageContentRef,
    stickyBottomThresholdPx: CHAT_BOTTOM_FOLLOW_THRESHOLD_PX,
  });

  currentSessionKeyRef.current = currentSessionKey;
  onLoadOlderRef.current = onLoadOlder;

  const viewportCommandShellRef = useRef<ChatViewportCommandShell | null>(null);
  if (viewportCommandShellRef.current == null) {
    viewportCommandShellRef.current = {
      loadOlder: () => {
        const sessionKey = currentSessionKeyRef.current;
        if (!sessionKey) {
          return;
        }
        prepareScopeAnchorRestore(sessionKey);
        onLoadOlderRef.current();
      },
      jumpToRowKey: (rowKey?: string) => {
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
      },
      prepareLatestBottomAlign: () => {
        const sessionKey = currentSessionKeyRef.current;
        if (!sessionKey) {
          return;
        }
        prepareScopeBottomAlign(sessionKey);
      },
    };
  }
  const viewportCommandShell = viewportCommandShellRef.current;

  useLayoutEffect(() => {
    scrollChromeStore.setChromeState({
      visible: canShowScrollChrome,
      isAtLatest: viewport.isAtLatest,
      jumpActionLabel: viewport.isAtLatest ? jumpToBottomLabel : jumpToLatestLabel,
    });
    scrollChromeStore.setJumpHandlers({
      jumpToBottom,
      jumpToLatest: onJumpToLatest,
    });
  }, [
    canShowScrollChrome,
    jumpToBottom,
    jumpToBottomLabel,
    jumpToLatestLabel,
    onJumpToLatest,
    scrollChromeStore,
    viewport.isAtLatest,
  ]);

  useImperativeHandle(ref, () => ({
    prepareCurrentLatestBottomAlign: () => {
      viewportCommandShell.prepareLatestBottomAlign();
    },
  }), [viewportCommandShell]);

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
        rows={rows}
        showLoadOlder={viewport.hasMore || viewport.isLoadingMore}
        isLoadingOlder={viewport.isLoadingMore}
        onLoadOlder={viewportCommandShell.loadOlder}
        loadOlderLabel={loadOlderLabel}
        scrollChromeStore={scrollChromeStore}
        showThinking={showThinking}
        streamingTools={runtime.streamingTools}
        assistantAgentId={assistantAgentId}
        assistantAgentName={assistantAgentName}
        assistantAvatarSeed={assistantAvatarSeed}
        assistantAvatarStyle={assistantAvatarStyle}
        userAvatarImageUrl={userAvatarDataUrl}
        executionGraphSlots={executionGraphSlots}
        pendingAssistantShell={pendingAssistantShell}
        onJumpToRowKey={viewportCommandShell.jumpToRowKey}
      />
    </div>
  );
});
