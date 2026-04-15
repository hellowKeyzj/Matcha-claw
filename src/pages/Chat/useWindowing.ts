import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { isRenderableChatMessage, type ChatRow } from './chat-row-model';

const CHAT_FIRST_PAINT_RENDERABLE_LIMIT = 8;
const SESSION_RENDER_WINDOW_MAX_SESSIONS = 40;
const SESSION_RENDER_WINDOW_EXPAND_STEP = 24;
const SESSION_RENDER_WINDOW_TOP_THRESHOLD_PX = 12;
const SESSION_RENDER_WINDOW_REARM_THRESHOLD_PX = 180;
const SESSION_RENDER_WINDOW_EXPAND_DEBOUNCE_MS = 140;

const globalSessionRenderableWindowLimit = new Map<string, number>();
const globalRenderWindowSliceCache = new WeakMap<RawMessage[], Map<number, RenderWindowSliceResult>>();

interface RenderWindowSliceResult {
  messages: RawMessage[];
  hasOlderRenderableMessages: boolean;
}

type PrependWindowTxn =
  | { phase: 'idle' }
  | {
    phase: 'scheduled';
    id: number;
    sessionKey: string;
    rowKey: string;
    rowOffsetPx: number;
    previousScrollTop: number;
    previousScrollHeight: number;
  };

interface UseChatWindowSliceInput {
  currentSessionKey: string;
  messages: RawMessage[];
}

interface UseChatWindowSliceResult {
  rowSourceMessages: RawMessage[];
  hasOlderRenderableRows: boolean;
  rowSliceCostMs: number;
  increaseRenderableWindowLimit: (sessionKey: string, step?: number) => void;
}

interface ChatVirtualItemLike {
  index: number;
  start: number;
  size: number;
}

interface ChatVirtualizerLike {
  getVirtualItems: () => ChatVirtualItemLike[];
  scrollToIndex: (index: number, options?: { align?: 'start' | 'center' | 'end' | 'auto' }) => void;
}

interface UseChatWindowExpandInput {
  currentSessionKey: string;
  chatRows: ChatRow[];
  hasOlderRenderableRows: boolean;
  messageVirtualizer: ChatVirtualizerLike;
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  scrollMode: string;
  scrollCommandType: string;
  handleViewportScroll: () => void;
  markScrollActivity: () => void;
  increaseRenderableWindowLimit: (sessionKey: string, step?: number) => void;
}

interface UseChatWindowExpandResult {
  handleViewportScrollWithWindowing: () => void;
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function getSessionRenderableWindowLimit(sessionKey: string): number {
  const cached = globalSessionRenderableWindowLimit.get(sessionKey);
  if (typeof cached === 'number' && Number.isFinite(cached) && cached >= CHAT_FIRST_PAINT_RENDERABLE_LIMIT) {
    return cached;
  }
  return CHAT_FIRST_PAINT_RENDERABLE_LIMIT;
}

function updateSessionRenderableWindowLimit(sessionKey: string, nextLimit: number): void {
  const normalized = Math.max(CHAT_FIRST_PAINT_RENDERABLE_LIMIT, Math.floor(nextLimit));
  if (globalSessionRenderableWindowLimit.has(sessionKey)) {
    globalSessionRenderableWindowLimit.delete(sessionKey);
  }
  globalSessionRenderableWindowLimit.set(sessionKey, normalized);
  while (globalSessionRenderableWindowLimit.size > SESSION_RENDER_WINDOW_MAX_SESSIONS) {
    const oldestKey = globalSessionRenderableWindowLimit.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    globalSessionRenderableWindowLimit.delete(oldestKey);
  }
}

export function sliceMessagesForFirstPaint(
  messages: RawMessage[],
  renderableLimit: number,
): RenderWindowSliceResult {
  if (messages.length === 0) {
    return { messages, hasOlderRenderableMessages: false };
  }
  let renderableCount = 0;
  let startIndex = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isRenderableChatMessage(messages[index])) {
      continue;
    }
    renderableCount += 1;
    if (renderableCount >= renderableLimit) {
      startIndex = index;
      break;
    }
  }
  if (startIndex <= 0) {
    return { messages, hasOlderRenderableMessages: false };
  }
  let hasOlderRenderableMessages = false;
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    if (!isRenderableChatMessage(messages[index])) {
      continue;
    }
    hasOlderRenderableMessages = true;
    break;
  }
  return {
    messages: messages.slice(startIndex),
    hasOlderRenderableMessages,
  };
}

