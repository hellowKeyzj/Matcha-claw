import type { RefObject } from 'react';
import type { VirtualItem } from '@tanstack/react-virtual';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';
import type { ChatRow } from '../chat-row-model';
import { WelcomeScreen } from './ChatStates';
import { ChatRowItem } from './ChatRowItem';

interface ChatVirtualizerLike {
  getTotalSize: () => number;
  measureElement: (node: Element | null) => void;
}

interface ChatListProps {
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  messageContentRef: RefObject<HTMLDivElement | null>;
  isEmptyState: boolean;
  showBlockingLoading: boolean;
  onPointerDown: () => void;
  onScroll: () => void;
  onTouchMove: () => void;
  onWheel: () => void;
  virtualizer: ChatVirtualizerLike;
  virtualItems: VirtualItem[];
  rows: ChatRow[];
  showThinking: boolean;
  assistantAvatarEmoji: string;
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
  virtualizer,
  virtualItems,
  rows,
  showThinking,
  assistantAvatarEmoji,
  userAvatarImageUrl,
  suppressedToolCardRowKeys,
  onJumpToRowKey,
}: ChatListProps) {
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
              className="relative w-full"
              style={{ height: virtualizer.getTotalSize(), overflowAnchor: 'none' }}
            >
              {virtualItems.map((virtualItem) => {
                const row = rows[virtualItem.index];
                if (!row) {
                  return null;
                }
                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    data-chat-row-key={row.key}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 top-0 w-full pb-4"
                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                  >
                    <ChatRowItem
                      row={row}
                      showThinking={showThinking}
                      assistantAvatarEmoji={assistantAvatarEmoji}
                      userAvatarImageUrl={userAvatarImageUrl}
                      suppressedToolCardRowKeys={suppressedToolCardRowKeys}
                      onJumpToRowKey={onJumpToRowKey}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

