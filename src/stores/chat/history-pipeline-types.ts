import type { StoreHistoryCache } from './history-cache';
import type { ChatStoreState, RawMessage } from './types';
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
  quiet: boolean;
  requestedSessionKey: string;
  abortSignal: AbortSignal;
  isAborted: () => boolean;
  fetchHistoryWindow: (limit: number) => Promise<HistoryWindowResult>;
  applyLoadedMessages: (rawMessages: RawMessage[], thinkingLevel: string | null) => Promise<void>;
}

export type HistoryLoadPipelineStrategy = (context: HistoryLoadPipelineContext) => Promise<void>;