function getCachedRenderWindowSlice(
  messages: RawMessage[],
  renderableLimit: number,
): RenderWindowSliceResult {
  if (messages.length === 0) {
    return { messages, hasOlderRenderableMessages: false };
  }
  const normalizedLimit = Math.max(1, Math.floor(renderableLimit));
  const byLimit = globalRenderWindowSliceCache.get(messages);
  const cached = byLimit?.get(normalizedLimit);
  if (cached) {
    return cached;
  }
  const computed = sliceMessagesForFirstPaint(messages, normalizedLimit);
  if (byLimit) {
    byLimit.set(normalizedLimit, computed);
  } else {
    globalRenderWindowSliceCache.set(messages, new Map([[normalizedLimit, computed]]));
  }
  return computed;
}

export function useChatWindowSlice(
  input: UseChatWindowSliceInput,
): UseChatWindowSliceResult {
  const {
    currentSessionKey,
    messages,
  } = input;
  const [, setRenderWindowVersion] = useState(0);
  const [initializedSessionKey, setInitializedSessionKey] = useState<string | null>(null);

  const isSessionWindowBudgetFirstPass = initializedSessionKey !== currentSessionKey;
  const sessionRenderableWindowLimit = isSessionWindowBudgetFirstPass
    ? CHAT_FIRST_PAINT_RENDERABLE_LIMIT
    : getSessionRenderableWindowLimit(currentSessionKey);

  const renderWindowResult = useMemo(
    () => {
      const startedAt = nowMs();
      const slice = getCachedRenderWindowSlice(messages, sessionRenderableWindowLimit);
      return {
        slice,
        rowSliceCostMs: Math.max(0, nowMs() - startedAt),
      };
    },
    [messages, sessionRenderableWindowLimit],
  );

  useEffect(() => {
    setInitializedSessionKey(currentSessionKey);
    updateSessionRenderableWindowLimit(currentSessionKey, CHAT_FIRST_PAINT_RENDERABLE_LIMIT);
  }, [currentSessionKey]);

  useEffect(() => {
    return () => {
      globalSessionRenderableWindowLimit.clear();
    };
  }, []);

  const increaseRenderableWindowLimit = useCallback((sessionKey: string, step = SESSION_RENDER_WINDOW_EXPAND_STEP) => {
    const currentLimit = getSessionRenderableWindowLimit(sessionKey);
    updateSessionRenderableWindowLimit(sessionKey, currentLimit + Math.max(1, Math.floor(step)));
    setRenderWindowVersion((value) => value + 1);
  }, []);

  return {
    rowSourceMessages: renderWindowResult.slice.messages,
    hasOlderRenderableRows: renderWindowResult.slice.hasOlderRenderableMessages,
    rowSliceCostMs: renderWindowResult.rowSliceCostMs,
    increaseRenderableWindowLimit,
  };
}

