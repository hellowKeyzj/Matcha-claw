import { reduceRuntimeOverlay } from './overlay-reducer';
import type { ChatStoreState } from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface CreateStoreUiActionsInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
}

type StoreUiActions = Pick<ChatStoreState, 'toggleThinking' | 'refresh' | 'clearError'>;

export function createStoreUiActions(input: CreateStoreUiActionsInput): StoreUiActions {
  const { set, get } = input;

  return {
    toggleThinking: () => set((state) => ({ showThinking: !state.showThinking })),

    refresh: async () => {
      const { loadHistory, loadSessions, currentSessionKey } = get();
      await Promise.all([
        loadHistory({
          sessionKey: currentSessionKey,
          mode: 'active',
          scope: 'foreground',
          reason: 'manual_refresh',
        }),
        loadSessions(),
      ]);
    },

    clearError: () => set((state) => reduceRuntimeOverlay(state, { type: 'clear_error' })),
  };
}
