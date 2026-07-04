import type { ChatSessionHistoryStatus } from '@/stores/chat';

interface UseChatViewInput {
  currentSessionKey: string;
  currentSessionStatus: ChatSessionHistoryStatus;
  itemCount: number;
  runActive: boolean;
}

export interface UseChatViewResult {
  showBlockingLoading: boolean;
  showBlockingError: boolean;
  isEmptyState: boolean;
}

export function useChatView(input: UseChatViewInput): UseChatViewResult {
  const {
    currentSessionKey,
    currentSessionStatus,
    itemCount,
    runActive,
  } = input;

  const hasSelectedSession = currentSessionKey.trim().length > 0;
  const hasRenderableItems = itemCount > 0;
  const showBlockingLoading = hasSelectedSession && !runActive && !hasRenderableItems && (
    currentSessionStatus === 'idle' || currentSessionStatus === 'loading'
  );
  const showBlockingError = hasSelectedSession && !runActive && !hasRenderableItems && currentSessionStatus === 'error';
  const isEmptyState = !showBlockingLoading && !showBlockingError && !runActive && itemCount === 0 && (!hasSelectedSession || currentSessionStatus === 'ready');

  return {
    showBlockingLoading,
    showBlockingError,
    isEmptyState,
  };
}
