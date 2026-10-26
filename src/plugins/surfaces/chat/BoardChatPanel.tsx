import { lazy, Suspense, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatPanelLayout, ChatPanelProps } from '@/plugins/chat/extensions';
import type { BoardChatDock, BoardIdentity } from '@/types/board';

const BoardPanel = lazy(() => import('../board/BoardPanel').then((module) => ({ default: module.BoardPanel })));
const PANEL_POSITION: Record<BoardChatDock, ChatPanelLayout['position']> = {
  left: 'right', right: 'left', bottom: 'top', hidden: 'full',
};

export function BoardChatPanel({ sessionIdentity, onLayoutChange, onSendMessage, onOpenLink }: ChatPanelProps) {
  const { t } = useTranslation('chat');
  const boardIdentity: BoardIdentity | null = sessionIdentity?.endpoint.kind === 'native-runtime'
    && sessionIdentity.endpoint.runtimeAdapterId === 'openclaw'
    ? { ...sessionIdentity, endpoint: sessionIdentity.endpoint } : null;
  const onChatDockChange = useCallback((dock: BoardChatDock) => onLayoutChange({ position: PANEL_POSITION[dock] }), [onLayoutChange]);
  const onFullscreenChange = useCallback((fullscreen: boolean) => onLayoutChange({ fullscreen }), [onLayoutChange]);
  return boardIdentity ? (
    <Suspense fallback={<p role="status" className="p-6 text-sm text-muted-foreground">{t('board.loading', { defaultValue: 'Loading native board…' })}</p>}>
      <BoardPanel identity={boardIdentity} onChatDockChange={onChatDockChange} onFullscreenChange={onFullscreenChange} onSendMessage={onSendMessage} onOpenLink={onOpenLink} />
    </Suspense>
  ) : <p role="status" className="p-6 text-sm text-muted-foreground">{sessionIdentity
    ? t('board.failure.unsupported', { defaultValue: 'This runtime does not support Board.' })
    : t('board.requiresSession', { defaultValue: 'Send a message to create a session before opening Board.' })}</p>;
}
