import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type TouchEventHandler,
  type WheelEventHandler,
} from 'react';
import { ArrowDown } from 'lucide-react';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';
import { buildChatAutoFollowSignal } from '../chat-auto-follow';
import { getOrBuildStaticRowsCacheEntry } from '../chat-rows-cache';
import { createChatScrollChromeStore, type ChatScrollChromeStore } from '../chat-scroll-chrome-store';
import type { ChatMessageRow } from '../chat-row-model';
import type { ExecutionGraphData } from '../execution-graph-model';
import { ChatMessage } from '../ChatMessage';
import { ExecutionGraphCard } from '../ExecutionGraphCard';
import { PendingAssistantShell } from '../pending-assistant-shell';
import { useExecutionGraphs } from '../useExecutionGraphs';
import { useChatScroll } from '../useChatScroll';
import { useChatView } from '../useChatView';
import { FailureScreen } from './ChatStates';
import type {
  ApprovalStatus,
  ChatSessionRecord,
  ToolStatus,
} from '@/stores/chat';

const CHAT_BOTTOM_FOLLOW_THRESHOLD_PX = 96;
const EMPTY_STREAMING_TOOLS: ToolStatus[] = [];

interface ThreadAgent {
  id: string;
  name?: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

export interface ChatListHandle {
  prepareCurrentLatestBottomAlign: () => void;
}

export interface ChatExecutionGraphSlots {
  anchoredGraphsByRowKey: ReadonlyMap<string, ReadonlyArray<ExecutionGraphData>>;
  suppressedToolCardRowKeys: ReadonlySet<string>;
}

export interface PendingAssistantShellState {
  state: 'typing' | 'activity';
}

const EMPTY_EXECUTION_GRAPH_SLOTS: ChatExecutionGraphSlots = {
  anchoredGraphsByRowKey: new Map(),
  suppressedToolCardRowKeys: new Set(),
};

export function buildExecutionGraphSlots(
  rows: ChatMessageRow[],
  executionGraphs: ExecutionGraphData[],
): ChatExecutionGraphSlots {
  if (rows.length === 0 || executionGraphs.length === 0) {
    return EMPTY_EXECUTION_GRAPH_SLOTS;
  }

  const rowKeys = new Set(rows.map((row) => row.key));
  const anchoredGraphsByRowKey = new Map<string, ExecutionGraphData[]>();
  const suppressedToolCardRowKeys = new Set<string>();
  for (const graph of executionGraphs) {
    for (const rowKey of graph.suppressToolCardMessageKeys || []) {
      suppressedToolCardRowKeys.add(rowKey);
    }
    const anchorRowKey = rowKeys.has(graph.anchorMessageKey)
      ? graph.anchorMessageKey
      : rows[rows.length - 1]?.key;
    if (!anchorRowKey) {
      continue;
    }
    const current = anchoredGraphsByRowKey.get(anchorRowKey);
    if (current) {
      current.push(graph);
      continue;
    }
    anchoredGraphsByRowKey.set(anchorRowKey, [graph]);
  }

  return {
    anchoredGraphsByRowKey,
    suppressedToolCardRowKeys,
  };
}

export function buildPendingAssistantShell(
  approvalStatus: ApprovalStatus,
  sending: boolean,
  pendingFinal: boolean,
  streamingTools: ToolStatus[],
  messages: ChatSessionRecord['messages'],
): PendingAssistantShellState | null {
  if (
    !sending
    || approvalStatus === 'awaiting_approval'
    || streamingTools.length > 0
    || messages.some((message) => message.role === 'assistant' && Boolean(message.streaming))
  ) {
    return null;
  }

  return {
    state: pendingFinal ? 'activity' : 'typing',
  };
}

export interface ChatListProps {
  isActive: boolean;
  currentSessionKey: string;
  currentSession: ChatSessionRecord;
  approvalStatus: ApprovalStatus;
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
  jumpToBottomLabel: string;
}

interface ChatListSurfaceProps {
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  messageContentRef: RefObject<HTMLDivElement | null>;
  isEmptyState: boolean;
  showBlockingLoading: boolean;
  showBlockingError: boolean;
  errorMessage: string | null;
  onPointerDown: () => void;
  onScroll: () => void;
  onTouchMove: TouchEventHandler<HTMLDivElement>;
  onWheel: WheelEventHandler<HTMLDivElement>;
  rows: ChatMessageRow[];
  showLoadOlder: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
  loadOlderLabel: string;
  scrollChromeStore: ChatScrollChromeStore;
  showThinking: boolean;
  streamingTools: ToolStatus[];
  assistantAgentId: string;
  assistantAgentName: string;
  assistantAvatarSeed?: string;
  assistantAvatarStyle?: AgentAvatarStyle;
  userAvatarImageUrl: string | null;
  executionGraphSlots: ChatExecutionGraphSlots;
  pendingAssistantShell: PendingAssistantShellState | null;
  onJumpToRowKey: (rowKey?: string) => void;
}

type ChatListContentProps = Omit<
  ChatListSurfaceProps,
  'messagesViewportRef' | 'messageContentRef' | 'onPointerDown' | 'onScroll' | 'onTouchMove' | 'onWheel' | 'scrollChromeStore'
>;

function getMessageDataAttributes(row: ChatMessageRow) {
  const messageId = typeof row.message.id === 'string' && row.message.id.trim()
    ? row.message.id
    : undefined;
  const timestamp = typeof row.message.timestamp === 'number'
    ? String(row.message.timestamp)
    : undefined;

  return {
    'data-chat-row-key': row.key,
    'data-chat-row-kind': row.kind,
    'data-chat-message-id': messageId,
    'data-chat-message-timestamp': timestamp,
  };
}

const ChatListContent = memo(function ChatListContent({
  isEmptyState,
  showBlockingLoading,
  showBlockingError,
  errorMessage,
  rows,
  showLoadOlder,
  isLoadingOlder,
  onLoadOlder,
  loadOlderLabel,
  showThinking,
  streamingTools,
  assistantAgentId,
  assistantAgentName,
  assistantAvatarSeed,
  assistantAvatarStyle,
  userAvatarImageUrl,
  executionGraphSlots,
  pendingAssistantShell,
  onJumpToRowKey,
}: ChatListContentProps) {
  const showLoadOlderButton = showLoadOlder || isLoadingOlder;
  const { anchoredGraphsByRowKey, suppressedToolCardRowKeys } = executionGraphSlots;

  if (showBlockingLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center py-20">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (showBlockingError) {
    return <FailureScreen message={errorMessage} />;
  }

  return (
    <>
      {showLoadOlderButton && !isEmptyState ? (
        <div
          data-testid="chat-load-older-rail"
          className={CHAT_LAYOUT_TOKENS.threadTopAffordanceRail}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-none px-1.5 text-[11px] text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={onLoadOlder}
            disabled={isLoadingOlder}
          >
            {isLoadingOlder ? <LoadingSpinner size="sm" /> : null}
            {loadOlderLabel}
          </Button>
        </div>
      ) : null}

      {!isEmptyState ? (
        <>
          {rows.map((row, index) => {
            const rowExecutionGraphs = anchoredGraphsByRowKey.get(row.key);
            return (
              <div key={row.key}>
                <div
                  data-index={index}
                  className={CHAT_LAYOUT_TOKENS.threadMessageRowSpacing}
                >
                  <div
                    {...getMessageDataAttributes(row)}
                    className="w-full"
                  >
                    <ChatMessage
                      row={row}
                      showThinking={showThinking}
                      suppressToolCards={suppressedToolCardRowKeys.has(row.key)}
                      streamingTools={row.message.streaming ? streamingTools : EMPTY_STREAMING_TOOLS}
                      assistantAgentId={assistantAgentId}
                      assistantAgentName={assistantAgentName}
                      assistantAvatarSeed={assistantAvatarSeed}
                      assistantAvatarStyle={assistantAvatarStyle}
                      userAvatarImageUrl={userAvatarImageUrl}
                    />
                  </div>
                  {rowExecutionGraphs?.length ? (
                    <div
                      data-testid="chat-execution-graph-rail"
                      className={cn(
                        CHAT_LAYOUT_TOKENS.messageShell,
                        CHAT_LAYOUT_TOKENS.messageShellAssistantColumns,
                        'pt-2',
                      )}
                    >
                      <div
                        aria-hidden="true"
                        className={cn(
                          CHAT_LAYOUT_TOKENS.messageAvatar,
                          CHAT_LAYOUT_TOKENS.messageAvatarAssistantOrder,
                          'pointer-events-none opacity-0',
                        )}
                      />
                      <div
                        className={cn(
                          CHAT_LAYOUT_TOKENS.messageContentColumn,
                          CHAT_LAYOUT_TOKENS.messageContentAssistantOrder,
                          'space-y-2',
                        )}
                      >
                        {rowExecutionGraphs.map((graph) => (
                          <ExecutionGraphCard
                            key={graph.id}
                            agentLabel={graph.agentLabel}
                            sessionLabel={graph.sessionLabel}
                            steps={graph.steps}
                            active={graph.active}
                            triggerMessageKey={graph.triggerMessageKey}
                            replyMessageKey={graph.replyMessageKey}
                            onJumpToRowKey={onJumpToRowKey}
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          {pendingAssistantShell ? (
            <div className={CHAT_LAYOUT_TOKENS.threadMessageRowSpacing}>
              <PendingAssistantShell
                state={pendingAssistantShell.state}
                assistantAgentId={assistantAgentId}
                assistantAgentName={assistantAgentName}
                assistantAvatarSeed={assistantAvatarSeed}
                assistantAvatarStyle={assistantAvatarStyle}
                userAvatarImageUrl={userAvatarImageUrl}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
});

const ChatScrollChrome = memo(function ChatScrollChrome({
  scrollChromeStore,
  showLoadOlderButton,
}: {
  scrollChromeStore: ChatScrollChromeStore;
  showLoadOlderButton: boolean;
}) {
  const { isBottomLocked, visible, isAtLatest, jumpActionLabel } = useSyncExternalStore(
    scrollChromeStore.subscribe,
    scrollChromeStore.getSnapshot,
    scrollChromeStore.getSnapshot,
  );
  const showJumpToBottom = visible && (!isBottomLocked || !isAtLatest);

  if (!showJumpToBottom) {
    return null;
  }

  return (
    <div
      className={CHAT_LAYOUT_TOKENS.stageJumpToBottomRail}
      style={{ bottom: 'calc(var(--chat-composer-safe-offset, 0px) + 0.75rem)' }}
    >
      <div className={CHAT_LAYOUT_TOKENS.stageFloatingRail}>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn(
            'pointer-events-auto h-9 w-9 rounded-full border-border/45 bg-background/90 text-foreground shadow-[0_8px_22px_rgba(15,23,42,0.08)] transition-transform hover:-translate-y-0.5 backdrop-blur-xl supports-[backdrop-filter]:bg-background/82',
            showLoadOlderButton && 'translate-y-1',
          )}
          onClick={scrollChromeStore.runJumpAction}
          aria-label={jumpActionLabel}
          title={jumpActionLabel}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
});

export const ChatListSurface = memo(function ChatListSurface({
  messagesViewportRef,
  messageContentRef,
  isEmptyState,
  showBlockingLoading,
  showBlockingError,
  errorMessage,
  onPointerDown,
  onScroll,
  onTouchMove,
  onWheel,
  rows,
  showLoadOlder,
  isLoadingOlder,
  onLoadOlder,
  loadOlderLabel,
  scrollChromeStore,
  showThinking,
  streamingTools,
  assistantAgentId,
  assistantAgentName,
  assistantAvatarSeed,
  assistantAvatarStyle,
  userAvatarImageUrl,
  executionGraphSlots,
  pendingAssistantShell,
  onJumpToRowKey,
}: ChatListSurfaceProps) {
  const showLoadOlderButton = showLoadOlder || isLoadingOlder;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={messagesViewportRef}
        className={cn(
          `min-h-0 flex-1 overflow-y-auto chat-scroll-sync-viewport ${CHAT_LAYOUT_TOKENS.threadViewportPadding}`,
        )}
        style={{
          overflowAnchor: 'none',
          scrollbarGutter: 'stable',
          paddingBottom: 'var(--chat-thread-bottom-padding, 0px)',
        }}
        onPointerDownCapture={onPointerDown}
        onScroll={onScroll}
        onTouchMoveCapture={onTouchMove}
        onWheelCapture={onWheel}
      >
        <div className={CHAT_LAYOUT_TOKENS.threadRail}>
          <div
            ref={messageContentRef}
            data-testid="chat-message-stack"
            className={cn(
              'w-full',
              !showBlockingLoading && !isEmptyState && CHAT_LAYOUT_TOKENS.threadMessageStackPaddingTop,
            )}
            style={{ overflowAnchor: 'none' }}
          >
            <ChatListContent
              isEmptyState={isEmptyState}
              showBlockingLoading={showBlockingLoading}
              showBlockingError={showBlockingError}
              errorMessage={errorMessage}
              rows={rows}
              showLoadOlder={showLoadOlder}
              isLoadingOlder={isLoadingOlder}
              onLoadOlder={onLoadOlder}
              loadOlderLabel={loadOlderLabel}
              showThinking={showThinking}
              streamingTools={streamingTools}
              assistantAgentId={assistantAgentId}
              assistantAgentName={assistantAgentName}
              assistantAvatarSeed={assistantAvatarSeed}
              assistantAvatarStyle={assistantAvatarStyle}
              userAvatarImageUrl={userAvatarImageUrl}
              executionGraphSlots={executionGraphSlots}
              pendingAssistantShell={pendingAssistantShell}
              onJumpToRowKey={onJumpToRowKey}
            />
          </div>
        </div>
      </div>
      <ChatScrollChrome
        scrollChromeStore={scrollChromeStore}
        showLoadOlderButton={showLoadOlderButton}
      />
    </div>
  );
});

export const ChatList = forwardRef<ChatListHandle, ChatListProps>(function ChatList(
  {
    isActive,
    currentSessionKey,
    currentSession,
    approvalStatus,
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
    jumpToBottomLabel,
  },
  ref,
) {
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const viewport = currentSession.window;
  const runtime = currentSession.runtime;
  const [scrollChromeStore] = useState(() => (
    createChatScrollChromeStore({
      isBottomLocked: true,
      visible: false,
      isAtLatest: viewport.isAtLatest,
      jumpActionLabel: jumpToBottomLabel,
    })
  ));
  const viewportMessages = currentSession.messages.slice(
    viewport.windowStartOffset,
    viewport.windowEndOffset,
  );
  const tooling = currentSession.tooling ?? {
    streamingTools: [],
    pendingToolImages: [],
  };
  const executionGraphs = useExecutionGraphs({
    enabled: isGatewayRunning,
    messages: viewportMessages,
    currentSessionKey,
    agents,
    isGatewayRunning,
    gatewayRpc,
    showThinking,
  });
  const rows = useMemo(
    () => getOrBuildStaticRowsCacheEntry(currentSessionKey, viewportMessages).rows,
    [currentSessionKey, viewportMessages],
  );
  const executionGraphSlots = useMemo(
    () => buildExecutionGraphSlots(rows, executionGraphs),
    [executionGraphs, rows],
  );
  const pendingAssistantShell = useMemo(
    () => buildPendingAssistantShell(
      approvalStatus,
      runtime.sending,
      runtime.pendingFinal,
      tooling.streamingTools,
      viewportMessages,
    ),
    [approvalStatus, runtime.pendingFinal, runtime.sending, tooling.streamingTools, viewportMessages],
  );

  const liveView = useChatView({
    currentSessionStatus: currentSession.meta.historyStatus,
    rowCount: rows.length,
    sending: runtime.sending,
    refreshing: false,
    mutating: false,
  });
  const autoFollowSignal = buildChatAutoFollowSignal(rows);
  const tailActivityOpen = runtime.sending || runtime.pendingFinal || tooling.streamingTools.length > 0;

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

  const handleLoadOlder = useCallback(() => {
    if (!currentSessionKey) {
      return;
    }
    prepareScopeAnchorRestore(currentSessionKey);
    onLoadOlder();
  }, [currentSessionKey, onLoadOlder, prepareScopeAnchorRestore]);

  const handleJumpToRowKey = useCallback((rowKey?: string) => {
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

  const handleJumpToLatestBottom = useCallback(() => {
    if (!currentSessionKey) {
      return;
    }
    if (viewport.isAtLatest) {
      jumpToBottom();
      return;
    }
    prepareScopeBottomAlign(currentSessionKey);
    onJumpToLatest();
  }, [
    currentSessionKey,
    jumpToBottom,
    onJumpToLatest,
    prepareScopeBottomAlign,
    viewport.isAtLatest,
  ]);

  useLayoutEffect(() => {
    scrollChromeStore.setChromeState({
      visible: !liveView.isEmptyState && !liveView.showBlockingLoading && !liveView.showBlockingError,
      isAtLatest: viewport.isAtLatest,
      jumpActionLabel: jumpToBottomLabel,
    });
    scrollChromeStore.setJumpAction(handleJumpToLatestBottom);
  }, [
    jumpToBottomLabel,
    handleJumpToLatestBottom,
    liveView.isEmptyState,
    liveView.showBlockingError,
    liveView.showBlockingLoading,
    scrollChromeStore,
    viewport.isAtLatest,
  ]);

  useImperativeHandle(ref, () => ({
    prepareCurrentLatestBottomAlign: () => {
      if (!currentSessionKey) {
        return;
      }
      prepareScopeBottomAlign(currentSessionKey);
    },
  }), [currentSessionKey, prepareScopeBottomAlign]);

  return (
    <ChatListSurface
      messagesViewportRef={messagesViewportRef}
      messageContentRef={messageContentRef}
      isEmptyState={liveView.isEmptyState}
      showBlockingLoading={liveView.showBlockingLoading}
      showBlockingError={liveView.showBlockingError}
      errorMessage={errorMessage}
      onPointerDown={handleViewportPointerDown}
      onScroll={handleViewportScroll}
      onTouchMove={handleViewportTouchMove}
      onWheel={handleViewportWheel}
      rows={rows}
      showLoadOlder={viewport.hasMore || viewport.isLoadingMore}
      isLoadingOlder={viewport.isLoadingMore}
      onLoadOlder={handleLoadOlder}
      loadOlderLabel={loadOlderLabel}
      scrollChromeStore={scrollChromeStore}
      showThinking={showThinking}
      streamingTools={tooling.streamingTools}
      assistantAgentId={assistantAgentId}
      assistantAgentName={assistantAgentName}
      assistantAvatarSeed={assistantAvatarSeed}
      assistantAvatarStyle={assistantAvatarStyle}
      userAvatarImageUrl={userAvatarDataUrl}
      executionGraphSlots={executionGraphSlots}
      pendingAssistantShell={pendingAssistantShell}
      onJumpToRowKey={handleJumpToRowKey}
    />
  );
});
