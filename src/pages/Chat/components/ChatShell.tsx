import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject, type WheelEvent } from 'react';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';
import { CHAT_WORKSPACE_LAYOUT } from '../chat-workspace-layout';
import type { ChatSidePanelMode } from '../chat-workspace-layout';

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
  sidePanelOpen: boolean;
  sidePanelMode: ChatSidePanelMode;
  sidePanelWidth: number;
  artifactWorkbenchFullscreen?: boolean;
  onSidePanelResize?: (nextWidth: number) => void;
  onComposerWheel?: (deltaY: number) => void;
  onComposerGeometryChange?: () => void;
  isEmptyState?: boolean;
  emptyState?: ReactNode;
  sidePanel: ReactNode;
  header: ReactNode;
  viewportPane: ReactNode;
  errorBanner: ReactNode;
  approvalDock: ReactNode;
  todoPanel?: ReactNode;
  input: ReactNode;
}

export function ChatShell({
  chatLayoutRef,
  sidePanelOpen,
  sidePanelMode,
  sidePanelWidth,
  artifactWorkbenchFullscreen = false,
  onSidePanelResize,
  onComposerWheel,
  onComposerGeometryChange,
  isEmptyState = false,
  emptyState = null,
  sidePanel,
  header,
  viewportPane,
  errorBanner,
  approvalDock,
  todoPanel = null,
  input,
}: ChatShellProps) {
  const isMac = window.electron?.platform === 'darwin';
  const stageRef = useRef<HTMLDivElement>(null);
  const headerOverlayRef = useRef<HTMLDivElement>(null);
  const composerOverlayRef = useRef<HTMLDivElement>(null);
  const resizePointerIdRef = useRef<number | null>(null);

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

    const syncOverlayOffsets = () => {
      const headerHeight = Math.ceil(headerNode.getBoundingClientRect().height);
      const composerHeight = Math.ceil(composerNode.getBoundingClientRect().height);
      stageNode.style.setProperty('--chat-header-safe-offset', `${headerHeight}px`);
      stageNode.style.setProperty('--chat-thread-top-padding', `${headerHeight + CHAT_THREAD_TOP_GAP_PX}px`);
      stageNode.style.setProperty('--chat-composer-safe-offset', `${composerHeight}px`);
      stageNode.style.setProperty('--chat-thread-bottom-padding', `${composerHeight + CHAT_THREAD_BOTTOM_GAP_PX}px`);
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
  }, [artifactWorkbenchFullscreen, isEmptyState, onComposerGeometryChange]);

  const handleSidePanelResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!onSidePanelResize) {
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
      const nextWidth = rect.right - moveEvent.clientX;
      onSidePanelResize(nextWidth);
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      if (resizePointerIdRef.current !== upEvent.pointerId) {
        return;
      }
      resizePointerIdRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  return (
    <div
      ref={chatLayoutRef}
      className={cn(
        'relative grid h-full min-h-0 overflow-hidden bg-card [grid-template-columns:minmax(0,1fr)]',
        !artifactWorkbenchFullscreen
          && sidePanelOpen
          && sidePanelMode === 'docked'
          && '[grid-template-columns:minmax(0,1fr)_var(--chat-side-panel-resizer-width)_var(--chat-side-panel-width)]',
      )}
      style={{
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
          style={CHAT_STAGE_CSS_VARS}
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
            {todoPanel ? (
              <div className={CHAT_LAYOUT_TOKENS.stageFloatingRail}>
                <div className="pointer-events-auto mt-2 w-full min-w-0">
                  {todoPanel}
                </div>
              </div>
            ) : null}
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {isEmptyState ? (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-3 pb-8 pt-16 md:px-4 md:pb-10 md:pt-20">
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
                      <div className="pointer-events-auto">
                        {approvalDock}
                      </div>
                    ) : null}

                    <div
                      className="pointer-events-auto chat-scroll-sync-input"
                      onWheelCapture={handleComposerWheelCapture}
                    >
                      {input}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {!artifactWorkbenchFullscreen && sidePanelOpen && sidePanelMode === 'docked' ? (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            data-testid="chat-side-panel-resizer"
            className="group relative z-10 w-[var(--chat-side-panel-resizer-width)] cursor-col-resize bg-transparent"
            onPointerDown={handleSidePanelResizeStart}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/60 transition-colors group-hover:bg-primary/60"
            />
          </div>
          {sidePanel}
        </>
      ) : null}

      {!artifactWorkbenchFullscreen && sidePanelOpen && sidePanelMode === 'overlay' ? (
        <div
          data-testid="chat-side-panel-overlay"
          className="pointer-events-none absolute inset-y-3 right-3 z-20 flex max-w-[calc(100%-1.5rem)]"
          style={{ width: `${sidePanelWidth}px` }}
        >
          <div className="pointer-events-auto flex-1 min-w-0">
            {sidePanel}
          </div>
        </div>
      ) : null}
    </div>
  );
}
