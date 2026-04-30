import type { ChatSessionHistoryStatus } from '@/stores/chat';

interface UseChatViewInput {
  currentSessionStatus: ChatSessionHistoryStatus;
  rowCount: number;
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
    rowCount,
    sending,
    refreshing,
    mutating,
  } = input;

  const hasRenderableRows = rowCount > 0;
  const showBlockingLoading = !sending && !hasRenderableRows && (
    currentSessionStatus === 'idle' || currentSessionStatus === 'loading'
  );
  const showBlockingError = !sending && !hasRenderableRows && currentSessionStatus === 'error';
  const showBackgroundStatus = !showBlockingLoading && !showBlockingError && (refreshing || mutating);
  const isEmptyState = !showBlockingLoading && !showBlockingError && !sending && rowCount === 0 && currentSessionStatus === 'ready';

  return {
    showBlockingLoading,
    showBlockingError,
    showBackgroundStatus,
    isEmptyState,
  };
}
