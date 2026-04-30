import type { RefObject, TouchEventHandler, WheelEventHandler } from 'react';
import { ArrowDown } from 'lucide-react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';
import { ChatMessage } from '../ChatMessage';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';
import { ExecutionGraphCard } from '../ExecutionGraphCard';
import type { ViewportListItem } from '../viewport-list-items';
import { ActivityIndicator, FailureScreen, TypingIndicator, WelcomeScreen } from './ChatStates';

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
  items: ViewportListItem[];
  showLoadOlder: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
  loadOlderLabel: string;
  showJumpToBottom: boolean;
  onJumpAction: () => void;
  jumpActionLabel: string;
  showThinking: boolean;
  assistantAgentId: string;
  assistantAgentName: string;
  assistantAvatarSeed?: string;
  assistantAvatarStyle?: AgentAvatarStyle;
  userAvatarImageUrl: string | null;
  suppressedToolCardRowKeys: Set<string>;
  onJumpToRowKey: (rowKey?: string) => void;
}

export function ChatList({
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
  items,
  showLoadOlder,
  isLoadingOlder,
  onLoadOlder,
  loadOlderLabel,
  showJumpToBottom,
  onJumpAction,
  jumpActionLabel,
  showThinking,
  assistantAgentId,
  assistantAgentName,
  assistantAvatarSeed,
  assistantAvatarStyle,
  userAvatarImageUrl,
  suppressedToolCardRowKeys,
  onJumpToRowKey,
}: ChatListProps) {
  const showLoadOlderButton = showLoadOlder || isLoadingOlder;

  const getItemDataAttributes = (item: ViewportListItem) => {
    if (item.kind === 'execution_graph') {
      return {
        'data-chat-row-key': item.key,
        'data-chat-row-kind': item.kind,
      };
    }

    const { row } = item;
    if (row.kind !== 'message') {
      return {
        'data-chat-row-key': row.key,
        'data-chat-row-kind': row.kind,
      };
    }

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
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={messagesViewportRef}
        className={cn(
          `min-h-0 flex-1 overflow-y-auto chat-scroll-sync-viewport ${CHAT_LAYOUT_TOKENS.threadViewportPadding}`,
        )}
        style={{ overflowAnchor: 'none', scrollbarGutter: 'stable' }}
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
            {showBlockingLoading ? (
              <div className="flex min-h-[40vh] items-center justify-center py-20">
                <LoadingSpinner size="lg" />
              </div>
            ) : showBlockingError ? (
              <FailureScreen message={errorMessage} />
            ) : (
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
                  items.map((item, index) => (
                    <div
                      key={item.key}
                      data-index={index}
                      className="w-full pb-5 last:pb-0 md:pb-5"
                    >
                      <div
                        {...getItemDataAttributes(item)}
                        className="w-full"
                      >
                        {item.kind === 'execution_graph' ? (
                          <ExecutionGraphCard
                            agentLabel={item.graph.agentLabel}
                            sessionLabel={item.graph.sessionLabel}
                            steps={item.graph.steps}
                            active={item.graph.active}
                            onJumpToTrigger={() => onJumpToRowKey(item.graph.triggerMessageKey)}
                            onJumpToReply={() => onJumpToRowKey(item.graph.replyMessageKey)}
                          />
                        ) : item.kind === 'message' ? (
                          <ChatMessage
                            message={item.row.message}
                            showThinking={showThinking}
                            isStreaming={item.row.isStreaming}
                            streamingTools={item.row.streamingTools}
                            suppressToolCards={suppressedToolCardRowKeys.has(item.row.key)}
                            assistantAgentId={assistantAgentId}
                            assistantAgentName={assistantAgentName}
                            assistantAvatarSeed={assistantAvatarSeed}
                            assistantAvatarStyle={assistantAvatarStyle}
                            userAvatarImageUrl={userAvatarImageUrl}
                          />
                        ) : item.kind === 'activity' ? (
                          <ActivityIndicator />
                        ) : (
                          <TypingIndicator />
                        )}
                      </div>
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {showJumpToBottom ? (
        <div
          className={CHAT_LAYOUT_TOKENS.stageJumpToBottomRail}
          style={{ bottom: 'calc(var(--chat-composer-safe-offset, 11rem) + 0.75rem)' }}
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
              onClick={onJumpAction}
              aria-label={jumpActionLabel}
              title={jumpActionLabel}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
