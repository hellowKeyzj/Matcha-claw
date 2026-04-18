import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useVirtualizer, type VirtualItem as TanstackVirtualItem } from '@tanstack/react-virtual';
import type { ChatRow } from './chat-row-model';
import { useChatScroll } from './useChatScroll';
import { useChatWindowExpand, type RenderWindowExpandCommand } from './useWindowing';

const CHAT_STICKY_BOTTOM_THRESHOLD_PX = 120;
const CHAT_VIRTUAL_ESTIMATE_HEIGHT_PX = 156;
const CHAT_VIRTUAL_OVERSCAN = 16;
const CHAT_VIRTUAL_TEXT_UNITS_PER_LINE = 30;
const CHAT_VIRTUAL_TEXT_LINE_HEIGHT_PX = 22;
const CHAT_VIRTUAL_MESSAGE_BASE_HEIGHT_PX = 94;
const CHAT_VIRTUAL_ROW_MIN_HEIGHT_PX = 88;
const CHAT_VIRTUAL_ROW_MAX_HEIGHT_PX = 3_200;
const CHAT_VIRTUAL_IMAGE_BLOCK_HEIGHT_PX = 184;
const CHAT_VIRTUAL_TOOL_BLOCK_HEIGHT_PX = 78;
const CHAT_VIRTUAL_TEXT_LINE_CLAMP = 38;
const CHAT_VIRTUAL_MARKDOWN_LIST_LINE_BONUS_PX = 7;
const CHAT_VIRTUAL_MARKDOWN_CODE_FENCE_BONUS_PX = 46;
const CHAT_VIRTUAL_MARKDOWN_QUOTE_LINE_BONUS_PX = 4;
const CHAT_VIRTUAL_MARKDOWN_TABLE_LINE_BONUS_PX = 6;
const CHAT_VIRTUAL_CJK_OR_FULLWIDTH_RE = /[\p{Unified_Ideograph}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/u;

function clampHeight(value: number): number {
  return Math.min(CHAT_VIRTUAL_ROW_MAX_HEIGHT_PX, Math.max(CHAT_VIRTUAL_ROW_MIN_HEIGHT_PX, value));
}

function estimateTextDisplayUnits(text: string): number {
  if (!text) {
    return 0;
  }
  let units = 0;
  for (const char of text) {
    // CJK/full-width glyphs consume visibly wider inline space than latin chars.
    units += CHAT_VIRTUAL_CJK_OR_FULLWIDTH_RE.test(char) ? 1.9 : 1;
  }
  return units;
}

function inspectMessageContent(content: unknown): {
  textDisplayUnits: number;
  logicalLineCount: number;
  markdownListLineCount: number;
  markdownCodeFenceCount: number;
  markdownQuoteLineCount: number;
  markdownTableLineCount: number;
  imageBlocks: number;
  toolBlocks: number;
} {
  const inspectText = (text: string) => {
    const logicalLineCount = Math.max(1, text.split(/\r?\n/).length);
    const markdownListLineCount = (text.match(/^\s*(?:[-*+]|\d+\.)\s+/gm) ?? []).length;
    const markdownCodeFenceCount = (text.match(/^\s*```/gm) ?? []).length;
    const markdownQuoteLineCount = (text.match(/^\s*>\s+/gm) ?? []).length;
    const markdownTableLineCount = (text.match(/^\s*\|.+\|\s*$/gm) ?? []).length;
    return {
      textDisplayUnits: estimateTextDisplayUnits(text),
      logicalLineCount,
      markdownListLineCount,
      markdownCodeFenceCount,
      markdownQuoteLineCount,
      markdownTableLineCount,
    };
  };

  if (typeof content === 'string') {
    const textMetrics = inspectText(content);
    return {
      ...textMetrics,
      imageBlocks: 0,
      toolBlocks: 0,
    };
  }
  if (!Array.isArray(content)) {
    return {
      textDisplayUnits: 0,
      logicalLineCount: 1,
      markdownListLineCount: 0,
      markdownCodeFenceCount: 0,
      markdownQuoteLineCount: 0,
      markdownTableLineCount: 0,
      imageBlocks: 0,
      toolBlocks: 0,
    };
  }

  let textDisplayUnits = 0;
  let logicalLineCount = 0;
  let markdownListLineCount = 0;
  let markdownCodeFenceCount = 0;
  let markdownQuoteLineCount = 0;
  let markdownTableLineCount = 0;
  let imageBlocks = 0;
  let toolBlocks = 0;

  for (const item of content as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const type = typeof item.type === 'string' ? item.type : '';
    if (type === 'text' && typeof item.text === 'string') {
      const textMetrics = inspectText(item.text);
      textDisplayUnits += textMetrics.textDisplayUnits;
      logicalLineCount += textMetrics.logicalLineCount;
      markdownListLineCount += textMetrics.markdownListLineCount;
      markdownCodeFenceCount += textMetrics.markdownCodeFenceCount;
      markdownQuoteLineCount += textMetrics.markdownQuoteLineCount;
      markdownTableLineCount += textMetrics.markdownTableLineCount;
      continue;
    }
    if (type === 'thinking' && typeof item.thinking === 'string') {
      const textMetrics = inspectText(item.thinking);
      textDisplayUnits += textMetrics.textDisplayUnits;
      logicalLineCount += textMetrics.logicalLineCount;
      markdownListLineCount += textMetrics.markdownListLineCount;
      markdownCodeFenceCount += textMetrics.markdownCodeFenceCount;
      markdownQuoteLineCount += textMetrics.markdownQuoteLineCount;
      markdownTableLineCount += textMetrics.markdownTableLineCount;
      continue;
    }
    if (type === 'image') {
      imageBlocks += 1;
      continue;
    }
    if (type === 'tool_use' || type === 'toolCall' || type === 'tool_result' || type === 'toolResult') {
      toolBlocks += 1;
      continue;
    }
    if (typeof item.text === 'string') {
      const textMetrics = inspectText(item.text);
      textDisplayUnits += textMetrics.textDisplayUnits;
      logicalLineCount += textMetrics.logicalLineCount;
      markdownListLineCount += textMetrics.markdownListLineCount;
      markdownCodeFenceCount += textMetrics.markdownCodeFenceCount;
      markdownQuoteLineCount += textMetrics.markdownQuoteLineCount;
      markdownTableLineCount += textMetrics.markdownTableLineCount;
    }
  }

  return {
    textDisplayUnits,
    logicalLineCount: Math.max(1, logicalLineCount),
    markdownListLineCount,
    markdownCodeFenceCount,
    markdownQuoteLineCount,
    markdownTableLineCount,
    imageBlocks,
    toolBlocks,
  };
}

export function estimateMessageRowHeight(content: unknown, extraBaseHeight = 0): number {
  const {
    textDisplayUnits,
    logicalLineCount,
    markdownListLineCount,
    markdownCodeFenceCount,
    markdownQuoteLineCount,
    markdownTableLineCount,
    imageBlocks,
    toolBlocks,
  } = inspectMessageContent(content);
  const textLinesByWidth = Math.ceil(textDisplayUnits / CHAT_VIRTUAL_TEXT_UNITS_PER_LINE);
  const textLines = Math.max(1, textLinesByWidth, logicalLineCount);
  const textHeight = Math.min(CHAT_VIRTUAL_TEXT_LINE_CLAMP, textLines) * CHAT_VIRTUAL_TEXT_LINE_HEIGHT_PX;
  const markdownStructureBonus = (
    (markdownListLineCount * CHAT_VIRTUAL_MARKDOWN_LIST_LINE_BONUS_PX)
    + (markdownCodeFenceCount * CHAT_VIRTUAL_MARKDOWN_CODE_FENCE_BONUS_PX)
    + (markdownQuoteLineCount * CHAT_VIRTUAL_MARKDOWN_QUOTE_LINE_BONUS_PX)
    + (markdownTableLineCount * CHAT_VIRTUAL_MARKDOWN_TABLE_LINE_BONUS_PX)
  );
  const estimated = (
    CHAT_VIRTUAL_MESSAGE_BASE_HEIGHT_PX
    + extraBaseHeight
    + textHeight
    + markdownStructureBonus
    + (imageBlocks * CHAT_VIRTUAL_IMAGE_BLOCK_HEIGHT_PX)
    + (toolBlocks * CHAT_VIRTUAL_TOOL_BLOCK_HEIGHT_PX)
  );
  return clampHeight(estimated);
}

function estimateChatRowHeight(row: ChatRow): number {
  if (row.kind === 'execution_graph') {
    return 284;
  }
  if (row.kind === 'activity') {
    return 104;
  }
  if (row.kind === 'typing') {
    return 96;
  }
  if (row.kind === 'streaming') {
    return estimateMessageRowHeight(
      row.message.content,
      row.streamingTools.length > 0 ? 64 : 40,
    );
  }
  return estimateMessageRowHeight(row.message.content);
}

interface RowHeightEstimateCacheEntry {
  kind: ChatRow['kind'];
  contentRef: unknown;
  streamingToolCount: number;
  value: number;
}

interface UseChatListCtlInput {
  currentSessionKey: string;
  chatRows: ChatRow[];
  hasOlderRenderableRows: boolean;
  runtimeRowsCostMs: number;
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  messageContentRef: RefObject<HTMLDivElement | null>;
  markScrollActivity: () => void;
  increaseRenderableWindowLimit: (sessionKey: string, command: RenderWindowExpandCommand) => void;
}

export function useChatListCtl(input: UseChatListCtlInput) {
  const {
    currentSessionKey,
    chatRows,
    hasOlderRenderableRows,
    runtimeRowsCostMs,
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
  const rowHeightEstimateCacheRef = useRef<Map<string, RowHeightEstimateCacheEntry>>(new Map());

  useEffect(() => {
    rowHeightEstimateCacheRef.current.clear();
  }, [currentSessionKey]);

  const estimateRowHeight = useCallback((row: ChatRow): number => {
    const contentRef = (row.kind === 'message' || row.kind === 'streaming')
      ? row.message.content
      : null;
    const streamingToolCount = row.kind === 'streaming' ? row.streamingTools.length : 0;
    const cached = rowHeightEstimateCacheRef.current.get(row.key);
    if (
      cached
      && cached.kind === row.kind
      && cached.contentRef === contentRef
      && cached.streamingToolCount === streamingToolCount
    ) {
      return cached.value;
    }

    const nextValue = estimateChatRowHeight(row);
    rowHeightEstimateCacheRef.current.set(row.key, {
      kind: row.kind,
      contentRef,
      streamingToolCount,
      value: nextValue,
    });
    return nextValue;
  }, []);

  const messageVirtualizer = useVirtualizer({
    count: chatRows.length,
    getScrollElement: () => messagesViewportRef.current,
    estimateSize: (index) => {
      const row = chatRows[index];
      if (!row) {
        return CHAT_VIRTUAL_ESTIMATE_HEIGHT_PX;
      }
      return estimateRowHeight(row);
    },
    overscan: CHAT_VIRTUAL_OVERSCAN,
    getItemKey: (index) => chatRows[index]?.key ?? `idx:${index}`,
    onChange: (instance) => {
      handleVirtualizerChange(instance);
    },
    useAnimationFrameWithResizeObserver: true,
  });

  useEffect(() => {
    messageVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
      item: TanstackVirtualItem,
      delta: number,
      instance,
    ) => {
      if (scrollState.command.type !== 'none') {
        return false;
      }
      if (scrollState.isNearBottom) {
        return false;
      }
      if (!Number.isFinite(delta) || Math.abs(delta) <= 0.5) {
        return false;
      }
      const viewport = messagesViewportRef.current;
      if (!viewport) {
        return false;
      }
      const viewportTop = instance.scrollOffset ?? viewport.scrollTop;
      return item.end <= (viewportTop + 1);
    };
    return () => {
      messageVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [messageVirtualizer, messagesViewportRef, scrollState.command.type, scrollState.isNearBottom]);

  const virtualMessageItems = messageVirtualizer.getVirtualItems().filter((item) => (
    item.index >= 0 && item.index < chatRows.length
  ));

  const {
    handleViewportScrollWithWindowing,
    handleViewportWheelWithWindowing,
  } = useChatWindowExpand({
    currentSessionKey,
    chatRows,
    hasOlderRenderableRows,
    messageVirtualizer,
    messagesViewportRef,
    scrollMode: scrollState.mode,
    scrollCommandType: scrollState.command.type,
    runtimeRowsCostMs,
    handleViewportScroll,
    markScrollActivity,
    increaseRenderableWindowLimit,
  });

  const handleViewportWheelCombined = useCallback(() => {
    handleViewportWheel();
    handleViewportWheelWithWindowing();
  }, [handleViewportWheel, handleViewportWheelWithWindowing]);

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
    handleViewportWheel: handleViewportWheelCombined,
    handleViewportScrollWithWindowing,
    messageVirtualizer,
    virtualMessageItems,
    scrollToRowKey,
  };
}
