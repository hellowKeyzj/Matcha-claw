import type { ChatSessionHistoryStatus } from '@/stores/chat';

interface UseChatViewInput {
  currentSessionStatus: ChatSessionHistoryStatus;
  itemCount: number;
  sending: boolean;
}

export interface UseChatViewResult {
  showBlockingLoading: boolean;
  showBlockingError: boolean;
  isEmptyState: boolean;
}

export function useChatView(input: UseChatViewInput): UseChatViewResult {
  const {
    currentSessionStatus,
    itemCount,
    sending,
  } = input;

  const hasRenderableItems = itemCount > 0;
  const showBlockingLoading = !sending && !hasRenderableItems && (
    currentSessionStatus === 'idle' || currentSessionStatus === 'loading'
  );
  const showBlockingError = !sending && !hasRenderableItems && currentSessionStatus === 'error';
  const isEmptyState = !showBlockingLoading && !showBlockingError && !sending && itemCount === 0 && currentSessionStatus === 'ready';

  return {
    showBlockingLoading,
    showBlockingError,
    isEmptyState,
  };
}
