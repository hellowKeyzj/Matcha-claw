import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';

interface ChatViewportStageProps {
  header: ReactNode;
  viewportPane: ReactNode;
  errorBanner: ReactNode;
  approvalDock: ReactNode;
  input: ReactNode;
}

export function ChatViewportStage({
  header,
  viewportPane,
  errorBanner,
  approvalDock,
  input,
}: ChatViewportStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const composerOverlayRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const stageNode = stageRef.current;
    const composerNode = composerOverlayRef.current;
    if (!stageNode || !composerNode) {
      return;
    }

    const syncComposerOffset = () => {
      const composerHeight = Math.ceil(composerNode.getBoundingClientRect().height);
      stageNode.style.setProperty('--chat-composer-safe-offset', `${composerHeight}px`);
    };

    syncComposerOffset();

    if (typeof ResizeObserver !== 'function') {
      return () => {
        stageNode.style.removeProperty('--chat-composer-safe-offset');
      };
    }

    const observer = new ResizeObserver(() => {
      syncComposerOffset();
    });
    observer.observe(composerNode);

    return () => {
      observer.disconnect();
      stageNode.style.removeProperty('--chat-composer-safe-offset');
    };
  }, []);

  return (
    <div
      ref={stageRef}
      className={`${CHAT_LAYOUT_TOKENS.stageSurface} chat-scroll-sync`}
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
          {header}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
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
            {errorBanner && (
              <div className="pointer-events-auto">
                {errorBanner}
              </div>
            )}

            {approvalDock && (
              <div className="pointer-events-auto">
                {approvalDock}
              </div>
            )}

            <div className="pointer-events-auto chat-scroll-sync-input">
              {input}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
