/**
 * Chat State Store
 * Manages chat messages, sessions, streaming, and thinking state.
 * Communicates with OpenClaw Gateway via renderer WebSocket RPC.
 */
import { create } from 'zustand';
import { createIdleResourceStatusState } from '@/lib/resource-state';
import {
  createStoreApprovalActions,
} from './approval-actions';
import { createStoreAbortActions } from './abort-actions';
import { createStoreEventActions } from './event-actions';
import {
  createStoreHistoryActions,
} from './history-store-actions';
import { createStoreSendActions } from './send-actions';
import { createStoreSessionActions } from './session-actions';
import { createChatStoreKernel } from './store-kernel';
import { createStoreTaskInboxActions } from './task-inbox-actions';
import { createStoreUiActions } from './ui-actions';
import {
  DEFAULT_CANONICAL_PREFIX,
  DEFAULT_SESSION_KEY,
  type ChatStoreState,
} from './types';
import { createEmptySessionRecord } from './store-state-helpers';

export const useChatStore = create<ChatStoreState>((set, get) => {
  const runtimeKernel = createChatStoreKernel(set);
  const { beginMutating, finishMutating, historyRuntime } = runtimeKernel;

  return {
    currentSessionKey: DEFAULT_SESSION_KEY,
    loadedSessions: {
      [DEFAULT_SESSION_KEY]: createEmptySessionRecord(),
    },
    pendingApprovalsBySession: {},
    foregroundHistorySessionKey: null,
    sessionCatalogStatus: createIdleResourceStatusState(),
    mutating: false,
    error: null,
    showThinking: true,

    ...createStoreSessionActions({
      set,
      get,
      beginMutating,
      finishMutating,
      defaultCanonicalPrefix: DEFAULT_CANONICAL_PREFIX,
      defaultSessionKey: DEFAULT_SESSION_KEY,
      historyRuntime,
    }),

    ...createStoreHistoryActions({
      set,
      get,
      historyRuntime,
    }),

    ...createStoreApprovalActions({
      set,
      get,
      beginMutating,
      finishMutating,
    }),

    ...createStoreSendActions({
      set,
      get,
      beginMutating,
      finishMutating,
    }),

    ...createStoreAbortActions({
      set,
      get,
      beginMutating,
      finishMutating,
    }),

    ...createStoreEventActions({ set, get }),
    ...createStoreTaskInboxActions({ get, defaultSessionKey: DEFAULT_SESSION_KEY }),
    ...createStoreUiActions({ set, get }),
  };
});


