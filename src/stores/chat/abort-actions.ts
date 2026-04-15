import { executeStoreAbortRun } from './abort-handlers';
import { finishChatRunTelemetry } from './telemetry';
import type { ChatStoreState } from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface CreateStoreAbortActionsInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  beginMutating: () => void;
  finishMutating: () => void;
}

type StoreAbortActions = Pick<ChatStoreState, 'abortRun'>;

export function createStoreAbortActions(input: CreateStoreAbortActionsInput): StoreAbortActions {
  const { set, get, beginMutating, finishMutating } = input;

  return {
    abortRun: async () => {
      await executeStoreAbortRun({
        set,
        get,
        onBeginMutating: beginMutating,
        onFinishMutating: finishMutating,
        onAbortedTelemetry: (sessionKey) => {
          finishChatRunTelemetry(sessionKey, 'aborted', { stage: 'abort_action' });
        },
      });
    },
  };
}


