import { DEFAULT_SESSION_KEY, type ChatState } from './types';
import { createRuntimeActions } from './runtime-actions';
import { createSessionHistoryActions } from './session-history-actions';
import type { ChatGet, ChatSet } from './store-api';

export const initialSnapshotLayerState: Pick<
  ChatState,
  | 'messages'
  | 'sessions'
  | 'currentSessionKey'
  | 'sessionLabels'
  | 'sessionLastActivity'
> = {
  messages: [],
  sessions: [],
  currentSessionKey: DEFAULT_SESSION_KEY,
  sessionLabels: {},
  sessionLastActivity: {},
};

export const initialRuntimeLayerState: Pick<
  ChatState,
  | 'sending'
  | 'activeRunId'
  | 'streamingText'
  | 'streamingMessage'
  | 'streamingTools'
  | 'pendingFinal'
  | 'lastUserMessageAt'
  | 'pendingToolImages'
> = {
  sending: false,
  activeRunId: null,
  streamingText: '',
  streamingMessage: null,
  streamingTools: [],
  pendingFinal: false,
  lastUserMessageAt: null,
  pendingToolImages: [],
};

export const initialViewLayerState: Pick<
  ChatState,
  | 'loading'
  | 'error'
  | 'showThinking'
  | 'thinkingLevel'
> = {
  loading: false,
  error: null,
  showThinking: true,
  thinkingLevel: null,
};

export const initialChatState: Pick<
  ChatState,
  | 'messages'
  | 'loading'
  | 'error'
  | 'sending'
  | 'activeRunId'
  | 'streamingText'
  | 'streamingMessage'
  | 'streamingTools'
  | 'pendingFinal'
  | 'lastUserMessageAt'
  | 'pendingToolImages'
  | 'sessions'
  | 'currentSessionKey'
  | 'sessionLabels'
  | 'sessionLastActivity'
  | 'showThinking'
  | 'thinkingLevel'
> = {
  ...initialSnapshotLayerState,
  ...initialRuntimeLayerState,
  ...initialViewLayerState,
};

export function createChatActions(
  set: ChatSet,
  get: ChatGet,
): Pick<
  ChatState,
  | 'loadSessions'
  | 'openAgentConversation'
  | 'switchSession'
  | 'newSession'
  | 'deleteSession'
  | 'cleanupEmptySession'
  | 'loadHistory'
  | 'sendMessage'
  | 'abortRun'
  | 'handleChatEvent'
  | 'toggleThinking'
  | 'refresh'
  | 'clearError'
> {
  return {
    ...createSessionHistoryActions(set, get),
    ...createRuntimeActions(set, get),
  };
}
