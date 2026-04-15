/**
 * Chat State Store
 * Manages chat messages, sessions, streaming, and thinking state.
 * Communicates with OpenClaw Gateway via renderer WebSocket RPC.
 */
import { create } from 'zustand';
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
    messages: [],
    snapshotReady: false,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,

    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: [],
    approvalStatus: 'idle',
    pendingApprovalsBySession: {},

    sessions: [],
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




