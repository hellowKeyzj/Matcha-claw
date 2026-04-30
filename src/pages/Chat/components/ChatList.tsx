import { memo, useSyncExternalStore, type RefObject, type TouchEventHandler, type WheelEventHandler } from 'react';
import { ArrowDown } from 'lucide-react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';
import type { ChatScrollChromeStore } from '../chat-scroll-chrome-store';
import { ChatMessage } from '../ChatMessage';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';
import type { ChatMessageRow } from '../chat-row-model';
import type {
  ChatExecutionGraphSlots,
  PendingAssistantShell as PendingAssistantShellState,
} from '../chat-render-model';
import { ExecutionGraphCard } from '../ExecutionGraphCard';
import { PendingAssistantShell } from '../pending-assistant-shell';
import type { ToolStatus } from '@/stores/chat';
import { FailureScreen, WelcomeScreen } from './ChatStates';

interface ChatListProps {
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

interface ChatListContentProps {
  isEmptyState: boolean;
  showBlockingLoading: boolean;
  showBlockingError: boolean;
  errorMessage: string | null;
  rows: ChatMessageRow[];
  showLoadOlder: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
  loadOlderLabel: string;
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

const EMPTY_STREAMING_TOOLS: ToolStatus[] = [];

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
            className="h-8 rounded-full border border-border/45 bg-background/86 px-4 text-xs text-muted-foreground shadow-sm backdrop-blur-sm hover:bg-background/94 hover:text-foreground"
            onClick={onLoadOlder}
            disabled={isLoadingOlder}
          >
            {isLoadingOlder ? <LoadingSpinner size="sm" /> : null}
            {loadOlderLabel}
          </Button>
        </div>
      ) : null}

      {isEmptyState ? (
        <WelcomeScreen />
      ) : (
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
      )}
    </>
  );
});

interface ChatScrollChromeProps {
  scrollChromeStore: ChatScrollChromeStore;
  showLoadOlderButton: boolean;
}

const ChatScrollChrome = memo(function ChatScrollChrome({
  scrollChromeStore,
  showLoadOlderButton,
}: ChatScrollChromeProps) {
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

export const ChatList = memo(function ChatList({
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
}: ChatListProps) {
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
