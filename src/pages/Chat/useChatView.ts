import type { ChatSessionHistoryStatus } from '@/stores/chat';

interface UseChatViewInput {
  currentSessionStatus: ChatSessionHistoryStatus;
  itemCount: number;
  sending: boolean;
  refreshing: boolean;
  mutating: boolean;
}

interface UseChatViewResult {
  showBlockingLoading: boolean;
  showBlockingError: boolean;
  showBackgroundStatus: boolean;
  isEmptyState: boolean;
}

export function useChatView(input: UseChatViewInput): UseChatViewResult {
  const {
    currentSessionStatus,
    itemCount,
    sending,
    refreshing,
    mutating,
  } = input;

  const hasRenderableItems = itemCount > 0;
  const showBlockingLoading = !sending && !hasRenderableItems && (
    currentSessionStatus === 'idle' || currentSessionStatus === 'loading'
  );
  const showBlockingError = !sending && !hasRenderableItems && currentSessionStatus === 'error';
  const showBackgroundStatus = !showBlockingLoading && !showBlockingError && (refreshing || mutating);
  const isEmptyState = !showBlockingLoading && !showBlockingError && !sending && itemCount === 0 && currentSessionStatus === 'ready';

  return {
    showBlockingLoading,
    showBlockingError,
    showBackgroundStatus,
    isEmptyState,
  };
}
