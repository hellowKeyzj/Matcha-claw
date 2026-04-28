import type { ComponentProps, ReactNode } from 'react';
import { ChatInput } from '../ChatInput';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';
import { ChatHeaderBar } from './ChatHeaderBar';
import { ChatApprovalDock, ChatErrorBanner } from './ChatRuntimeDock';

interface ChatViewportStageProps {
  headerProps: ComponentProps<typeof ChatHeaderBar>;
  viewportPane: ReactNode;
  errorBannerProps: ComponentProps<typeof ChatErrorBanner> | null;
  approvalDockProps: ComponentProps<typeof ChatApprovalDock> | null;
  inputProps: ComponentProps<typeof ChatInput>;
}

export function ChatViewportStage({
  headerProps,
  viewportPane,
  errorBannerProps,
  approvalDockProps,
  inputProps,
}: ChatViewportStageProps) {
  return (
    <div className={CHAT_LAYOUT_TOKENS.stageSurface}>
      <div
        data-testid="chat-stage-backdrop"
        className={CHAT_LAYOUT_TOKENS.stageBackdrop}
      />

      <div
        data-testid="chat-stage-header-overlay"
        className={CHAT_LAYOUT_TOKENS.stageHeaderOverlay}
      >
        <div className={CHAT_LAYOUT_TOKENS.stageHeaderRail}>
          <ChatHeaderBar {...headerProps} />
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {viewportPane}

        <div className={CHAT_LAYOUT_TOKENS.composerOverlay}>
          <div className={CHAT_LAYOUT_TOKENS.composerOverlayStack}>
            {errorBannerProps && (
              <div className="pointer-events-auto">
                <ChatErrorBanner {...errorBannerProps} />
              </div>
            )}

            {approvalDockProps && (
              <div className="pointer-events-auto">
                <ChatApprovalDock {...approvalDockProps} />
              </div>
            )}

            <div className="pointer-events-auto">
              <ChatInput {...inputProps} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
