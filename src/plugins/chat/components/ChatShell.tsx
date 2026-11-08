import { useCallback, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject, type WheelEvent } from 'react';
import type { WorkspaceLayout, WorkspacePanelProps, WorkspacePaneStyle } from '@/plugins/workspace/extensions';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from '@/plugins/chat/chat-layout-tokens';
import { CHAT_WORKSPACE_LAYOUT } from '@/app/layout/workspace';
import type { ChatSidePanelMode, ChatWindowDockPhase } from '@/app/layout/workspace';

const CHAT_THREAD_BOTTOM_GAP_PX = 12;
const CHAT_THREAD_TOP_GAP_PX = 8;

const CHAT_STAGE_CSS_VARS = {
  '--chat-composer-safe-offset': '0px',
  '--chat-thread-bottom-padding': `${CHAT_THREAD_BOTTOM_GAP_PX}px`,
  '--chat-thread-top-padding': `${CHAT_THREAD_TOP_GAP_PX}px`,
} as CSSProperties;

interface ChatShellProps {
  chatLayoutRef: RefObject<HTMLDivElement | null>;
  sidePanelPhase: ChatWindowDockPhase;
  sidePanelMode: ChatSidePanelMode;
  sidePanelWidth: number;
  sidePanelMainWidth?: number | null;
  sidePanelVisible?: boolean;
  panelLayout: WorkspaceLayout;
  containerWidth: number;
  mainPageActive: boolean;
  onSidePanelResize?: (nextWidth: number) => void;
  onSidePanelResizeCommit?: (nextWidth: number) => void;
  onComposerWheel?: (deltaY: number) => void;
  onComposerGeometryChange?: () => void;
  isEmptyState?: boolean;
  emptyState?: ReactNode;
  offline?: ReactNode;
  renderWorkspace: (metrics: Pick<WorkspacePanelProps, 'visible' | 'width' | 'mainVisible' | 'mainWidth' | 'mainActions' | 'mainStyle' | 'sideStyle'>) => ReactNode;
  header: ReactNode;
  threadHeader?: ReactNode;
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
  panelLayout,
  containerWidth,
  mainPageActive,
  onSidePanelResize,
  onSidePanelResizeCommit,
  onComposerWheel,
  onComposerGeometryChange,
  isEmptyState = false,
  emptyState = null,
  offline = null,
  renderWorkspace,
  header,
  threadHeader,
  viewportPane,
  input,
}: ChatShellProps) {
  const isOffline = Boolean(offline);
  const stageRef = useRef<HTMLDivElement>(null);
  const composerOverlayRef = useRef<HTMLDivElement>(null);
  const resizeGestureRef = useRef<{
    pointerId: number; element: HTMLDivElement; cursor: string; userSelect: string;
    startX: number; startWidth: number; width: number;
    frame: number | null; update?: () => void; commit?: (width: number) => void;
  } | null>(null);
  const [panelHeightPercent, setPanelHeightPercent] = useState(60);
  const panelLayoutActive = sidePanelMode === 'docked'
    && sidePanelPhase !== 'closed';
  const panelOnly = panelLayoutActive && (panelLayout.fullscreen || panelLayout.position === 'full');
  const panelComposerDocked = panelOnly && panelLayout.composer === 'dock';
  const composerCentered = isEmptyState && !panelOnly;
  const panelTop = panelLayoutActive && !panelOnly && panelLayout.position === 'top';
  const panelBeforeChat = panelLayoutActive && !panelOnly && panelLayout.position === 'left';
  const stageHidden = panelOnly ? !panelComposerDocked : mainPageActive;

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
      stageNode.style.setProperty('--chat-composer-safe-offset', '0px');
      stageNode.style.setProperty('--chat-thread-bottom-padding', `${CHAT_THREAD_BOTTOM_GAP_PX}px`);
    };

    const composerNode = composerOverlayRef.current;
    if (!composerNode || isEmptyState || panelOnly || isOffline) {
      resetOverlayOffsets();
      return;
    }

    // 只记录本次 effect 已提交的 CSS 高度，每次同步仍读取真实布局。
    let appliedComposerHeight: number | undefined;
    const syncOverlayOffsets = () => {
      const composerHeight = Math.ceil(composerNode.getBoundingClientRect().height);
      if (composerHeight === appliedComposerHeight) return;
      stageNode.style.setProperty('--chat-composer-safe-offset', `${composerHeight}px`);
      stageNode.style.setProperty('--chat-thread-bottom-padding', `${composerHeight + CHAT_THREAD_BOTTOM_GAP_PX}px`);
      appliedComposerHeight = composerHeight;
      onComposerGeometryChange?.();
    };

    syncOverlayOffsets();

    if (typeof ResizeObserver !== 'function') {
      return resetOverlayOffsets;
    }

    const observer = new ResizeObserver(() => {
      syncOverlayOffsets();
    });
    observer.observe(composerNode);

    return () => {
      observer.disconnect();
      resetOverlayOffsets();
    };
  }, [panelOnly, isEmptyState, isOffline, onComposerGeometryChange]);

  const finishSidePanelResize = useCallback(() => {
    const gesture = resizeGestureRef.current;
    if (!gesture) return;
    if (gesture.frame !== null) window.cancelAnimationFrame(gesture.frame);
    gesture.update?.();
    resizeGestureRef.current = null;
    if (gesture.element.hasPointerCapture(gesture.pointerId)) {
      gesture.element.releasePointerCapture(gesture.pointerId);
    }
    document.body.style.userSelect = gesture.userSelect;
    document.body.style.cursor = gesture.cursor;
    gesture.commit?.(gesture.width);
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
      startX: event.clientX,
      startWidth: sidePanelWidth,
      width: sidePanelWidth,
      frame: null,
      commit: panelTop ? undefined : onSidePanelResizeCommit,
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = panelTop ? 'row-resize' : 'col-resize';
  };

  const handleSidePanelResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = resizeGestureRef.current;
    if (gesture?.pointerId !== event.pointerId) return;
    if (!(event.buttons & 1)) {
      finishSidePanelResize();
      return;
    }
    const { clientX, clientY } = event;
    gesture.update = () => {
      gesture.frame = null;
      gesture.update = undefined;
      if (panelTop) {
        const layoutNode = chatLayoutRef.current;
        if (!layoutNode) return;
        const rect = layoutNode.getBoundingClientRect();
        const [sideHeaderHeight, , resizerHeight, mainHeaderHeight] = getComputedStyle(layoutNode).gridTemplateRows.split(/\s+/).map(Number.parseFloat);
        const targetHeight = Math.max(rect.height * 0.25, Math.min(rect.height * 0.75, clientY - rect.top));
        const bodyHeight = Math.max(1, rect.height - sideHeaderHeight - mainHeaderHeight - resizerHeight);
        setPanelHeightPercent(Math.max(0, Math.min(100, (targetHeight - sideHeaderHeight) / bodyHeight * 100)));
        return;
      }
      const delta = clientX - gesture.startX;
      const nextWidth = Math.round(gesture.startWidth + (panelBeforeChat ? delta : -delta));
      if (gesture.width === nextWidth) return;
      gesture.width = nextWidth;
      onSidePanelResize?.(nextWidth);
    };
    if (gesture.frame === null) {
      gesture.frame = window.requestAnimationFrame(() => gesture.update?.());
    }
  };

  const handleSidePanelResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (resizeGestureRef.current?.pointerId === event.pointerId) finishSidePanelResize();
  };

  const resolvedSidePanelVisible = sidePanelVisible ?? sidePanelPhase === 'open';
  const dockedSidePanelMounted = sidePanelMode === 'docked'
    && (sidePanelPhase === 'opening' || sidePanelPhase === 'open' || sidePanelPhase === 'closing');
  const overlaySidePanelMounted = sidePanelMode === 'overlay'
    && sidePanelPhase === 'open';
  const splitColumns = dockedSidePanelMounted && !panelOnly && !panelTop;
  const mainTrack = sidePanelMainWidth != null ? `${sidePanelMainWidth}px` : 'minmax(0, 1fr)';
  const panelTrack = sidePanelMainWidth != null ? 'minmax(0, 1fr)' : 'var(--chat-side-panel-width)';
  const gridTemplateColumns = splitColumns
    ? panelBeforeChat
      ? `${panelTrack} var(--chat-side-panel-resizer-width) ${mainTrack}`
      : `${mainTrack} var(--chat-side-panel-resizer-width) ${panelTrack}`
    : 'minmax(0, 1fr)';
  const mainColumn = panelBeforeChat ? 3 : 1;
  const mainHeaderRow = panelTop ? 4 : 1;
  const mainVisible = !panelOnly;
  const mainWidth = splitColumns
    ? sidePanelMainWidth ?? Math.max(1, containerWidth - sidePanelWidth - CHAT_WORKSPACE_LAYOUT.paneResizerWidth)
    : containerWidth;
  const mainStyle = useMemo<WorkspacePaneStyle>(() => ({
    header: { gridColumn: mainColumn, gridRow: mainHeaderRow, display: mainVisible ? undefined : 'none' },
    body: { gridColumn: mainColumn, gridRow: mainHeaderRow + 1, display: mainVisible ? undefined : 'none' },
    dropTarget: {
      gridColumn: mainColumn,
      gridRow: panelOnly ? 2 : `${mainHeaderRow} / ${mainHeaderRow + 2}`,
      ...(panelOnly ? { width: '50%', justifySelf: 'start' } : {}),
      zIndex: 30,
    },
  }), [mainColumn, mainHeaderRow, mainVisible, panelOnly]);
  const sideStyle = useMemo<WorkspacePaneStyle>(() => {
    const sidePlacement: CSSProperties = {
      gridColumn: splitColumns && !panelBeforeChat ? 3 : 1,
      display: dockedSidePanelMounted || overlaySidePanelMounted ? undefined : 'none',
      visibility: resolvedSidePanelVisible ? undefined : 'hidden',
      pointerEvents: resolvedSidePanelVisible ? undefined : 'none',
      ...(overlaySidePanelMounted ? { justifySelf: 'end', width: sidePanelWidth, maxWidth: 'calc(100% - 1.5rem)', marginRight: 12, zIndex: 20 } : {}),
    };
    return {
      header: { ...sidePlacement, gridRow: 1, ...(overlaySidePanelMounted ? { marginTop: 12 } : {}) },
      body: { ...sidePlacement, gridRow: 2, ...(overlaySidePanelMounted ? { marginBottom: 12, height: 'auto' } : {}) },
      dropTarget: { ...sidePlacement, gridRow: '1 / 3', ...(overlaySidePanelMounted ? { marginTop: 12, marginBottom: 12 } : {}), zIndex: 30 },
    };
  }, [dockedSidePanelMounted, overlaySidePanelMounted, panelBeforeChat, resolvedSidePanelVisible, sidePanelWidth, splitColumns]);
  const workspace = useMemo(() => renderWorkspace({
    visible: resolvedSidePanelVisible,
    width: splitColumns || overlaySidePanelMounted ? sidePanelWidth : containerWidth,
    mainVisible,
    mainWidth,
    mainActions: header,
    mainStyle,
    sideStyle,
  }), [containerWidth, header, mainStyle, mainVisible, mainWidth, overlaySidePanelMounted, renderWorkspace, resolvedSidePanelVisible, sidePanelWidth, sideStyle, splitColumns]);

  return (
    <div
      ref={chatLayoutRef}
      className="relative grid h-full min-h-0 overflow-hidden bg-card"
      data-panel-position={panelLayoutActive ? panelLayout.position : undefined}
      data-panel-fullscreen={panelLayoutActive ? panelLayout.fullscreen : undefined}
      style={{
        gridTemplateColumns,
        gridTemplateRows: panelTop
          ? `auto minmax(0, ${panelHeightPercent}fr) var(--chat-side-panel-resizer-width) auto minmax(0, ${100 - panelHeightPercent}fr)`
          : 'auto minmax(0, 1fr)',
        ['--chat-side-panel-width' as string]: `${sidePanelWidth}px`,
        ['--chat-side-panel-resizer-width' as string]: `${CHAT_WORKSPACE_LAYOUT.paneResizerWidth}px`,
      }}
    >
      <div
        ref={stageRef}
        inert={stageHidden}
        aria-hidden={stageHidden}
        className={cn(CHAT_LAYOUT_TOKENS.stageSurface, 'chat-scroll-sync', panelComposerDocked && 'pointer-events-none z-10 bg-transparent')}
        style={{ ...CHAT_STAGE_CSS_VARS,
          visibility: stageHidden ? 'hidden' : undefined,
          gridColumn: mainColumn,
          gridRow: panelOnly ? '1 / 3' : mainHeaderRow + 1,
        }}
      >
          <div
            data-testid="chat-stage-backdrop"
            hidden={panelOnly}
            className={CHAT_LAYOUT_TOKENS.stageBackdrop}
          />

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {!panelOnly && !isOffline ? threadHeader : null}
            {offline && !panelOnly ? <div className="min-h-0 flex-1 overflow-auto">{offline}</div> : null}
            <div className={panelOnly || isOffline ? 'hidden' : 'contents'} inert={panelOnly || isOffline}>
              {!isEmptyState ? viewportPane : null}

              {!isEmptyState ? <div
                data-testid="chat-stage-bottom-fade"
                className={CHAT_LAYOUT_TOKENS.stageBottomFade}
              /> : null}
            </div>

            <div
              ref={composerOverlayRef}
              inert={isOffline}
              className={isOffline ? 'hidden' : panelComposerDocked
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
        style={{ gridColumn: panelTop ? 1 : 2, gridRow: panelTop ? 3 : '1 / 3' }}
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
          className={cn('pointer-events-none absolute bg-border/60 transition-colors group-hover:bg-primary/60', panelTop ? 'inset-x-0 top-1/2 h-px' : 'inset-y-0 left-1/2 w-px')}
        />
      </div> : null}

      <div className="contents" data-testid={overlaySidePanelMounted ? 'chat-side-panel-overlay' : undefined}>
        {workspace}
      </div>
    </div>
  );
}
