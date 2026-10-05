import { useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { createChatScrollController } from './chat-scroll-controller';
import type { ChatScrollPhase } from './chat-scroll-model';

interface UseChatScrollInput {
  enabled: boolean;
  scrollScopeKey: string;
  /** 列表渲染数据的快照签名：每次 items/window 发生显著变化时变化 */
  contentSignal: string;
  setChromePhase: (phase: ChatScrollPhase) => void;
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
}

export function useChatScroll({
  enabled,
  scrollScopeKey,
  contentSignal,
  setChromePhase,
  viewportRef,
  contentRef,
}: UseChatScrollInput) {
  const [controller] = useState(() => createChatScrollController());

  useLayoutEffect(() => {
    controller.setConfig({
      enabled,
      scrollScopeKey,
      setChromePhase,
      viewportRef,
    });
  }, [controller, enabled, scrollScopeKey, setChromePhase, viewportRef]);

  // scope 变化时同步 phase + 触发过渡（首次加载贴底 / 锚点恢复 / 强制贴底）
  useLayoutEffect(() => {
    controller.onScopeChanged();
  }, [controller, enabled, scrollScopeKey]);

  // 列表内容刷新（新消息 / 流式 token / 历史切页）：与 ResizeObserver 等价的入口。
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    controller.onGeometryChanged();
  }, [contentSignal, controller, enabled]);

  // 视口/内容尺寸变化（流式 token / 历史切页 / composer 高度变化 / 窗口变化）
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
      controller.onGeometryChanged();
    });
    if (viewport) {
      observer.observe(viewport);
    }
    if (content) {
      observer.observe(content);
    }
    return () => observer.disconnect();
  }, [contentRef, controller, enabled, viewportRef]);

  useLayoutEffect(() => () => controller.cleanup(), [controller]);

  return useMemo(() => ({
    handleViewportScroll: controller.handleViewportScroll,
    handleViewportPointerDown: controller.handleViewportPointerDown,
    handleViewportTouchMove: controller.handleViewportTouchMove,
    handleViewportWheel: controller.handleViewportWheel,
    handleViewportClickCapture: controller.handleViewportClickCapture,
    scrollViewportByWheelDelta: controller.scrollViewportByWheelDelta,
    prepareElementAnchorRestore: controller.prepareElementAnchorRestore,
    prepareScopeAnchorRestore: controller.prepareScopeAnchorRestore,
    prepareScopeBottomAlign: controller.prepareScopeBottomAlign,
    notifyViewportGeometryChanged: controller.onGeometryChanged,
    jumpToBottom: controller.jumpToBottom,
  }), [controller]);
}
