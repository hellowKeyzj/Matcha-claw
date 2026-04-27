import type { RefObject, TouchEventHandler, WheelEventHandler } from 'react';
import { ArrowDown } from 'lucide-react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';
import type { ChatRenderItem } from '../chat-render-items';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';
import { WelcomeScreen } from './ChatStates';
import { ChatRowItem } from './ChatRowItem';
import type { ChatRow } from '../chat-row-model';

interface ChatListProps {
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  messageContentRef: RefObject<HTMLDivElement | null>;
  isEmptyState: boolean;
  showBlockingLoading: boolean;
  onPointerDown: () => void;
  onScroll: () => void;
  onTouchMove: TouchEventHandler<HTMLDivElement>;
  onWheel: WheelEventHandler<HTMLDivElement>;
  items: ChatRenderItem[];
  showHistoryEntry: boolean;
  onViewHistory: () => void;
  viewFullHistoryLabel: string;
  showJumpToBottom: boolean;
  onJumpToBottom: () => void;
  jumpToBottomLabel: string;
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
  showHistoryEntry,
  onViewHistory,
  viewFullHistoryLabel,
  showJumpToBottom,
  onJumpToBottom,
  jumpToBottomLabel,
  showThinking,
  assistantAgentId,
  assistantAgentName,
  assistantAvatarSeed,
  assistantAvatarStyle,
  userAvatarImageUrl,
  suppressedToolCardRowKeys,
  onJumpToRowKey,
}: ChatListProps) {
  const getRowDataAttributes = (row: ChatRow) => {
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
    <div className="relative min-h-0 flex-1">
      <div
        ref={messagesViewportRef}
        className={cn(
          `h-full overflow-y-auto ${CHAT_LAYOUT_TOKENS.threadViewportPadding}`,
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
              ref={messageContentRef}
              className="w-full"
              style={{ overflowAnchor: 'none' }}
            >
              {showHistoryEntry ? (
                <div className="mb-4 flex justify-center">
                  <button
                    type="button"
                    className="text-sm font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:text-primary"
                    onClick={onViewHistory}
                  >
                    {viewFullHistoryLabel}
                  </button>
                </div>
              ) : null}
              {items.map((item, index) => (
                <div
                  key={item.key}
                  data-index={index}
                  className="w-full pb-4"
                >
                  <div
                    {...getRowDataAttributes(item.row)}
                    className="w-full"
                  >
                    <ChatRowItem
                      row={item.row}
                      showThinking={showThinking}
                      assistantAgentId={assistantAgentId}
                      assistantAgentName={assistantAgentName}
                      assistantAvatarSeed={assistantAvatarSeed}
                      assistantAvatarStyle={assistantAvatarStyle}
                      userAvatarImageUrl={userAvatarImageUrl}
                      suppressedToolCardRowKeys={suppressedToolCardRowKeys}
                      onJumpToRowKey={onJumpToRowKey}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {showJumpToBottom ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="absolute bottom-4 right-4 z-10 h-10 w-10 border-border/70 bg-background/95 text-foreground shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80"
          onClick={onJumpToBottom}
          aria-label={jumpToBottomLabel}
          title={jumpToBottomLabel}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}
