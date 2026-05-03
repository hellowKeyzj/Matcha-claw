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
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';
import { buildChatAutoFollowSignal } from '../chat-auto-follow';
import { createChatScrollChromeStore, type ChatScrollChromeStore } from '../chat-scroll-chrome-store';
import {
  applyAssistantPresentationToRows,
  type ChatAssistantCatalogAgent,
  type ChatAssistantPresentation,
  type ChatExecutionGraphRow,
  type ChatMessageRow,
  type ChatPendingAssistantRow,
  type ChatRow,
  type ChatTaskCompletionRow,
  type ChatToolActivityRow,
} from '../chat-row-model';
import { ChatMessage } from '../ChatMessage';
import { ChatToolActivityRowView } from '../ChatToolActivityRow';
import { ExecutionGraphCard } from '../ExecutionGraphCard';
import { PendingAssistantShell } from '../pending-assistant-shell';
import { useChatScroll } from '../useChatScroll';
import { useChatView } from '../useChatView';
import { FailureScreen } from './ChatStates';
import type {
  ApprovalStatus,
  ChatSessionRecord,
} from '@/stores/chat';
import { selectViewportRows } from '@/stores/chat/store-state-helpers';

const CHAT_BOTTOM_FOLLOW_THRESHOLD_PX = 96;

interface ThreadAgent {
  id: string;
  name?: string;
  avatarSeed?: string;
  avatarStyle?: ChatAssistantPresentation['avatarStyle'];
}

export interface ChatListHandle {
  prepareCurrentLatestBottomAlign: () => void;
}

export interface ChatListProps {
  isActive: boolean;
  currentSessionKey: string;
  currentSession: ChatSessionRecord;
  approvalStatus: ApprovalStatus;
  agents: ThreadAgent[];
  isGatewayRunning: boolean;
  errorMessage: string | null;
  showThinking: boolean;
  userAvatarDataUrl: string | null;
  onLoadOlder: () => void;
  loadOlderLabel: string;
  onJumpToLatest: () => void;
  jumpToBottomLabel: string;
  defaultAssistant: ChatAssistantPresentation | null;
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
  rows: ChatRow[];
  showLoadOlder: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
  loadOlderLabel: string;
  scrollChromeStore: ChatScrollChromeStore;
  showThinking: boolean;
  userAvatarImageUrl: string | null;
  onJumpToRowKey: (rowKey?: string) => void;
}

type ChatListContentProps = Omit<
  ChatListSurfaceProps,
  'messagesViewportRef' | 'messageContentRef' | 'onPointerDown' | 'onScroll' | 'onTouchMove' | 'onWheel' | 'scrollChromeStore'
>;

function getMessageDataAttributes(row: ChatRow) {
  return {
    'data-chat-row-key': row.key,
    'data-chat-row-kind': row.kind,
    'data-chat-message-id': row.kind === 'message' ? (row.messageId ?? undefined) : undefined,
    'data-chat-message-timestamp': typeof row.createdAt === 'number' ? String(row.createdAt) : undefined,
    'data-chat-assistant-turn-key': row.role === 'assistant' ? (row.assistantTurnKey ?? undefined) : undefined,
    'data-chat-assistant-lane-key': row.role === 'assistant' ? (row.assistantLaneKey ?? undefined) : undefined,
    'data-chat-assistant-agent-id': row.role === 'assistant' ? (row.assistantLaneAgentId ?? undefined) : undefined,
  };
}

function SystemInfoRow({ row }: { row: ChatTaskCompletionRow | ChatRow }) {
  const text = row.text.trim()
    || (row.kind === 'task-completion'
      ? [row.taskLabel, row.statusLabel, row.result].filter(Boolean).join(' · ')
      : '');
  if (!text) {
    return null;
  }
  return (
    <div className="flex justify-center">
      <div className="max-w-[42rem] rounded-[16px] border border-border/40 bg-background/68 px-3 py-2 text-[12px] text-muted-foreground shadow-sm backdrop-blur-sm">
        {text}
      </div>
    </div>
  );
}

