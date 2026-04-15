import { useMinDelay } from './useMinDelay';

const NEW_SESSION_KEY_PATTERN = /^agent:[^:]+:session-\d{8,16}$/i;

interface UseChatViewInput {
  currentSessionKey: string;
  currentSessionReady: boolean;
  currentSessionHasActivity: boolean;
  rowCount: number;
  sending: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
}

interface UseChatViewResult {
  showBlockingLoading: boolean;
  showBackgroundStatus: boolean;
  isEmptyState: boolean;
}

export function useChatView(input: UseChatViewInput): UseChatViewResult {
  const {
    currentSessionKey,
    currentSessionReady,
    currentSessionHasActivity,
    rowCount,
    sending,
    initialLoading,
    refreshing,
    mutating,
  } = input;

  const hasRenderableRows = rowCount > 0;
  const waitingForSessionSnapshot = !sending && !hasRenderableRows && !currentSessionReady;
  const isColdInitialLoad = initialLoading && !sending;
  const loadingVisible = useMinDelay(waitingForSessionSnapshot || isColdInitialLoad, isColdInitialLoad ? 450 : 0);
  const likelyFreshSession = (
    waitingForSessionSnapshot
    && !currentSessionHasActivity
    && NEW_SESSION_KEY_PATTERN.test(currentSessionKey)
  );
  const showBlockingLoading = waitingForSessionSnapshot && !likelyFreshSession && loadingVisible;
  const showBackgroundStatus = !showBlockingLoading && (refreshing || mutating);
  const isEmptyState = !showBlockingLoading && !sending && rowCount === 0 && (currentSessionReady || likelyFreshSession);

  return {
    showBlockingLoading,
    showBackgroundStatus,
    isEmptyState,
  };
}

