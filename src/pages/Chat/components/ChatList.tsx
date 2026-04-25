import type { RefObject, TouchEventHandler, WheelEventHandler } from 'react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';
import type { ChatRenderItem } from '../chat-render-items';
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
          'h-full overflow-y-auto px-4 py-4 md:px-6',
          isEmptyState && 'px-6 py-10 md:px-10 md:py-14',
        )}
        style={{ overflowAnchor: 'none' }}
        onPointerDownCapture={onPointerDown}
        onScroll={onScroll}
        onTouchMoveCapture={onTouchMove}
        onWheelCapture={onWheel}
      >
        <div className={cn('mx-auto max-w-4xl', isEmptyState && 'flex min-h-full max-w-5xl items-start justify-center')}>
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
    </div>
  );
}