function renderChatRow(input: {
  row: ChatRow;
  showThinking: boolean;
  userAvatarImageUrl: string | null;
  onJumpToRowKey: (rowKey?: string) => void;
}) {
  if (input.row.kind === 'tool-activity') {
    return (
      <ChatToolActivityRowView
        row={input.row as ChatToolActivityRow}
        userAvatarImageUrl={input.userAvatarImageUrl}
      />
    );
  }
  if (input.row.kind === 'execution-graph') {
    const row = input.row as ChatExecutionGraphRow;
    return (
      <div
        data-testid="chat-execution-graph-rail"
        className={cn(
          CHAT_LAYOUT_TOKENS.messageShell,
          CHAT_LAYOUT_TOKENS.messageShellAssistantColumns,
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
          )}
        >
          <ExecutionGraphCard
            agentLabel={row.agentLabel}
            sessionLabel={row.sessionLabel}
            steps={[...row.steps]}
            active={row.active}
            triggerRowKey={row.triggerRowKey}
            replyRowKey={row.replyRowKey}
            onJumpToRowKey={input.onJumpToRowKey}
          />
        </div>
      </div>
    );
  }
  if (input.row.kind === 'pending-assistant') {
    const row = input.row as ChatPendingAssistantRow;
    return (
      <PendingAssistantShell
        state={row.pendingState}
        assistantAgentId={row.assistantPresentation?.agentId}
        assistantAgentName={row.assistantPresentation?.agentName}
        assistantAvatarSeed={row.assistantPresentation?.avatarSeed}
        assistantAvatarStyle={row.assistantPresentation?.avatarStyle}
        userAvatarImageUrl={input.userAvatarImageUrl}
      />
    );
  }
  if (input.row.kind === 'task-completion' || input.row.kind === 'system') {
    return <SystemInfoRow row={input.row} />;
  }
  return (
    <ChatMessage
      row={input.row as ChatMessageRow}
      showThinking={input.showThinking}
      userAvatarImageUrl={input.userAvatarImageUrl}
    />
  );
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
  userAvatarImageUrl,
  onJumpToRowKey,
}: ChatListContentProps) {
  const showLoadOlderButton = showLoadOlder || isLoadingOlder;

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
          {rows.map((row, index) => (
            <div key={row.key}>
              <div
                data-index={index}
                className={CHAT_LAYOUT_TOKENS.threadMessageRowSpacing}
              >
                <div
                  {...getMessageDataAttributes(row)}
                  className="w-full"
                >
                  {renderChatRow({
                    row,
                    showThinking,
                    userAvatarImageUrl,
                    onJumpToRowKey,
                  })}
                </div>
              </div>
            </div>
          ))}
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
  userAvatarImageUrl,
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
              userAvatarImageUrl={userAvatarImageUrl}
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
    errorMessage,
    showThinking,
    userAvatarDataUrl,
    onLoadOlder,
    loadOlderLabel,
    onJumpToLatest,
    jumpToBottomLabel,
    defaultAssistant,
  },
  ref,
) {
  void approvalStatus;

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

  const assistantCatalogAgents = useMemo<ChatAssistantCatalogAgent[]>(
    () => agents.map((agent) => ({
      id: agent.id,
      agentName: agent.name,
      avatarSeed: agent.avatarSeed,
      avatarStyle: agent.avatarStyle,
    })),
    [agents],
  );
  const viewportRows = useMemo(
    () => selectViewportRows(currentSession),
    [currentSession],
  );
  const rows = useMemo(
    () => applyAssistantPresentationToRows({
      rows: viewportRows,
      agents: assistantCatalogAgents,
      defaultAssistant,
    }),
    [assistantCatalogAgents, defaultAssistant, viewportRows],
  );

  const liveView = useChatView({
    currentSessionStatus: currentSession.meta.historyStatus,
    rowCount: rows.length,
    sending: runtime.sending,
    refreshing: false,
    mutating: false,
  });
  const autoFollowSignal = buildChatAutoFollowSignal(rows);
  const tailActivityOpen = runtime.sending || runtime.pendingFinal || rows.some((row) => row.kind === 'pending-assistant');

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
      userAvatarImageUrl={userAvatarDataUrl}
      onJumpToRowKey={handleJumpToRowKey}
    />
  );
});