export function useChatWindowExpand(
  input: UseChatWindowExpandInput,
): UseChatWindowExpandResult {
  const {
    currentSessionKey,
    chatRows,
    hasOlderRenderableRows,
    messageVirtualizer,
    messagesViewportRef,
    scrollMode,
    scrollCommandType,
    handleViewportScroll,
    markScrollActivity,
    increaseRenderableWindowLimit,
  } = input;

  const expandWindowArmedRef = useRef(true);
  const expandWindowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prependWindowTxnRef = useRef<PrependWindowTxn>({ phase: 'idle' });
  const prependWindowTxnSeqRef = useRef(0);

  useEffect(() => {
    return () => {
      if (expandWindowTimerRef.current != null) {
        clearTimeout(expandWindowTimerRef.current);
        expandWindowTimerRef.current = null;
      }
      expandWindowArmedRef.current = true;
      prependWindowTxnRef.current = { phase: 'idle' };
    };
  }, []);

  useEffect(() => {
    expandWindowArmedRef.current = true;
    if (expandWindowTimerRef.current != null) {
      clearTimeout(expandWindowTimerRef.current);
      expandWindowTimerRef.current = null;
    }
    prependWindowTxnRef.current = { phase: 'idle' };
  }, [currentSessionKey]);

  useLayoutEffect(() => {
    const txn = prependWindowTxnRef.current;
    if (txn.phase !== 'scheduled' || txn.sessionKey !== currentSessionKey) {
      return;
    }
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    if (scrollMode !== 'detached' || scrollCommandType !== 'none') {
      prependWindowTxnRef.current = { phase: 'idle' };
      return;
    }

    const targetIndex = chatRows.findIndex((row) => row.key === txn.rowKey);
    if (targetIndex >= 0) {
      messageVirtualizer.scrollToIndex(targetIndex, { align: 'start' });
    }

    let anchorElement: HTMLDivElement | null = null;
    const rowElements = viewport.querySelectorAll<HTMLDivElement>('[data-chat-row-key]');
    for (const element of rowElements) {
      if (element.dataset.chatRowKey === txn.rowKey) {
        anchorElement = element;
        break;
      }
    }

    if (anchorElement) {
      const viewportTop = viewport.getBoundingClientRect().top;
      const currentRowTop = anchorElement.getBoundingClientRect().top - viewportTop;
      const desiredRowTop = -txn.rowOffsetPx;
      const delta = currentRowTop - desiredRowTop;
      if (Math.abs(delta) > 0.5) {
        viewport.scrollTop += delta;
      }
      prependWindowTxnRef.current = { phase: 'idle' };
      return;
    }

    const totalHeightDelta = viewport.scrollHeight - txn.previousScrollHeight;
    if (Number.isFinite(totalHeightDelta) && Math.abs(totalHeightDelta) > 0.5) {
      viewport.scrollTop = Math.max(0, txn.previousScrollTop + totalHeightDelta);
    }
    prependWindowTxnRef.current = { phase: 'idle' };
  }, [chatRows, currentSessionKey, messageVirtualizer, messagesViewportRef, scrollCommandType, scrollMode]);

  const maybeExpandRenderableWindow = useCallback(() => {
    if (scrollMode !== 'detached' || scrollCommandType !== 'none') {
      return;
    }
    if (!hasOlderRenderableRows) {
      return;
    }
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    if (viewport.scrollTop > SESSION_RENDER_WINDOW_REARM_THRESHOLD_PX) {
      expandWindowArmedRef.current = true;
      if (expandWindowTimerRef.current != null) {
        clearTimeout(expandWindowTimerRef.current);
        expandWindowTimerRef.current = null;
      }
      return;
    }
    if (viewport.scrollTop > SESSION_RENDER_WINDOW_TOP_THRESHOLD_PX) {
      return;
    }
    if (!expandWindowArmedRef.current) {
      return;
    }
    if (expandWindowTimerRef.current != null) {
      clearTimeout(expandWindowTimerRef.current);
    }
    const sessionKeyAtSchedule = currentSessionKey;
    expandWindowTimerRef.current = setTimeout(() => {
      expandWindowTimerRef.current = null;
      const activeViewport = messagesViewportRef.current;
      if (!activeViewport || activeViewport.scrollTop > SESSION_RENDER_WINDOW_TOP_THRESHOLD_PX) {
        return;
      }
      if (useChatStore.getState().currentSessionKey !== sessionKeyAtSchedule || !expandWindowArmedRef.current) {
        return;
      }
      const visibleItems = messageVirtualizer.getVirtualItems();
      let anchorItem = visibleItems.find((item) => (
        item.start <= activeViewport.scrollTop
        && (item.start + item.size) > activeViewport.scrollTop
      ));
      if (!anchorItem) {
        anchorItem = visibleItems[0];
      }
      const anchorRow = anchorItem ? chatRows[anchorItem.index] : undefined;
      const anchorRowKey = anchorRow?.key ?? null;
      if (anchorRowKey) {
        prependWindowTxnSeqRef.current += 1;
        prependWindowTxnRef.current = {
          phase: 'scheduled',
          id: prependWindowTxnSeqRef.current,
          sessionKey: sessionKeyAtSchedule,
          rowKey: anchorRowKey,
          rowOffsetPx: Math.max(0, activeViewport.scrollTop - (anchorItem?.start ?? activeViewport.scrollTop)),
          previousScrollTop: activeViewport.scrollTop,
          previousScrollHeight: activeViewport.scrollHeight,
        };
      } else {
        prependWindowTxnRef.current = { phase: 'idle' };
      }
      increaseRenderableWindowLimit(sessionKeyAtSchedule);
      expandWindowArmedRef.current = false;
    }, SESSION_RENDER_WINDOW_EXPAND_DEBOUNCE_MS);
  }, [
    chatRows,
    currentSessionKey,
    hasOlderRenderableRows,
    increaseRenderableWindowLimit,
    messageVirtualizer,
    messagesViewportRef,
    scrollCommandType,
    scrollMode,
  ]);

  const handleViewportScrollWithWindowing = useCallback(() => {
    handleViewportScroll();
    maybeExpandRenderableWindow();
    markScrollActivity();
  }, [handleViewportScroll, markScrollActivity, maybeExpandRenderableWindow]);

  return {
    handleViewportScrollWithWindowing,
  };
}
