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
import { ActivityIndicator, TypingIndicator, WelcomeScreen } from './ChatStates';

interface ChatListProps {
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  messageContentRef: RefObject<HTMLDivElement | null>;
  isEmptyState: boolean;
  showBlockingLoading: boolean;
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
          `min-h-0 flex-1 overflow-y-auto ${CHAT_LAYOUT_TOKENS.threadViewportPadding}`,
          isEmptyState && 'px-6 py-10 md:px-10 md:py-14',
        )}
        style={{ overflowAnchor: 'none' }}
        onPointerDownCapture={onPointerDown}
        onScroll={onScroll}
        onTouchMoveCapture={onTouchMove}
        onWheelCapture={onWheel}
      >
        <div className={cn(CHAT_LAYOUT_TOKENS.threadRail, isEmptyState && CHAT_LAYOUT_TOKENS.threadEmptyStateRail)}>
          {showBlockingLoading ? (
            <div className="flex h-full items-center justify-center py-20">
              <LoadingSpinner size="lg" />
            </div>
          ) : isEmptyState ? (
            <WelcomeScreen />
          ) : (
            <div
              className="w-full"
            >
              {showLoadOlderButton ? (
                <div
                  data-testid="chat-load-older-rail"
                  className={CHAT_LAYOUT_TOKENS.threadTopAffordanceRail}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 rounded-full border border-border/55 bg-background/82 px-4 text-xs text-muted-foreground shadow-sm backdrop-blur-sm hover:bg-background/92 hover:text-foreground"
                    onClick={onLoadOlder}
                    disabled={isLoadingOlder}
                  >
                    {isLoadingOlder ? <LoadingSpinner size="sm" /> : null}
                    {loadOlderLabel}
                  </Button>
                </div>
              ) : null}
              <div
                ref={messageContentRef}
                data-testid="chat-message-stack"
                className={cn('w-full', CHAT_LAYOUT_TOKENS.threadMessageStackPaddingTop)}
                style={{ overflowAnchor: 'none' }}
              >
              {items.map((item, index) => (
                <div
                  key={item.key}
                  data-index={index}
                  className="w-full pb-6 last:pb-0"
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
              ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {showJumpToBottom ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-36 z-10 px-3 md:bottom-40 md:px-4">
          <div className={CHAT_LAYOUT_TOKENS.stageFloatingRail}>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className={cn(
                'pointer-events-auto h-9 w-9 rounded-full border-border/55 bg-background/88 text-foreground shadow-[0_10px_26px_rgba(15,23,42,0.10)] transition-transform hover:-translate-y-0.5 backdrop-blur-xl supports-[backdrop-filter]:bg-background/78',
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
