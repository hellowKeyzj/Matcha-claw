import { useCallback, useEffectEvent, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject, type WheelEvent } from 'react';
import type { ChatPanelLayout } from '@/plugins/chat/extensions';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from '@/plugins/chat/chat-layout-tokens';
import { CHAT_WORKSPACE_LAYOUT } from '@/app/layout/workspace';
import type { ChatSidePanelMode, ChatWindowDockPhase } from '@/app/layout/workspace';

const CHAT_THREAD_BOTTOM_GAP_PX = 12;
const CHAT_THREAD_TOP_GAP_PX = 8;

const CHAT_STAGE_CSS_VARS = {
  '--chat-composer-safe-offset': '0px',
  '--chat-thread-bottom-padding': `${CHAT_THREAD_BOTTOM_GAP_PX}px`,
  '--chat-header-safe-offset': '0px',
  '--chat-thread-top-padding': `${CHAT_THREAD_TOP_GAP_PX}px`,
} as CSSProperties;

interface ChatShellProps {
  chatLayoutRef: RefObject<HTMLDivElement | null>;
  sidePanelPhase: ChatWindowDockPhase;
  sidePanelMode: ChatSidePanelMode;
  sidePanelWidth: number;
  sidePanelMainWidth?: number | null;
  sidePanelVisible?: boolean;
  artifactWorkbenchFullscreen?: boolean;
  panelLayout: ChatPanelLayout;
  onSidePanelResize?: (nextWidth: number) => void;
  onSidePanelResizeCommit?: (nextWidth: number) => void;
  onComposerWheel?: (deltaY: number) => void;
  onComposerGeometryChange?: () => void;
  isEmptyState?: boolean;
  emptyState?: ReactNode;
  sidePanel: ReactNode;
  header: ReactNode;
  viewportPane: ReactNode;
  input: ReactNode;
}

