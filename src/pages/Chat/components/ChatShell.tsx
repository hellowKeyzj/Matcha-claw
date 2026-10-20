import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject, type WheelEvent } from 'react';
import type { BoardChatDock } from '@/types/board';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';
import { CHAT_WORKSPACE_LAYOUT } from '@/components/layout/chat-workspace-layout';
import type { ChatSidePanelMode, ChatWindowDockPhase } from '@/components/layout/chat-workspace-layout';

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
  boardChatDock?: BoardChatDock;
  boardFullscreen?: boolean;
  onSidePanelResize?: (nextWidth: number) => void;
  onSidePanelResizeCommit?: (nextWidth: number) => void;
  onComposerWheel?: (deltaY: number) => void;
  onComposerGeometryChange?: () => void;
  isEmptyState?: boolean;
  emptyState?: ReactNode;
  sidePanel: ReactNode;
  header: ReactNode;
  viewportPane: ReactNode;
  errorBanner: ReactNode;
  approvalDock: ReactNode;
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
  boardChatDock,
  boardFullscreen = false,
  onSidePanelResize,
  onSidePanelResizeCommit,
  onComposerWheel,
  onComposerGeometryChange,
  isEmptyState = false,
  emptyState = null,
  sidePanel,
  header,
  viewportPane,
  errorBanner,
  approvalDock,
  input,
}: ChatShellProps) {
  const isMac = window.electron?.platform === 'darwin';
  const stageRef = useRef<HTMLDivElement>(null);
  const headerOverlayRef = useRef<HTMLDivElement>(null);
  const composerOverlayRef = useRef<HTMLDivElement>(null);
  const resizePointerIdRef = useRef<number | null>(null);
  const lastSidePanelResizeWidthRef = useRef(sidePanelWidth);
  const [boardHeightPercent, setBoardHeightPercent] = useState(60);
  const boardActive = boardChatDock !== undefined
    && !artifactWorkbenchFullscreen
    && sidePanelMode === 'docked'
    && sidePanelPhase !== 'closed';
  const boardOnly = boardActive && (boardFullscreen || boardChatDock === 'hidden');
  const boardBottom = boardActive && !boardOnly && boardChatDock === 'bottom';
  const boardBeforeChat = boardActive && !boardOnly && boardChatDock === 'right';

  useLayoutEffect(() => {
    lastSidePanelResizeWidthRef.current = sidePanelWidth;
  }, [sidePanelWidth]);

  const shouldLetNestedScrollableConsumeWheel = (event: WheelEvent<HTMLElement>): boolean => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    const scrollable = target.closest<HTMLElement>(
      'textarea, [data-radix-scroll-area-viewport], [data-tool-output-scroll="true"], [data-chat-composer-wheel-local="true"]',
    );
    if (!scrollable) {
      return false;
    }
    const canScroll = scrollable.scrollHeight > scrollable.clientHeight;
    if (!canScroll) {
      return false;
    }
    if (event.deltaY > 0) {
      return scrollable.scrollTop + scrollable.clientHeight < scrollable.scrollHeight - 1;
    }
    if (event.deltaY < 0) {
      return scrollable.scrollTop > 0;
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
    if (!headerNode || !composerNode) {
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
  }, [artifactWorkbenchFullscreen, boardOnly, isEmptyState, onComposerGeometryChange]);

  const handleSidePanelResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!boardBottom && !onSidePanelResize) {
      return;
    }
    event.preventDefault();
    resizePointerIdRef.current = event.pointerId;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const layoutNode = chatLayoutRef.current;
      if (!layoutNode) {
        return;
      }
      const rect = layoutNode.getBoundingClientRect();
      if (boardBottom) {
        setBoardHeightPercent(Math.max(25, Math.min(75, (moveEvent.clientY - rect.top) / Math.max(1, rect.height) * 100)));
        return;
      }
      const nextWidth = boardBeforeChat ? moveEvent.clientX - rect.left : rect.right - moveEvent.clientX;
      lastSidePanelResizeWidthRef.current = nextWidth;
      onSidePanelResize?.(nextWidth);
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      if (resizePointerIdRef.current !== upEvent.pointerId) {
        return;
      }
      resizePointerIdRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      if (!boardBottom) onSidePanelResizeCommit?.(lastSidePanelResizeWidthRef.current);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = boardBottom ? 'row-resize' : 'col-resize';
  };

  const resolvedSidePanelVisible = sidePanelVisible ?? sidePanelPhase === 'open';
  const dockedSidePanelMounted = !artifactWorkbenchFullscreen
    && sidePanelMode === 'docked'
    && (sidePanelPhase === 'opening' || sidePanelPhase === 'open' || sidePanelPhase === 'closing');
  const overlaySidePanelMounted = !artifactWorkbenchFullscreen
    && sidePanelMode === 'overlay'
    && sidePanelPhase === 'open';
  const mainTrack = sidePanelMainWidth != null ? `${sidePanelMainWidth}px` : 'minmax(0, 1fr)';
  const panelTrack = sidePanelMainWidth != null ? 'minmax(0, 1fr)' : 'var(--chat-side-panel-width)';
  const gridTemplateColumns = dockedSidePanelMounted && !boardOnly && !boardBottom
    ? boardBeforeChat
      ? `${panelTrack} var(--chat-side-panel-resizer-width) ${mainTrack}`
      : `${mainTrack} var(--chat-side-panel-resizer-width) ${panelTrack}`
    : 'minmax(0, 1fr)';

  return (
    <div
      ref={chatLayoutRef}
      className="relative grid h-full min-h-0 overflow-hidden bg-card"
      data-board-chat-dock={boardActive ? boardChatDock : undefined}
      data-board-fullscreen={boardActive ? boardFullscreen : undefined}
      style={{
        gridTemplateColumns,
        gridTemplateRows: boardBottom ? `minmax(0, ${boardHeightPercent}fr) var(--chat-side-panel-resizer-width) minmax(0, ${100 - boardHeightPercent}fr)` : undefined,
        ['--chat-side-panel-width' as string]: `${sidePanelWidth}px`,
        ['--chat-side-panel-resizer-width' as string]: `${CHAT_WORKSPACE_LAYOUT.paneResizerWidth}px`,
      }}
    >
      {artifactWorkbenchFullscreen ? (
        <div
          data-testid="chat-artifact-workbench-fullscreen"
          className="min-h-0 min-w-0 overflow-hidden"
        >
          {sidePanel}
        </div>
      ) : (
        <div
          ref={stageRef}
          className={`${CHAT_LAYOUT_TOKENS.stageSurface} chat-scroll-sync`}
          style={{ ...CHAT_STAGE_CSS_VARS, ...(boardActive ? {
            display: boardOnly ? 'none' : undefined,
            gridColumn: boardBottom ? 1 : boardBeforeChat ? 3 : 1,
            gridRow: boardBottom ? 3 : 1,
          } : {}) }}
        >
          {isMac ? (
            <div
              data-testid="mac-chat-drag-region"
              aria-hidden="true"
              className="drag-region pointer-events-auto absolute inset-x-0 top-0 z-[15] h-7"
            />
          ) : null}

          <div
            data-testid="chat-stage-backdrop"
            className={CHAT_LAYOUT_TOKENS.stageBackdrop}
          />

          <div
            data-testid="chat-stage-header-overlay"
            ref={headerOverlayRef}
            className={CHAT_LAYOUT_TOKENS.stageHeaderOverlay}
          >
            <div className={CHAT_LAYOUT_TOKENS.stageHeaderRail}>
              <div className="pointer-events-auto">
                {header}
              </div>
            </div>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {isEmptyState ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-12 pt-20 sm:px-8 md:pb-20">
                {emptyState}
              </div>
            ) : (
              <>
                {viewportPane}

                <div
                  data-testid="chat-stage-bottom-fade"
                  className={CHAT_LAYOUT_TOKENS.stageBottomFade}
                />

                <div
                  ref={composerOverlayRef}
                  className={CHAT_LAYOUT_TOKENS.composerOverlay}
                >
                  <div className={CHAT_LAYOUT_TOKENS.composerOverlayStack}>
                    {errorBanner ? (
                      <div className="pointer-events-auto">
                        {errorBanner}
                      </div>
                    ) : null}

                    {approvalDock ? (
                      <div className="pointer-events-auto min-w-0">
                        {approvalDock}
                      </div>
                    ) : null}

                    <div className="relative">
                      <div
                        className="pointer-events-auto chat-scroll-sync-input"
                        onWheelCapture={handleComposerWheelCapture}
                      >
                        {input}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {dockedSidePanelMounted ? (
        <>
          {!boardOnly ? <div
            role="separator"
            aria-orientation={boardBottom ? 'horizontal' : 'vertical'}
            style={boardActive ? { gridColumn: boardBottom ? 1 : 2, gridRow: boardBottom ? 2 : 1 } : undefined}
            data-testid="chat-side-panel-resizer"
            className={cn(
              'group relative z-10 bg-transparent',
              boardBottom ? 'h-[var(--chat-side-panel-resizer-width)] cursor-row-resize' : 'w-[var(--chat-side-panel-resizer-width)]',
              !boardBottom && (sidePanelPhase === 'open' ? 'cursor-col-resize' : 'cursor-default'),
            )}
            onPointerDown={sidePanelPhase === 'open' ? handleSidePanelResizeStart : undefined}
          >
            <span
              aria-hidden
              className={cn('pointer-events-none absolute bg-border/60 transition-colors group-hover:bg-primary/60', boardBottom ? 'inset-x-0 top-1/2 h-px -translate-y-1/2' : 'inset-y-0 left-1/2 w-px -translate-x-1/2')}
            />
          </div> : null}
          <div style={boardActive ? { gridColumn: boardOnly || boardBottom || boardBeforeChat ? 1 : 3, gridRow: 1 } : undefined} className={cn('min-h-0 min-w-0 overflow-hidden bg-card', !resolvedSidePanelVisible && 'invisible pointer-events-none')}>
            {resolvedSidePanelVisible ? sidePanel : null}
          </div>
        </>
      ) : null}

      {overlaySidePanelMounted ? (
        <div
          data-testid="chat-side-panel-overlay"
          className={cn(
            'pointer-events-none absolute inset-y-3 right-3 z-20 flex max-w-[calc(100%-1.5rem)]',
            !resolvedSidePanelVisible && 'invisible',
          )}
          style={{ width: `${sidePanelWidth}px` }}
        >
          <div className="pointer-events-auto flex-1 min-w-0">
            {resolvedSidePanelVisible ? sidePanel : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
