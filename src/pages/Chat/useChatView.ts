import type { ChatSessionHistoryStatus } from '@/stores/chat';

interface UseChatViewInput {
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
    currentSessionStatus,
    itemCount,
    runActive,
  } = input;

  const hasRenderableItems = itemCount > 0;
  const showBlockingLoading = !runActive && !hasRenderableItems && (
    currentSessionStatus === 'idle' || currentSessionStatus === 'loading'
  );
  const showBlockingError = !runActive && !hasRenderableItems && currentSessionStatus === 'error';
  const isEmptyState = !showBlockingLoading && !showBlockingError && !runActive && itemCount === 0 && currentSessionStatus === 'ready';

  return {
    showBlockingLoading,
    showBlockingError,
    isEmptyState,
  };
}
