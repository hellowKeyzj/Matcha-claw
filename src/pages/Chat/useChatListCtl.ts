import { useCallback, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatRow } from './chat-row-model';
import { useChatScroll } from './useChatScroll';
import { useChatWindowExpand } from './useWindowing';

const CHAT_STICKY_BOTTOM_THRESHOLD_PX = 120;
const CHAT_VIRTUAL_ESTIMATE_HEIGHT_PX = 168;
const CHAT_VIRTUAL_OVERSCAN = 8;

interface UseChatListCtlInput {
  currentSessionKey: string;
  chatRows: ChatRow[];
  hasOlderRenderableRows: boolean;
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  messageContentRef: RefObject<HTMLDivElement | null>;
  markScrollActivity: () => void;
  increaseRenderableWindowLimit: (sessionKey: string, step?: number) => void;
}

export function useChatListCtl(input: UseChatListCtlInput) {
  const {
    currentSessionKey,
    chatRows,
    hasOlderRenderableRows,
    messagesViewportRef,
    messageContentRef,
    markScrollActivity,
    increaseRenderableWindowLimit,
  } = input;

  const {
    handleViewportPointerDown,
    handleViewportScroll,
    handleViewportTouchMove,
    handleViewportWheel,
    handleVirtualizerChange,
    scrollState,
  } = useChatScroll({
    currentSessionKey,
    rows: chatRows,
    viewportRef: messagesViewportRef,
    contentRef: messageContentRef,
    stickyBottomThresholdPx: CHAT_STICKY_BOTTOM_THRESHOLD_PX,
  });

  const messageVirtualizer = useVirtualizer({
    count: chatRows.length,
    getScrollElement: () => messagesViewportRef.current,
    estimateSize: () => CHAT_VIRTUAL_ESTIMATE_HEIGHT_PX,
    overscan: CHAT_VIRTUAL_OVERSCAN,
    getItemKey: (index) => chatRows[index]?.key ?? `idx:${index}`,
    onChange: (instance) => {
      handleVirtualizerChange(instance);
    },
  });
  const virtualMessageItems = messageVirtualizer.getVirtualItems();

  const { handleViewportScrollWithWindowing } = useChatWindowExpand({
    currentSessionKey,
    chatRows,
    hasOlderRenderableRows,
    messageVirtualizer,
    messagesViewportRef,
    scrollMode: scrollState.mode,
    scrollCommandType: scrollState.command.type,
    handleViewportScroll,
    markScrollActivity,
    increaseRenderableWindowLimit,
  });

  const scrollToRowKey = useCallback((rowKey?: string) => {
    if (!rowKey) {
      return;
    }
    const targetIndex = chatRows.findIndex((row) => row.key === rowKey);
    if (targetIndex < 0) {
      return;
    }
    messageVirtualizer.scrollToIndex(targetIndex, { align: 'start' });
  }, [chatRows, messageVirtualizer]);

  return {
    handleViewportPointerDown,
    handleViewportTouchMove,
    handleViewportWheel,
    handleViewportScrollWithWindowing,
    messageVirtualizer,
    virtualMessageItems,
    scrollToRowKey,
  };
}

