import type { StoreHistoryCache } from './history-cache';
import type {
  ChatHistoryLoadMode,
  ChatHistoryLoadScope,
  ChatStoreState,
  RawMessage,
} from './types';
import type { HistoryWindowResult } from './history-fetch-helpers';

export type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export type ChatStoreGetFn = () => ChatStoreState;

export interface HistoryLoadPipelineContext {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  historyRuntime: StoreHistoryCache;
  mode: ChatHistoryLoadMode;
  scope: ChatHistoryLoadScope;
  requestedSessionKey: string;
  abortSignal: AbortSignal;
  isAborted: () => boolean;
  fetchHistoryWindow: (limit: number) => Promise<HistoryWindowResult>;
  applyLoadedMessages: (rawMessages: RawMessage[], thinkingLevel: string | null) => Promise<void>;
}

export type HistoryLoadPipelineStrategy = (context: HistoryLoadPipelineContext) => Promise<void>;
