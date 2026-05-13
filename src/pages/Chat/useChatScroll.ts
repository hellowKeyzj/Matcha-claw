import { useLayoutEffect, useRef, type RefObject } from 'react';
import {
  computeBottomLockedScrollTopOnResize,
  createChatScrollController,
  isChatViewportNearBottom,
  type ChatScrollControllerConfig,
} from './chat-scroll-controller';

interface UseChatScrollInput {
  enabled: boolean;
  scrollScopeKey: string;
  viewportWindowSignal: string;
  anchorItemKey: string | null;
  autoFollowSignal: string;
  tailActivityOpen: boolean;
  setScrollChromeBottomLocked: (isBottomLocked: boolean) => void;
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  stickyBottomThresholdPx: number;
}

export { computeBottomLockedScrollTopOnResize, isChatViewportNearBottom };

export function useChatScroll({
  enabled,
  scrollScopeKey,
  viewportWindowSignal,
  anchorItemKey,
  autoFollowSignal,
  tailActivityOpen,
  setScrollChromeBottomLocked,
  viewportRef,
  contentRef,
  stickyBottomThresholdPx,
}: UseChatScrollInput) {
  const configRef = useRef<ChatScrollControllerConfig>({
    enabled,
    scrollScopeKey,
    anchorItemKey,
    tailActivityOpen,
    setScrollChromeBottomLocked,
    viewportRef,
    contentRef,
    stickyBottomThresholdPx,
  });
  configRef.current = {
    enabled,
    scrollScopeKey,
    anchorItemKey,
    tailActivityOpen,
    setScrollChromeBottomLocked,
    viewportRef,
    contentRef,
    stickyBottomThresholdPx,
  };

  const controllerRef = useRef<ReturnType<typeof createChatScrollController> | null>(null);
  if (controllerRef.current == null) {
    controllerRef.current = createChatScrollController(() => configRef.current);
  }
  const controller = controllerRef.current;

  useLayoutEffect(() => {
    controller.onScopeRenderSync();
  }, [controller, enabled, scrollScopeKey]);

  useLayoutEffect(() => {
    controller.onTailActivityRenderSync();
  }, [controller, enabled, tailActivityOpen]);

  useLayoutEffect(() => {
    controller.onAutoFollowRenderSync();
  }, [anchorItemKey, autoFollowSignal, controller, enabled, tailActivityOpen, viewportWindowSignal]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (typeof ResizeObserver !== 'function' || (!viewport && !content)) {
      return;
    }
    const observer = new ResizeObserver(() => {
      controller.onResizeObserved();
    });

    if (viewport) {
      observer.observe(viewport);
    }
    if (content) {
      observer.observe(content);
    }

    return () => observer.disconnect();
  }, [contentRef, controller, enabled, viewportRef]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    controller.syncChromeRender();
  }, [autoFollowSignal, controller, enabled, scrollScopeKey]);

  useLayoutEffect(() => {
    return () => {
      controller.cleanup();
    };
  }, [controller]);

  return {
    handleViewportScroll: controller.handleViewportScroll,
    handleViewportPointerDown: controller.handleViewportPointerDown,
    handleViewportTouchMove: controller.handleViewportTouchMove,
    handleViewportWheel: controller.handleViewportWheel,
    scrollViewportByWheelDelta: controller.scrollViewportByWheelDelta,
    prepareScopeAnchorRestore: controller.prepareScopeAnchorRestore,
    prepareScopeBottomAlign: controller.prepareScopeBottomAlign,
    notifyViewportGeometryChanged: controller.onResizeObserved,
    jumpToBottom: controller.jumpToBottom,
  };
}
