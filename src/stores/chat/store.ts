/**
 * Chat State Store
 * Manages chat messages, sessions, streaming, and thinking state.
 * Communicates with OpenClaw Gateway via renderer WebSocket RPC.
 */
import { create } from 'zustand';
import { createIdleResourceState } from '@/lib/resource-state';
import { readHistoryLoadPipelineStrategyKeyFromSettings } from './history-pipeline-settings';
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

export const useChatStore = create<ChatStoreState>((set, get) => {
  const runtimeKernel = createChatStoreKernel(set);
  const { beginMutating, finishMutating, historyRuntime } = runtimeKernel;

  return {
    get sessions(): ChatStoreState['sessions'] {
      return Array.isArray(this.sessionsResource?.data) ? this.sessionsResource.data : [];
    },
    messages: [],
    snapshotReady: false,
    initialLoading: false,
    refreshing: false,
    sessionsResource: createIdleResourceState([]),
    mutating: false,
    error: null,

    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    streamingMessage: null,
    streamRuntime: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: [],
    approvalStatus: 'idle',
    pendingApprovalsBySession: {},
    currentSessionKey: DEFAULT_SESSION_KEY,
    sessionLabels: {},
    sessionLastActivity: {},
    sessionReadyByKey: {},
    sessionRuntimeByKey: {},

    showThinking: true,
    thinkingLevel: null,

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
      readPipelineStrategyKey: readHistoryLoadPipelineStrategyKeyFromSettings,
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

function normalizeChatStatePatch<T extends Partial<ChatStoreState> | ChatStoreState>(patch: T): T {
  if (!patch || typeof patch !== 'object' || !('sessions' in patch)) {
    return patch;
  }
  const next = { ...patch } as Partial<ChatStoreState> & { sessions?: ChatStoreState['sessions'] };
  const nextSessions = Array.isArray(next.sessions) ? next.sessions : [];
  delete next.sessions;
  next.sessionsResource = {
    ...(next.sessionsResource ?? useChatStore.getState().sessionsResource),
    data: nextSessions,
  };
  return next as T;
}

const rawChatSetState = useChatStore.setState;
useChatStore.setState = ((partial, replace) => {
  if (typeof partial === 'function') {
    if (replace === true) {
      return rawChatSetState(
        (state) => normalizeChatStatePatch(partial(state)) as ChatStoreState,
        true,
      );
    }
    return rawChatSetState(
      (state) => normalizeChatStatePatch(partial(state)) as Partial<ChatStoreState>,
      false,
    );
  }
  if (replace === true) {
    return rawChatSetState(normalizeChatStatePatch(partial) as ChatStoreState, true);
  }
  return rawChatSetState(normalizeChatStatePatch(partial) as Partial<ChatStoreState>, false);
}) as typeof useChatStore.setState;

const rawChatGetState = useChatStore.getState;
useChatStore.getState = (() => {
  const state = rawChatGetState();
  return {
    ...state,
    sessions: Array.isArray(state.sessionsResource.data) ? state.sessionsResource.data : [],
  };
}) as typeof useChatStore.getState;
