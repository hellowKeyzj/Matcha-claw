import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';
import type { ChatSidePanelMode } from '../chat-workspace-layout';

const CHAT_THREAD_BOTTOM_GAP_PX = 12;

const CHAT_STAGE_CSS_VARS = {
  '--chat-composer-safe-offset': '0px',
  '--chat-thread-bottom-padding': `${CHAT_THREAD_BOTTOM_GAP_PX}px`,
} as CSSProperties;

interface ChatShellProps {
  chatLayoutRef: RefObject<HTMLDivElement | null>;
  sidePanelOpen: boolean;
  sidePanelMode: ChatSidePanelMode;
  sidePanelWidth: number;
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
  sidePanelOpen,
  sidePanelMode,
  sidePanelWidth,
  isEmptyState = false,
  emptyState = null,
  sidePanel,
  header,
  viewportPane,
  errorBanner,
  approvalDock,
  input,
}: ChatShellProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const composerOverlayRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const stageNode = stageRef.current;
    if (!stageNode) {
      return;
    }

    const resetComposerOffset = () => {
      stageNode.style.setProperty('--chat-composer-safe-offset', '0px');
      stageNode.style.setProperty('--chat-thread-bottom-padding', `${CHAT_THREAD_BOTTOM_GAP_PX}px`);
    };

    const composerNode = composerOverlayRef.current;
    if (!composerNode) {
      resetComposerOffset();
      return;
    }

    const syncComposerOffset = () => {
      const composerHeight = Math.ceil(composerNode.getBoundingClientRect().height);
      stageNode.style.setProperty('--chat-composer-safe-offset', `${composerHeight}px`);
      stageNode.style.setProperty('--chat-thread-bottom-padding', `${composerHeight + CHAT_THREAD_BOTTOM_GAP_PX}px`);
    };

    syncComposerOffset();

    if (typeof ResizeObserver !== 'function') {
      return resetComposerOffset;
    }

    const observer = new ResizeObserver(() => {
      syncComposerOffset();
    });
    observer.observe(composerNode);

    return () => {
      observer.disconnect();
      resetComposerOffset();
    };
  }, [isEmptyState]);

  return (
    <div
      ref={chatLayoutRef}
      className={cn(
        'relative grid h-full min-h-0 overflow-hidden bg-[linear-gradient(180deg,rgba(248,250,252,0.7),rgba(244,245,247,0.42))] [grid-template-columns:minmax(0,1fr)] dark:bg-[linear-gradient(180deg,rgba(24,24,27,0.42),rgba(18,18,20,0.24))]',
        sidePanelOpen && sidePanelMode === 'docked' && '[grid-template-columns:minmax(0,1fr)_var(--chat-side-panel-width)]',
      )}
      style={{
        ['--chat-side-panel-width' as string]: `${sidePanelWidth}px`,
      }}
    >
      <div
        ref={stageRef}
        className={`${CHAT_LAYOUT_TOKENS.stageSurface} chat-scroll-sync`}
        style={CHAT_STAGE_CSS_VARS}
      >
        <div
          data-testid="chat-stage-backdrop"
          className={CHAT_LAYOUT_TOKENS.stageBackdrop}
        />

        <div
          data-testid="chat-stage-header-overlay"
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

                  <div className="pointer-events-auto chat-scroll-sync-input">
                    {input}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {sidePanelOpen && sidePanelMode === 'docked' ? (
        sidePanel
      ) : null}

      {sidePanelOpen && sidePanelMode === 'overlay' ? (
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