export function ChatShell({
  chatLayoutRef,
  sidePanelPhase,
  sidePanelMode,
  sidePanelWidth,
  sidePanelMainWidth = null,
  sidePanelVisible,
  artifactWorkbenchFullscreen = false,
  panelLayout,
  onSidePanelResize,
  onSidePanelResizeCommit,
  onComposerWheel,
  onComposerGeometryChange,
  isEmptyState = false,
  emptyState = null,
  sidePanel,
  header,
  viewportPane,
  input,
}: ChatShellProps) {
  const isMac = window.electron?.platform === 'darwin';
  const stageRef = useRef<HTMLDivElement>(null);
  const headerOverlayRef = useRef<HTMLDivElement>(null);
  const composerOverlayRef = useRef<HTMLDivElement>(null);
  const resizeGestureRef = useRef<{ pointerId: number; element: HTMLDivElement; cursor: string; userSelect: string; commit?: () => void } | null>(null);
  const lastSidePanelResizeWidthRef = useRef(sidePanelWidth);
  const [panelHeightPercent, setPanelHeightPercent] = useState(60);
  const panelLayoutActive = !artifactWorkbenchFullscreen
    && sidePanelMode === 'docked'
    && sidePanelPhase !== 'closed';
  const panelOnly = panelLayoutActive && (panelLayout.fullscreen || panelLayout.position === 'full');
  const panelComposerDocked = panelOnly && panelLayout.composer === 'dock';
  const composerCentered = isEmptyState && !panelOnly;
  const panelTop = panelLayoutActive && !panelOnly && panelLayout.position === 'top';
  const panelBeforeChat = panelLayoutActive && !panelOnly && panelLayout.position === 'left';

  useLayoutEffect(() => {
    lastSidePanelResizeWidthRef.current = sidePanelWidth;
  }, [sidePanelWidth]);

  const shouldLetNestedScrollableConsumeWheel = (event: WheelEvent<HTMLElement>): boolean => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    const selector = 'textarea, [data-radix-scroll-area-viewport], [data-tool-output-scroll="true"], [data-chat-composer-wheel-local="true"]';
    let scrollable = target.closest<HTMLElement>(selector);
    while (scrollable && event.currentTarget.contains(scrollable)) {
      if (scrollable.scrollHeight > scrollable.clientHeight
        && (event.deltaY > 0
          ? scrollable.scrollTop + scrollable.clientHeight < scrollable.scrollHeight - 1
          : event.deltaY < 0 && scrollable.scrollTop > 0)) {
        return true;
      }
      scrollable = scrollable.parentElement?.closest<HTMLElement>(selector) ?? null;
    }
    return false;
  };

  const handleComposerWheelCapture = (event: WheelEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Node) || !event.currentTarget.contains(target)) {
      return;
    }
    if (!onComposerWheel || event.defaultPrevented || shouldLetNestedScrollableConsumeWheel(event)) {
      return;
    }
    event.preventDefault();
    onComposerWheel(event.deltaY);
  };

  useLayoutEffect(() => {
    const stageNode = stageRef.current;
    if (!stageNode) {
      return;
    }

    const resetOverlayOffsets = () => {
      stageNode.style.setProperty('--chat-header-safe-offset', '0px');
      stageNode.style.setProperty('--chat-thread-top-padding', `${CHAT_THREAD_TOP_GAP_PX}px`);
      stageNode.style.setProperty('--chat-composer-safe-offset', '0px');
      stageNode.style.setProperty('--chat-thread-bottom-padding', `${CHAT_THREAD_BOTTOM_GAP_PX}px`);
    };

    const headerNode = headerOverlayRef.current;
    const composerNode = composerOverlayRef.current;
    if (!headerNode || !composerNode || isEmptyState || panelOnly || artifactWorkbenchFullscreen) {
      resetOverlayOffsets();
      return;
    }

    // 只记录本次 effect 已提交的 CSS 高度，每次同步仍读取真实布局。
    let appliedHeaderHeight: number | undefined;
    let appliedComposerHeight: number | undefined;
    const syncOverlayOffsets = () => {
      const headerHeight = Math.ceil(headerNode.getBoundingClientRect().height);
      const composerHeight = Math.ceil(composerNode.getBoundingClientRect().height);
      if (headerHeight === appliedHeaderHeight && composerHeight === appliedComposerHeight) {
        return;
      }
      if (headerHeight !== appliedHeaderHeight) {
        stageNode.style.setProperty('--chat-header-safe-offset', `${headerHeight}px`);
        stageNode.style.setProperty('--chat-thread-top-padding', `${headerHeight + CHAT_THREAD_TOP_GAP_PX}px`);
        appliedHeaderHeight = headerHeight;
      }
      if (composerHeight !== appliedComposerHeight) {
        stageNode.style.setProperty('--chat-composer-safe-offset', `${composerHeight}px`);
        stageNode.style.setProperty('--chat-thread-bottom-padding', `${composerHeight + CHAT_THREAD_BOTTOM_GAP_PX}px`);
        appliedComposerHeight = composerHeight;
      }
      onComposerGeometryChange?.();
    };

    syncOverlayOffsets();

    if (typeof ResizeObserver !== 'function') {
      return resetOverlayOffsets;
    }

    const observer = new ResizeObserver(() => {
      syncOverlayOffsets();
    });
    observer.observe(headerNode);
    observer.observe(composerNode);

    return () => {
      observer.disconnect();
      resetOverlayOffsets();
    };
  }, [artifactWorkbenchFullscreen, panelOnly, isEmptyState, onComposerGeometryChange]);

  const finishSidePanelResize = useCallback(() => {
    const gesture = resizeGestureRef.current;
    if (!gesture) return;
    resizeGestureRef.current = null;
    if (gesture.element.hasPointerCapture(gesture.pointerId)) {
      gesture.element.releasePointerCapture(gesture.pointerId);
    }
    document.body.style.userSelect = gesture.userSelect;
    document.body.style.cursor = gesture.cursor;
    gesture.commit?.();
  }, []);

  const endSidePanelResize = useEffectEvent((event: PointerEvent) => {
    if (resizeGestureRef.current?.pointerId === event.pointerId) finishSidePanelResize();
  });
  const checkSidePanelResizeButtons = useEffectEvent((event: PointerEvent) => {
    if (resizeGestureRef.current?.pointerId === event.pointerId && !(event.buttons & 1)) finishSidePanelResize();
  });
  useLayoutEffect(() => {
    // Native capture-phase completion also covers release over an embedded application.
    window.addEventListener('pointerup', endSidePanelResize, true);
    window.addEventListener('pointercancel', endSidePanelResize, true);
    window.addEventListener('pointermove', checkSidePanelResizeButtons, true);
    window.addEventListener('blur', finishSidePanelResize);
    return () => {
      window.removeEventListener('pointerup', endSidePanelResize, true);
      window.removeEventListener('pointercancel', endSidePanelResize, true);
      window.removeEventListener('pointermove', checkSidePanelResizeButtons, true);
      window.removeEventListener('blur', finishSidePanelResize);
      finishSidePanelResize();
    };
  }, [finishSidePanelResize, sidePanelPhase, panelOnly, panelTop, panelBeforeChat]);

  const handleSidePanelResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || resizeGestureRef.current || (!panelTop && !onSidePanelResize)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeGestureRef.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
      commit: !panelTop && onSidePanelResizeCommit ? () => onSidePanelResizeCommit(lastSidePanelResizeWidthRef.current) : undefined,
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = panelTop ? 'row-resize' : 'col-resize';
  };

  const handleSidePanelResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (resizeGestureRef.current?.pointerId !== event.pointerId) return;
    if (!(event.buttons & 1)) {
      finishSidePanelResize();
      return;
    }
    const layoutNode = chatLayoutRef.current;
    if (!layoutNode) return;
    const rect = layoutNode.getBoundingClientRect();
    if (panelTop) {
      setPanelHeightPercent(Math.max(25, Math.min(75, (event.clientY - rect.top) / Math.max(1, rect.height) * 100)));
      return;
    }
    const nextWidth = panelBeforeChat ? event.clientX - rect.left : rect.right - event.clientX;
    lastSidePanelResizeWidthRef.current = nextWidth;
    onSidePanelResize?.(nextWidth);
  };

  const handleSidePanelResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (resizeGestureRef.current?.pointerId === event.pointerId) finishSidePanelResize();
  };

  const resolvedSidePanelVisible = sidePanelVisible ?? sidePanelPhase === 'open';
  const dockedSidePanelMounted = !artifactWorkbenchFullscreen
    && sidePanelMode === 'docked'
    && (sidePanelPhase === 'opening' || sidePanelPhase === 'open' || sidePanelPhase === 'closing');
  const overlaySidePanelMounted = !artifactWorkbenchFullscreen
    && sidePanelMode === 'overlay'
    && sidePanelPhase === 'open';
  const sidePanelMounted = artifactWorkbenchFullscreen || dockedSidePanelMounted || overlaySidePanelMounted;
  const [sidePanelContentMounted, setSidePanelContentMounted] = useState(false);
  // Reopening a layout retains its content; the first opening still waits for the window.
  const nextSidePanelContentMounted = artifactWorkbenchFullscreen || resolvedSidePanelVisible
    || ((sidePanelPhase === 'opening' || sidePanelPhase === 'closing') && sidePanelContentMounted);
  if (nextSidePanelContentMounted !== sidePanelContentMounted) setSidePanelContentMounted(nextSidePanelContentMounted);
  const mainTrack = sidePanelMainWidth != null ? `${sidePanelMainWidth}px` : 'minmax(0, 1fr)';
  const panelTrack = sidePanelMainWidth != null ? 'minmax(0, 1fr)' : 'var(--chat-side-panel-width)';
  const gridTemplateColumns = dockedSidePanelMounted && !panelOnly && !panelTop
    ? panelBeforeChat
      ? `${panelTrack} var(--chat-side-panel-resizer-width) ${mainTrack}`
      : `${mainTrack} var(--chat-side-panel-resizer-width) ${panelTrack}`
    : 'minmax(0, 1fr)';

  return (
    <div
      ref={chatLayoutRef}
      className="relative grid h-full min-h-0 overflow-hidden bg-card"
      data-panel-position={panelLayoutActive ? panelLayout.position : undefined}
      data-panel-fullscreen={panelLayoutActive ? panelLayout.fullscreen : undefined}
      style={{
        gridTemplateColumns,
        gridTemplateRows: panelTop ? `minmax(0, ${panelHeightPercent}fr) var(--chat-side-panel-resizer-width) minmax(0, ${100 - panelHeightPercent}fr)` : undefined,
        ['--chat-side-panel-width' as string]: `${sidePanelWidth}px`,
        ['--chat-side-panel-resizer-width' as string]: `${CHAT_WORKSPACE_LAYOUT.paneResizerWidth}px`,
      }}
    >
      <div
        ref={stageRef}
        className={cn(CHAT_LAYOUT_TOKENS.stageSurface, 'chat-scroll-sync', panelComposerDocked && 'pointer-events-none z-10 bg-transparent')}
        style={{ ...CHAT_STAGE_CSS_VARS,
          display: artifactWorkbenchFullscreen || panelOnly && !panelComposerDocked ? 'none' : undefined,
          gridColumn: panelTop ? 1 : panelBeforeChat ? 3 : 1,
          gridRow: panelTop ? 3 : 1,
        }}
      >
          {isMac && !panelOnly ? (
            <div
              data-testid="mac-chat-drag-region"
              aria-hidden="true"
              className="drag-region pointer-events-auto absolute inset-x-0 top-0 z-[15] h-7"
            />
          ) : null}

          <div
            data-testid="chat-stage-backdrop"
            hidden={panelOnly}
            className={CHAT_LAYOUT_TOKENS.stageBackdrop}
          />

          <div
            data-testid="chat-stage-header-overlay"
            ref={headerOverlayRef}
            hidden={panelOnly}
            inert={panelOnly}
            className={CHAT_LAYOUT_TOKENS.stageHeaderOverlay}
          >
            <div className={CHAT_LAYOUT_TOKENS.stageHeaderRail}>
              <div className="pointer-events-auto">
                {header}
              </div>
            </div>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className={panelOnly ? 'hidden' : 'contents'} inert={panelOnly}>
              {!artifactWorkbenchFullscreen && !isEmptyState ? viewportPane : null}

              {!isEmptyState ? <div
                data-testid="chat-stage-bottom-fade"
                className={CHAT_LAYOUT_TOKENS.stageBottomFade}
              /> : null}
            </div>

            <div
              ref={composerOverlayRef}
              className={panelComposerDocked
                ? 'pointer-events-none relative z-20 mt-auto shrink-0 px-3 pb-2.5 md:px-4 md:pb-3'
                : composerCentered
                  ? 'flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-12 pt-20 sm:px-8 md:pb-20'
                  : CHAT_LAYOUT_TOKENS.composerOverlay}
            >
              <div className={composerCentered ? 'mx-auto my-auto w-full min-w-0 max-w-[44rem] py-8 text-left' : undefined}>
                {composerCentered ? emptyState : null}
                <div
                  className={cn('pointer-events-auto chat-scroll-sync-input', composerCentered && 'mt-7 w-full', panelComposerDocked && CHAT_LAYOUT_TOKENS.inputRail)}
                  onWheelCapture={composerCentered || panelOnly ? undefined : handleComposerWheelCapture}
                >
                  {input}
                </div>
              </div>
            </div>
          </div>
        </div>

      {dockedSidePanelMounted && !panelOnly ? <div
        role="separator"
        aria-orientation={panelTop ? 'horizontal' : 'vertical'}
        style={panelLayoutActive ? { gridColumn: panelTop ? 1 : 2, gridRow: panelTop ? 2 : 1 } : undefined}
        data-testid="chat-side-panel-resizer"
        className={cn(
          'group relative z-10 touch-none bg-transparent',
          panelTop ? 'h-[var(--chat-side-panel-resizer-width)] cursor-row-resize' : 'w-[var(--chat-side-panel-resizer-width)]',
          !panelTop && (sidePanelPhase === 'open' ? 'cursor-col-resize' : 'cursor-default'),
        )}
        onPointerDown={sidePanelPhase === 'open' ? handleSidePanelResizeStart : undefined}
        onPointerMove={handleSidePanelResizeMove}
        onPointerUp={handleSidePanelResizeEnd}
        onPointerCancel={handleSidePanelResizeEnd}
        onLostPointerCapture={handleSidePanelResizeEnd}
      >
        <span
          aria-hidden
          className={cn('pointer-events-none absolute bg-border/60 transition-colors group-hover:bg-primary/60', panelTop ? 'inset-x-0 top-1/2 h-px -translate-y-1/2' : 'inset-y-0 left-1/2 w-px -translate-x-1/2')}
        />
      </div> : null}

      {sidePanelMounted ? (
        <div
          data-testid={artifactWorkbenchFullscreen ? 'chat-artifact-workbench-fullscreen' : overlaySidePanelMounted ? 'chat-side-panel-overlay' : undefined}
          inert={!artifactWorkbenchFullscreen && !resolvedSidePanelVisible}
          className={cn(
            'min-h-0 min-w-0 overflow-hidden bg-card',
            overlaySidePanelMounted && 'absolute inset-y-3 right-3 z-20 max-w-[calc(100%-1.5rem)]',
            !artifactWorkbenchFullscreen && !resolvedSidePanelVisible && 'invisible pointer-events-none',
          )}
          style={artifactWorkbenchFullscreen ? undefined : overlaySidePanelMounted
            ? { width: `${sidePanelWidth}px` }
            : {
              display: dockedSidePanelMounted ? undefined : 'none',
              gridColumn: panelOnly || panelTop || panelBeforeChat ? 1 : 3,
              gridRow: 1,
            }}
        >
          {sidePanelContentMounted ? sidePanel : null}
        </div>
      ) : null}
    </div>
  );
}
