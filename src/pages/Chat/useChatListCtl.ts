import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, type TouchEventHandler, type WheelEventHandler } from 'react';
import { useChatScroll } from './useChatScroll';

interface UseChatListCtlInput {
  enabled: boolean;
  scrollScopeKey: string;
  scrollActivationKey: string;
  scrollResetKey: string;
  autoFollowSignal: string;
  scopeRestorePending: boolean;
  tailActivityOpen: boolean;
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  messageContentRef: RefObject<HTMLDivElement | null>;
  markScrollActivity: () => void;
}

const EMPTY_ROW_KEYS = new Set<string>();
const ACTIVE_NEARBY_VIEWPORT_FACTOR = 0.35;
const ACTIVE_DIRECTION_BIAS_FACTOR = 0.7;
const IDLE_NEARBY_VIEWPORT_FACTOR = 0.9;
const IDLE_DIRECTION_BIAS_FACTOR = 1.15;

function areRowKeySetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const key of left) {
    if (!right.has(key)) {
      return false;
    }
  }
  return true;
}

export function useChatListCtl(input: UseChatListCtlInput) {
  const {
    enabled,
    scrollScopeKey,
    scrollActivationKey,
    scrollResetKey,
    autoFollowSignal,
    scopeRestorePending,
    tailActivityOpen,
    messagesViewportRef,
    messageContentRef,
    markScrollActivity,
  } = input;

  const {
    handleViewportPointerDown,
    handleViewportScroll,
    handleViewportTouchMove,
    handleViewportWheel,
    prepareScopeAnchorRestore,
    prepareScopeBottomAlign,
    isUserScrolling,
    scrollIdle,
    scrollDirection,
    scrollEventSeq,
  } = useChatScroll({
    enabled,
    scrollScopeKey,
    scrollActivationKey,
    scrollResetKey,
    autoFollowSignal,
    scopeRestorePending,
    tailActivityOpen,
    viewportRef: messagesViewportRef,
    contentRef: messageContentRef,
    stickyBottomThresholdPx: 120,
  });
  const [visibleRowKeys, setVisibleRowKeys] = useState<Set<string>>(EMPTY_ROW_KEYS);
  const [preheatRowKeys, setPreheatRowKeys] = useState<Set<string>>(EMPTY_ROW_KEYS);
  const rafIdRef = useRef<number | null>(null);

  const sampleRowKeys = useCallback(() => {
    if (!enabled) {
      return;
    }
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      setVisibleRowKeys((previous) => (previous.size === 0 ? previous : EMPTY_ROW_KEYS));
      setPreheatRowKeys((previous) => (previous.size === 0 ? previous : EMPTY_ROW_KEYS));
      return;
    }
    const viewportRect = viewport.getBoundingClientRect();
    const fallbackHeight = viewport.clientHeight;
    if (viewportRect.height <= 0 && fallbackHeight <= 0) {
      return;
    }
    const sampledViewportRect = viewportRect.height > 0 ? viewportRect : DOMRect.fromRect({
      x: 0,
      y: 0,
      width: viewport.clientWidth,
      height: fallbackHeight,
    });
    const nearbyPx = sampledViewportRect.height * (scrollIdle ? IDLE_NEARBY_VIEWPORT_FACTOR : ACTIVE_NEARBY_VIEWPORT_FACTOR);
    const directionBiasPx = sampledViewportRect.height * (scrollIdle ? IDLE_DIRECTION_BIAS_FACTOR : ACTIVE_DIRECTION_BIAS_FACTOR);
    const warmTop = sampledViewportRect.top - nearbyPx - (scrollDirection < 0 ? directionBiasPx : 0);
    const warmBottom = sampledViewportRect.bottom + nearbyPx + (scrollDirection > 0 ? directionBiasPx : 0);

    const nextVisible = new Set<string>();
    const nextPreheat = new Set<string>();
    const rows = viewport.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]');
    rows.forEach((row) => {
      const rowKey = row.dataset.chatRowKey;
      if (!rowKey) {
        return;
      }
      const rect = row.getBoundingClientRect();
      const intersectsViewport = rect.bottom >= sampledViewportRect.top && rect.top <= sampledViewportRect.bottom;
      if (intersectsViewport) {
        nextVisible.add(rowKey);
        nextPreheat.add(rowKey);
        return;
      }
      const intersectsWarmBand = rect.bottom >= warmTop && rect.top <= warmBottom;
      if (intersectsWarmBand) {
        nextPreheat.add(rowKey);
      }
    });

    setVisibleRowKeys((previous) => (areRowKeySetsEqual(previous, nextVisible) ? previous : nextVisible));
    setPreheatRowKeys((previous) => (areRowKeySetsEqual(previous, nextPreheat) ? previous : nextPreheat));
  }, [enabled, messagesViewportRef, scrollDirection, scrollIdle]);

  const scheduleSample = useCallback(() => {
    if (!enabled) {
      return;
    }
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      sampleRowKeys();
      return;
    }
    if (rafIdRef.current != null) {
      return;
    }
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      sampleRowKeys();
    });
  }, [enabled, sampleRowKeys]);

  const handleViewportScrollCombined = useCallback(() => {
    markScrollActivity();
    handleViewportScroll();
  }, [handleViewportScroll, markScrollActivity]);

  const handleViewportWheelCombined = useCallback<WheelEventHandler<HTMLDivElement>>((event) => {
    markScrollActivity();
    handleViewportWheel(event);
  }, [handleViewportWheel, markScrollActivity]);

  const handleViewportTouchMoveCombined = useCallback<TouchEventHandler<HTMLDivElement>>((event) => {
    handleViewportTouchMove(event);
  }, [handleViewportTouchMove]);

  const scrollToRowKey = useCallback((rowKey?: string) => {
    if (!rowKey) {
      return;
    }
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    const target = Array.from(viewport.querySelectorAll<HTMLElement>('[data-chat-row-key]'))
      .find((element) => element.dataset.chatRowKey === rowKey);
    if (!target) {
      return;
    }
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [messagesViewportRef]);

  useLayoutEffect(() => {
    scheduleSample();
  }, [enabled, scheduleSample, scrollScopeKey]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (scrollEventSeq <= 0) {
      return;
    }
    scheduleSample();
  }, [enabled, scheduleSample, scrollEventSeq]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    scheduleSample();
  }, [enabled, scheduleSample, scrollDirection, scrollIdle]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const viewport = messagesViewportRef.current;
    const content = messageContentRef.current;
    if (typeof ResizeObserver !== 'function' || (!viewport && !content)) {
      return;
    }
    const observer = new ResizeObserver(() => {
      scheduleSample();
    });
    if (viewport) {
      observer.observe(viewport);
    }
    if (content) {
      observer.observe(content);
    }
    return () => observer.disconnect();
  }, [enabled, messageContentRef, messagesViewportRef, scheduleSample]);

  useEffect(() => () => {
    if (rafIdRef.current != null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(rafIdRef.current);
    }
  }, []);

  const stableVisibleRowKeys = useMemo(
    () => (visibleRowKeys.size > 0 ? visibleRowKeys : EMPTY_ROW_KEYS),
    [visibleRowKeys],
  );
  const stablePreheatRowKeys = useMemo(
    () => (preheatRowKeys.size > 0 ? preheatRowKeys : EMPTY_ROW_KEYS),
    [preheatRowKeys],
  );

  return {
    handleViewportPointerDown,
    handleViewportTouchMove: handleViewportTouchMoveCombined,
    handleViewportWheel: handleViewportWheelCombined,
    handleViewportScroll: handleViewportScrollCombined,
    prepareScopeAnchorRestore,
    prepareScopeBottomAlign,
    isUserScrolling,
    scrollIdle,
    scrollDirection,
    scrollEventSeq,
    visibleRowKeys: stableVisibleRowKeys,
    preheatRowKeys: stablePreheatRowKeys,
    scrollToRowKey,
  };
}
