import { buildTaskInboxBridgeState } from './session-helpers';
import { normalizeTaskInboxSessionKey } from './session-helpers';
import type { ChatStoreState } from './types';

interface CreateStoreTaskInboxActionsInput {
  get: () => ChatStoreState;
  defaultSessionKey: string;
}

type StoreTaskInboxActions = Pick<
  ChatStoreState,
  'getTaskInboxBridgeState' | 'openTaskInboxSession' | 'sendTaskInboxRecoveryPrompt'
>;

export function createStoreTaskInboxActions(
  input: CreateStoreTaskInboxActionsInput,
): StoreTaskInboxActions {
  const { get, defaultSessionKey } = input;

  return {
    getTaskInboxBridgeState: () => buildTaskInboxBridgeState(get(), defaultSessionKey),

    openTaskInboxSession: (sessionKey: string) => {
      const { currentSessionKey, switchSession } = get();
      const targetSessionKey = normalizeTaskInboxSessionKey(sessionKey, currentSessionKey || defaultSessionKey);
      if (targetSessionKey !== currentSessionKey) {
        switchSession(targetSessionKey);
      }
      return targetSessionKey;
    },

    sendTaskInboxRecoveryPrompt: async (sessionKey: string, prompt: string) => {
      const text = typeof prompt === 'string' ? prompt.trim() : '';
      if (!text) {
        return false;
      }
      const state = get();
      const targetSessionKey = normalizeTaskInboxSessionKey(sessionKey, state.currentSessionKey || defaultSessionKey);
      const bridge = buildTaskInboxBridgeState(state, defaultSessionKey);
      if (bridge.sessionKey !== targetSessionKey) {
        return false;
      }
      if (!bridge.canSendRecoveryPrompt) {
        return false;
      }
      await state.sendMessage(text);
      return true;
    },
  };
}
